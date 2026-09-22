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

/**
 * Identifies copies of one meeting held in several calendars.
 *
 * Instances of a recurring series share a `uid`, so the instance is part of the
 * key — keying on `uid` alone would collapse a whole series into one row.
 */
function mergeKey(event: MorgenEvent): string {
  if (event.uid) {
    return `uid:${event.uid}|${event.recurrenceId ?? event.start}`;
  }
  // No uid: match on visible detail instead. This cannot distinguish two
  // genuinely separate events that share a title, start and duration.
  return `detail:${event.title}|${event.start}|${event.duration ?? event.end ?? ""}`;
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
