import { showToast, Toast } from "@raycast/api";
import { isWritable, listCalendars, listEvents, MorgenCalendar, MorgenEvent } from "./api";

export type EventWithCalendar = MorgenEvent & {
  /** Name of the calendar this row's copy of the event came from. */
  calendarName: string;
  /** How many *further* calendars hold this same event. */
  duplicateCount: number;
};

export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  const dateStr = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${dateStr} ${timeStr}`;
}

export function computeDuration(start: string, end?: string): string {
  if (!end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

export function getConferenceUrl(event: MorgenEvent): string | undefined {
  return event["morgen.so:derived"]?.virtualRoom?.url ?? event["google.com:hangoutLink"];
}

export function getLocation(event: MorgenEvent): string | undefined {
  if (!event.locations) return undefined;
  const first = Object.values(event.locations)[0];
  return first?.name || undefined;
}

/** ISO 8601 duration ("PT1H30M", "PT24H") as whole minutes. */
function parseIsoDuration(iso?: string): number | undefined {
  if (!iso) return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0) + Math.round(Number(seconds ?? 0) / 60)
  );
}

/** Milliseconds a zone is ahead of UTC at a given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    parts[type] = value;
  }
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl can emit hour 24 for midnight in some locales.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return wallClockAsUtc - instant;
}

/**
 * Resolves an event's wall-clock `start` to epoch milliseconds.
 *
 * Morgen returns local wall-clock times alongside a separate `timeZone`, so two
 * copies of one meeting held in different zones carry *different* `start`
 * strings for the same instant — 16:00 UTC and 11:00 America/Chicago are the
 * same moment. Comparing the raw strings can never match them.
 *
 * Returns undefined for all-day events, which carry no zone.
 */
function startInstant(event: MorgenEvent): number | undefined {
  if (!event.timeZone) return undefined;
  const asIfUtc = Date.parse(`${event.start}Z`);
  if (Number.isNaN(asIfUtc)) return undefined;
  // Two passes: the first offset is looked up at the wrong instant, which only
  // matters within an hour of a DST transition. The second corrects it.
  const approximate = asIfUtc - zoneOffsetMs(asIfUtc, event.timeZone);
  return asIfUtc - zoneOffsetMs(approximate, event.timeZone);
}

/**
 * Identifies copies of one meeting held in several calendars.
 *
 * Deliberately does *not* use `uid`. Although the API documents it as the
 * provider's iCalendar UID, in practice each calendar's copy of a meeting
 * carries its own distinct uid — copies are separate provider-side records
 * rather than one shared invitation — so it cannot identify duplicates.
 *
 * Matching therefore rests on what the copies do agree upon: title, absolute
 * start instant, and duration. Recurring instances differ in their start and so
 * remain separate rows.
 *
 * Known limitation: two genuinely distinct events sharing a title, instant and
 * duration are indistinguishable and will be merged. Copies whose titles differ
 * between providers will not be merged.
 */
function mergeKey(event: MorgenEvent): string {
  const title = (event.title ?? "").trim().toLowerCase();
  const duration = parseIsoDuration(event.duration) ?? "";
  const instant = startInstant(event);
  // All-day events have no zone, so compare them by calendar date alone.
  const when = instant === undefined ? `date:${event.start.slice(0, 10)}` : `at:${instant}`;
  return `${title}|${when}|${duration}`;
}

function mergeDuplicates(events: MorgenEvent[], calendarMap: Map<string, MorgenCalendar>): EventWithCalendar[] {
  const groups = new Map<string, MorgenEvent[]>();
  for (const event of events) {
    const key = mergeKey(event);
    const existing = groups.get(key) ?? [];
    existing.push(event);
    groups.set(key, existing);
  }

  const merged: EventWithCalendar[] = [];
  for (const group of groups.values()) {
    // Prefer a writable calendar as the primary, so actions act on a copy the
    // user can actually modify.
    const primary =
      group.find((evt) => {
        const cal = calendarMap.get(evt.calendarId);
        return cal !== undefined && isWritable(cal);
      }) ?? group[0];

    const distinctCalendars = new Set(group.map((evt) => evt.calendarId));
    merged.push({
      ...primary,
      calendarName: calendarMap.get(primary.calendarId)?.name ?? "Unknown",
      duplicateCount: distinctCalendars.size - 1,
    });
  }
  return merged;
}

/** Accessory label for a row: "Work" alone, or "Work +2" when duplicated. */
export function formatCalendarLabel(event: EventWithCalendar): string {
  return event.duplicateCount > 0 ? `${event.calendarName} +${event.duplicateCount}` : event.calendarName;
}

export async function fetchEventsForRange(start: string, end: string): Promise<EventWithCalendar[]> {
  const calendars = await listCalendars();
  if (calendars.length === 0) return [];

  const calendarMap = new Map<string, MorgenCalendar>();
  for (const cal of calendars) {
    calendarMap.set(cal.id, cal);
  }

  const grouped = new Map<string, MorgenCalendar[]>();
  for (const cal of calendars) {
    const existing = grouped.get(cal.accountId) ?? [];
    existing.push(cal);
    grouped.set(cal.accountId, existing);
  }

  const fetched: MorgenEvent[] = [];
  for (const [accountId, cals] of grouped) {
    const calendarIds = cals.map((c) => c.id);
    fetched.push(...(await listEvents(accountId, calendarIds, start, end)));
  }

  const merged = mergeDuplicates(fetched, calendarMap);
  merged.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return merged;
}

export async function fetchEventsWithErrorHandling(
  start: string,
  end: string,
): Promise<{ events: EventWithCalendar[]; error: boolean }> {
  try {
    const events = await fetchEventsForRange(start, end);
    return { events, error: false };
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to load events",
      message: String(error),
    });
    return { events: [], error: true };
  }
}
