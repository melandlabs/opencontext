import { google, type calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import {
  type ComposioCredentials,
  isComposioCredentials,
} from "@openloomi/integrations/composio";
import { ComposioGoogleCalendarProxy } from "./composio-google-calendar";

// ---------------------------------------------------------------------------
// Inlined stubs for @/lib/errors
// ---------------------------------------------------------------------------

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ---------------------------------------------------------------------------
// Inlined stubs for @/lib/db/queries
// ---------------------------------------------------------------------------

export type PlatformAccount = {
  id: string;
};

export type BotWithAccount = {
  userId: string;
  platformAccount?: PlatformAccount | null;
};

type UpdateIntegrationAccountOptions = {
  userId: string;
  platformAccountId: string;
  credentials: Record<string, unknown>;
};

async function updateIntegrationAccount(
  _options: UpdateIntegrationAccountOptions,
): Promise<void> {
  // Stub: persist credentials to the integration account record.
  // In the application, this calls the real DB update.
}

// ---------------------------------------------------------------------------
// Google Calendar adapter
// ---------------------------------------------------------------------------

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

export type GoogleCalendarStoredCredentials = ComposioCredentials & {
  accessToken?: string | null;
  refreshToken?: string | null;
  scope?: string | null;
  tokenType?: string | null;
  expiryDate?: number | null;
};

export type GoogleCalendarEvent = {
  id: string;
  calendarId: string;
  summary: string | null;
  description?: string | null;
  location?: string | null;
  link?: string | null;
  start: {
    dateTime: Date;
    isAllDay: boolean;
    timeZone?: string | null;
  };
  end: {
    dateTime: Date;
    isAllDay: boolean;
    timeZone?: string | null;
  };
  attendees: {
    email?: string | null;
    displayName?: string | null;
    responseStatus?: string | null;
  }[];
  organizer?: {
    email?: string | null;
    displayName?: string | null;
  };
  created?: Date | null;
  updated?: Date | null;
  status?: string | null;
  conferenceLink?: string | null;
};

type GoogleCalendarAdapterOptions = {
  bot: Pick<BotWithAccount, "userId" | "platformAccount">;
  credentials: GoogleCalendarStoredCredentials;
  calendarIds?: string[] | null;
  timeZone?: string | null;
};

export class GoogleCalendarAdapter {
  private oauth2Client: OAuth2Client | null = null;
  private composioCalendar: ComposioGoogleCalendarProxy | null = null;
  private storedCredentials: GoogleCalendarStoredCredentials;
  private calendarIds: string[];
  private userId: string;
  private platformAccountId: string | null;

  constructor(options: GoogleCalendarAdapterOptions) {
    const calendarIds = options.calendarIds ?? [];
    this.calendarIds = calendarIds.length > 0 ? calendarIds : ["primary"];
    this.userId = options.bot.userId;
    this.platformAccountId = options.bot.platformAccount?.id ?? null;
    this.storedCredentials = options.credentials ?? {};

    if (isComposioCredentials(this.storedCredentials)) {
      const connectedAccountId =
        this.storedCredentials.composioConnectedAccountId;
      if (!connectedAccountId) {
        throw new AppError(
          "bad_request:api",
          "Google Calendar is missing a Composio connected account id. Please reconnect.",
        );
      }
      this.composioCalendar = new ComposioGoogleCalendarProxy({
        connectedAccountId,
      });
      return;
    }

    const clientId =
      process.env.GOOGLE_CALENDAR_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
    const clientSecret =
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET ??
      process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new AppError(
        "bad_request:api",
        "Google Calendar integration is not configured. Please set GOOGLE_CLIENT_ID/SECRET.",
      );
    }

    const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? "";

    const oauth2Client = new google.auth.OAuth2({
      clientId,
      clientSecret,
      redirectUri,
    });
    this.oauth2Client = oauth2Client;

    oauth2Client.setCredentials({
      access_token: this.storedCredentials.accessToken ?? undefined,
      refresh_token: this.storedCredentials.refreshToken ?? undefined,
      expiry_date: this.storedCredentials.expiryDate ?? undefined,
      scope: this.storedCredentials.scope ?? undefined,
      token_type: this.storedCredentials.tokenType ?? undefined,
    });
  }

  private async persistCredentialsIfChanged() {
    if (!this.oauth2Client) return;

    const nextCredentials: GoogleCalendarStoredCredentials = {
      accessToken: this.oauth2Client.credentials.access_token ?? null,
      refreshToken: this.oauth2Client.credentials.refresh_token ?? null,
      scope: this.oauth2Client.credentials.scope ?? null,
      tokenType: this.oauth2Client.credentials.token_type ?? null,
      expiryDate: this.oauth2Client.credentials.expiry_date ?? null,
    };

    const changed =
      nextCredentials.accessToken !== this.storedCredentials.accessToken ||
      nextCredentials.refreshToken !== this.storedCredentials.refreshToken ||
      nextCredentials.scope !== this.storedCredentials.scope ||
      nextCredentials.tokenType !== this.storedCredentials.tokenType ||
      nextCredentials.expiryDate !== this.storedCredentials.expiryDate;

    if (!changed || !this.platformAccountId) {
      this.storedCredentials = nextCredentials;
      return;
    }

    await updateIntegrationAccount({
      userId: this.userId,
      platformAccountId: this.platformAccountId,
      credentials: nextCredentials,
    });
    this.storedCredentials = nextCredentials;
  }

  private async withCalendar<T>(
    callback: (calendar: calendar_v3.Calendar) => Promise<T>,
  ): Promise<T> {
    if (!this.oauth2Client) {
      throw new AppError(
        "bad_request:api",
        "Google Calendar OAuth client is not initialized.",
      );
    }

    const calendar = google.calendar({
      version: "v3",
      auth: this.oauth2Client,
    });
    const result = await callback(calendar);
    await this.persistCredentialsIfChanged();
    return result;
  }

  async listCalendars(): Promise<calendar_v3.Schema$CalendarListEntry[]> {
    if (this.composioCalendar) {
      return (await this.composioCalendar.listCalendars()) as calendar_v3.Schema$CalendarListEntry[];
    }

    const response = await this.withCalendar((calendar) =>
      calendar.calendarList.list({
        minAccessRole: "reader",
        showHidden: false,
        showDeleted: false,
        maxResults: 50,
      }),
    );
    return (response as any).data?.items ?? [];
  }

  async listEventsByTime({
    since,
    until,
    maxResults = 100,
    orderBy = "updated",
  }: {
    since: Date;
    until?: Date;
    maxResults?: number;
    orderBy?: "startTime" | "updated";
  }): Promise<GoogleCalendarEvent[]> {
    const calendarIds =
      this.calendarIds.length > 0 ? this.calendarIds : ["primary"];
    const events: GoogleCalendarEvent[] = [];

    for (const calendarId of calendarIds) {
      const items = this.composioCalendar
        ? await this.composioCalendar.listEvents({
            calendarId,
            since,
            until,
            maxResults,
            orderBy,
          })
        : ((
            (await this.withCalendar((calendar) =>
              calendar.events.list({
                calendarId,
                timeMin: since.toISOString(),
                timeMax: until?.toISOString(),
                maxResults,
                singleEvents: true,
                orderBy,
                showDeleted: false,
              }),
            )) as any
          ).data?.items ?? []);

      for (const item of items) {
        const event = toGoogleCalendarEvent(item, calendarId);
        if (event) events.push(event);
      }
    }

    return events;
  }

  async createEvent({
    summary,
    start,
    end,
    description,
    location,
    attendees,
    conferenceDataVersion = 0,
    createConference = false,
    sendUpdates,
  }: {
    summary: string;
    start: { dateTime: string; timeZone?: string };
    end: { dateTime: string; timeZone?: string };
    description?: string | null;
    location?: string | null;
    attendees?: { email: string; displayName?: string }[];
    conferenceDataVersion?: number;
    createConference?: boolean;
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<GoogleCalendarEvent> {
    const calendarId =
      this.calendarIds.length > 0 ? this.calendarIds[0] : "primary";

    const requestBody = {
      summary,
      description: description ?? undefined,
      location: location ?? undefined,
      start,
      end,
      attendees: attendees?.map((a) => ({
        email: a.email,
        displayName: a.displayName ?? undefined,
      })),
      conferenceData: createConference
        ? {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: {
                type: "hangoutsMeet",
              },
            },
          }
        : undefined,
    };

    const item = (
      this.composioCalendar
        ? await this.composioCalendar.createEvent({
            calendarId,
            conferenceDataVersion: createConference ? 1 : conferenceDataVersion,
            sendUpdates,
            requestBody,
          })
        : (
            (await this.withCalendar((calendar) =>
              calendar.events.insert({
                calendarId,
                conferenceDataVersion: createConference
                  ? 1
                  : conferenceDataVersion,
                sendUpdates,
                requestBody,
              }),
            )) as any
          ).data
    ) as any;
    if (!item.id) {
      throw new AppError("bad_request:api", "Failed to create Google event");
    }

    const event = toGoogleCalendarEvent(item, calendarId);
    if (!event) {
      throw new AppError("bad_request:api", "Invalid event dates");
    }
    return event;
  }
}

function toGoogleCalendarEvent(
  item: any,
  calendarId: string,
): GoogleCalendarEvent | null {
  if (!item.id || item.status === "cancelled") return null;
  const startDate = parseDate(item.start);
  const endDate = parseDate(item.end);
  if (!startDate || !endDate) return null;

  return {
    id: item.id,
    calendarId,
    summary: item.summary ?? null,
    description: item.description ?? null,
    location: item.location ?? null,
    link: item.htmlLink ?? null,
    start: startDate,
    end: endDate,
    attendees:
      item.attendees?.map((attendee: any) => ({
        email: attendee.email ?? null,
        displayName: attendee.displayName ?? null,
        responseStatus: attendee.responseStatus ?? null,
      })) ?? [],
    organizer: item.organizer
      ? {
          email: item.organizer.email ?? null,
          displayName: item.organizer.displayName ?? null,
        }
      : undefined,
    created: item.created ? new Date(item.created) : null,
    updated: item.updated ? new Date(item.updated) : null,
    status: item.status ?? null,
    conferenceLink:
      item.hangoutLink ?? item.conferenceData?.entryPoints?.[0]?.uri ?? null,
  };
}

function parseDate(
  input: calendar_v3.Schema$EventDateTime | undefined | null,
): {
  dateTime: Date;
  isAllDay: boolean;
  timeZone?: string | null;
} | null {
  if (!input) return null;
  if (input.dateTime) {
    return {
      dateTime: new Date(input.dateTime),
      isAllDay: false,
      timeZone: input.timeZone ?? null,
    };
  }
  if (input.date) {
    // All-day events use 00:00 local date
    const date = new Date(input.date);
    return { dateTime: date, isAllDay: true, timeZone: input.timeZone ?? null };
  }
  return null;
}
