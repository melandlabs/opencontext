import type { BotWithAccount } from "./google-calendar";
// eslint-disable-next-line max-len
import { AppError } from "./google-calendar";

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
// Outlook Calendar adapter
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type OutlookCalendarCredentials = {
  accessToken?: string | null;
  refreshToken?: string | null;
  scope?: string | null;
  tokenType?: string | null;
  expiresAt?: number | null;
};

export type OutlookCalendarEvent = {
  id: string;
  subject: string | null;
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  location?: {
    displayName?: string | null;
  };
  organizer?: {
    emailAddress?: {
      name?: string | null;
      address?: string | null;
    };
  };
  attendees?: Array<{
    emailAddress?: {
      name?: string | null;
      address?: string | null;
    };
    type?: string | null;
  }> | null;
  lastModifiedDateTime?: string | null;
  webLink?: string | null;
};

type GraphListResponse<T> = {
  value?: T[];
};

export class OutlookCalendarAdapter {
  private credentials: OutlookCalendarCredentials;
  private readonly userId: string;
  private readonly platformAccountId: string | null;

  constructor({
    bot,
    credentials,
  }: {
    bot: Pick<BotWithAccount, "userId" | "platformAccount">;
    credentials: OutlookCalendarCredentials;
  }) {
    this.credentials = credentials;
    this.userId = bot.userId;
    this.platformAccountId = bot.platformAccount?.id ?? null;
  }

  private isExpired(): boolean {
    const expiresAt = this.credentials.expiresAt;
    if (!expiresAt) return false;
    return Date.now() > expiresAt - 90_000;
  }

  private async refreshIfNeeded() {
    if (!this.isExpired()) return;
    await this.refreshToken();
  }

  private async refreshToken() {
    if (!this.credentials.refreshToken) {
      throw new AppError(
        "unauthorized:api",
        "Outlook Calendar refresh token missing. Please reconnect.",
      );
    }

    const clientId = process.env.OUTLOOK_CALENDAR_CLIENT_ID;
    const clientSecret = process.env.OUTLOOK_CALENDAR_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new AppError(
        "bad_request:api",
        "Outlook Calendar OAuth is not configured.",
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken,
      scope:
        process.env.OUTLOOK_CALENDAR_SCOPE ??
        "offline_access User.Read Calendars.Read Calendars.ReadWrite",
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string | null;
      expires_in?: number | null;
      scope?: string | null;
      token_type?: string | null;
      error?: string | null;
    };

    if (!response.ok || !body.access_token) {
      throw new AppError(
        "unauthorized:api",
        body?.error ?? "Failed to refresh Outlook Calendar token",
      );
    }

    this.credentials.accessToken = body.access_token;
    this.credentials.refreshToken =
      body.refresh_token ?? this.credentials.refreshToken ?? null;
    this.credentials.scope = body.scope ?? this.credentials.scope ?? null;
    this.credentials.tokenType =
      body.token_type ?? this.credentials.tokenType ?? null;
    this.credentials.expiresAt = body.expires_in
      ? Date.now() + body.expires_in * 1000
      : (this.credentials.expiresAt ?? null);

    await this.persistCredentials();
  }

  private async persistCredentials() {
    if (!this.platformAccountId) return;
    try {
      await updateIntegrationAccount({
        userId: this.userId,
        platformAccountId: this.platformAccountId,
        credentials: this.credentials,
      });
    } catch (error) {
      console.warn("[Outlook Calendar] Failed to persist credentials", error);
    }
  }

  private async graphFetch<T>(path: string): Promise<T> {
    await this.refreshIfNeeded();
    if (!this.credentials.accessToken) {
      throw new AppError(
        "unauthorized:api",
        "Outlook Calendar access token missing.",
      );
    }

    const response = await fetch(`${GRAPH_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new AppError(
        "bad_request:api",
        `Outlook Calendar API failed (${response.status}): ${errorText || response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  async listEvents({
    since,
    until,
    maxResults = 100,
  }: {
    since: Date;
    until?: Date;
    maxResults?: number;
  }): Promise<OutlookCalendarEvent[]> {
    const quoteIso = (date: Date) => `'${date.toISOString()}'`;
    const filterParts = [`lastModifiedDateTime ge ${quoteIso(since)}`];
    if (until) {
      filterParts.push(`start/dateTime le ${quoteIso(until)}`);
    }
    const filter = filterParts.join(" and ");

    const params = new URLSearchParams();
    params.set("$top", String(maxResults));
    params.set("$orderby", "lastModifiedDateTime desc");
    params.set("$filter", filter);

    const events = await this.graphFetch<
      GraphListResponse<OutlookCalendarEvent>
    >(`/me/events?${params.toString()}`);
    return events.value ?? [];
  }

  async createEvent({
    subject,
    start,
    end,
    location,
    attendees,
  }: {
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    location?: string | null;
    attendees?: { email: string; type?: string }[];
  }): Promise<OutlookCalendarEvent> {
    await this.refreshIfNeeded();
    if (!this.credentials.accessToken) {
      throw new AppError(
        "unauthorized:api",
        "Outlook Calendar access token missing.",
      );
    }

    const response = await fetch(`${GRAPH_BASE}/me/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject,
        start,
        end,
        location: location ? { displayName: location } : undefined,
        attendees: attendees?.map((a) => ({
          emailAddress: { address: a.email },
          type: a.type ?? "required",
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new AppError(
        "bad_request:api",
        `Failed to create Outlook event: ${errorText || response.statusText}`,
      );
    }

    return (await response.json()) as OutlookCalendarEvent;
  }
}
