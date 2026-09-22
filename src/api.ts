import { getPreferenceValues, showToast, Toast } from "@raycast/api";

const BASE_URL = "https://api.morgen.so/v3";

interface Preferences {
  morgenApiKey: string;
}

export async function morgenFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const { morgenApiKey } = getPreferenceValues<Preferences>();

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${morgenApiKey}`,
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const message = `Morgen API error (${response.status}): ${body}`;
    await showToast({ style: Toast.Style.Failure, title: "API Error", message });
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export interface MorgenCalendar {
  id: string;
  accountId: string;
  integrationId?: string;
  name: string;
  color?: string;
  myRights?: {
    mayReadItems?: boolean;
    mayWriteAll?: boolean;
    mayWriteOwn?: boolean;
  };
}

export function isWritable(calendar: MorgenCalendar): boolean {
  const rights = calendar.myRights;
  if (!rights) return true;
  return rights.mayWriteAll === true || rights.mayWriteOwn === true;
}

export interface MorgenLocation {
  "@type"?: "Location";
  name?: string;
}

export interface MorgenParticipant {
  "@type"?: "Participant";
  name?: string;
  email?: string;
  roles?: { attendee?: boolean; owner?: boolean };
  participationStatus?: string;
}

export interface MorgenEvent {
  id?: string;
  /**
   * The provider's iCalendar UID — not the same as `id`. Stable across copies
   * of the same meeting in different calendars, whereas `id` is only
   * meaningful within the account it came from.
   */
  uid?: string;
  /** Present on instances of a recurring series, which share a `uid`. */
  recurrenceId?: string;
  title: string;
  start: string;
  end?: string;
  duration?: string;
  timeZone?: string;
  calendarId: string;
  accountId: string;
  calendarName?: string;
  showWithoutTime?: boolean;
  description?: string;
  descriptionContentType?: string;
  locations?: Record<string, MorgenLocation>;
  participants?: Record<string, MorgenParticipant>;
  freeBusyStatus?: string;
  privacy?: string;
  "google.com:hangoutLink"?: string;
  "morgen.so:derived"?: {
    virtualRoom?: { url?: string };
  };
}

interface CalendarsResponse {
  data?: { calendars?: MorgenCalendar[] };
}

interface EventsResponse {
  data?: { events?: MorgenEvent[] };
}

function expectArray<T>(value: T[] | undefined, path: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected Morgen API response: expected ${path} to be an array`);
  }
  return value;
}

export async function listCalendars(): Promise<MorgenCalendar[]> {
  const result = await morgenFetch<CalendarsResponse>("/calendars/list");
  return expectArray(result.data?.calendars, "data.calendars");
}

export async function listEvents(
  accountId: string,
  calendarIds: string[],
  start: string,
  end: string,
): Promise<MorgenEvent[]> {
  const params = new URLSearchParams({
    accountId,
    calendarIds: calendarIds.join(","),
    start,
    end,
  });
  const result = await morgenFetch<EventsResponse>(`/events/list?${params.toString()}`);
  return expectArray(result.data?.events, "data.events");
}

export interface CreateEventPayload {
  accountId: string;
  calendarId: string;
  title: string;
  start: string;
  duration: string;
  timeZone: string;
  showWithoutTime: false;
}

export async function createEvent(payload: CreateEventPayload): Promise<MorgenEvent> {
  const result = await morgenFetch<{ data?: { event?: MorgenEvent } }>("/events/create", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const event = result.data?.event;
  if (!event) {
    throw new Error("Unexpected Morgen API response: expected data.event");
  }
  return event;
}
