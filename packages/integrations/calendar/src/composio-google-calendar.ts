import { ComposioClient } from "@openloomi/integrations/composio";

export class ComposioGoogleCalendarProxy {
  private readonly connectedAccountId: string;
  private readonly client: ComposioClient;

  constructor({
    connectedAccountId,
    client,
  }: {
    connectedAccountId: string;
    client?: ComposioClient;
  }) {
    this.connectedAccountId = connectedAccountId;
    this.client = client ?? new ComposioClient();
  }

  async listCalendars(): Promise<unknown[]> {
    const params = new URLSearchParams({
      minAccessRole: "reader",
      showHidden: "false",
      showDeleted: "false",
      maxResults: "50",
    });
    const data = await this.client.proxy<{ items?: unknown[] }>({
      connectedAccountId: this.connectedAccountId,
      method: "GET",
      endpoint: `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params.toString()}`,
    });
    return data?.items ?? [];
  }

  async listEvents({
    calendarId,
    since,
    until,
    maxResults,
    orderBy = "updated",
  }: {
    calendarId: string;
    since: Date;
    until?: Date;
    maxResults: number;
    orderBy?: "startTime" | "updated";
  }): Promise<unknown[]> {
    const params = new URLSearchParams({
      timeMin: since.toISOString(),
      maxResults: String(maxResults),
      singleEvents: "true",
      // The default supports incremental refresh; direct range queries can request startTime.
      orderBy,
      showDeleted: "false",
    });

    if (until) {
      params.set("timeMax", until.toISOString());
    }

    const data = await this.client.proxy<{ items?: unknown[] }>({
      connectedAccountId: this.connectedAccountId,
      method: "GET",
      endpoint: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    });
    return data?.items ?? [];
  }

  async createEvent({
    calendarId,
    conferenceDataVersion,
    sendUpdates,
    requestBody,
  }: {
    calendarId: string;
    conferenceDataVersion: number;
    sendUpdates?: "all" | "externalOnly" | "none";
    requestBody: Record<string, unknown>;
  }): Promise<unknown> {
    const params = new URLSearchParams({
      conferenceDataVersion: String(conferenceDataVersion),
    });
    if (sendUpdates) {
      params.set("sendUpdates", sendUpdates);
    }
    return this.client.proxy<unknown>({
      connectedAccountId: this.connectedAccountId,
      method: "POST",
      endpoint: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      body: requestBody,
    });
  }
}
