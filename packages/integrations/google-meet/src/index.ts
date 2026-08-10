import {
  ComposioClient,
  type ComposioCredentials,
  isComposioCredentials,
} from "@openloomi/integrations/composio";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

type PlatformAccount = {
  id: string;
};

type BotWithAccount = {
  userId: string;
  platformAccount?: PlatformAccount | null;
};

type GoogleMeetAdapterOptions = {
  bot: Pick<BotWithAccount, "userId" | "platformAccount">;
  credentials: ComposioCredentials;
  client?: ComposioClient;
};

export type GoogleMeetSpace = {
  name: string;
  meetingUri?: string | null;
  meetingCode?: string | null;
  config?: Record<string, unknown> | null;
};

export type GoogleMeetConferenceRecord = {
  name: string;
  space?: string | null;
  conferenceId?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  expireTime?: Date | null;
};

export type GoogleMeetRecording = {
  name: string;
  state?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  driveDestination?: {
    file?: string | null;
    exportUri?: string | null;
  } | null;
};

export type GoogleMeetTranscript = {
  name: string;
  state?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  docsDestination?: {
    document?: string | null;
    exportUri?: string | null;
  } | null;
};

export type GoogleMeetTranscriptEntry = {
  name: string;
  participant?: string | null;
  text?: string | null;
  languageCode?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
};

export class GoogleMeetAdapter {
  private readonly connectedAccountId: string;
  private readonly client: ComposioClient;

  constructor(options: GoogleMeetAdapterOptions) {
    if (!isComposioCredentials(options.credentials)) {
      throw new AppError(
        "bad_request:api",
        "Google Meet requires Composio authorization. Please reconnect Google Meet.",
      );
    }

    const connectedAccountId = options.credentials.composioConnectedAccountId;

    if (!connectedAccountId) {
      throw new AppError(
        "bad_request:api",
        "Google Meet is missing a Composio connected account id. Please reconnect.",
      );
    }

    this.connectedAccountId = connectedAccountId;
    this.client = options.client ?? new ComposioClient();
  }

  async createMeet(config?: Record<string, unknown>): Promise<GoogleMeetSpace> {
    const data = await this.proxy<Record<string, unknown>>({
      method: "POST",
      endpoint: "https://meet.googleapis.com/v2/spaces",
      body: config ? { config } : {},
    });
    return toMeetSpace(data);
  }

  async getMeet(spaceName: string): Promise<GoogleMeetSpace> {
    const data = await this.proxy<Record<string, unknown>>({
      method: "GET",
      endpoint: `https://meet.googleapis.com/v2/${encodeMeetResourceName(spaceName)}`,
    });
    return toMeetSpace(data);
  }

  async listConferenceRecords({
    pageSize = 50,
    filter,
    pageToken,
  }: {
    pageSize?: number;
    filter?: string;
    pageToken?: string;
  } = {}): Promise<{
    records: GoogleMeetConferenceRecord[];
    nextPageToken?: string | null;
  }> {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (filter) params.set("filter", filter);
    if (pageToken) params.set("pageToken", pageToken);

    const data = await this.proxy<{
      conferenceRecords?: Record<string, unknown>[];
      nextPageToken?: string | null;
    }>({
      method: "GET",
      endpoint: `https://meet.googleapis.com/v2/conferenceRecords?${params.toString()}`,
    });

    return {
      records: (data.conferenceRecords ?? []).map(toConferenceRecord),
      nextPageToken: data.nextPageToken ?? null,
    };
  }

  async listRecordings(
    conferenceRecordName: string,
  ): Promise<GoogleMeetRecording[]> {
    const data = await this.proxy<{ recordings?: Record<string, unknown>[] }>({
      method: "GET",
      endpoint: `https://meet.googleapis.com/v2/${encodeMeetResourceName(conferenceRecordName)}/recordings`,
    });
    return (data.recordings ?? []).map(toRecording);
  }

  async listTranscripts(
    conferenceRecordName: string,
  ): Promise<GoogleMeetTranscript[]> {
    const data = await this.proxy<{ transcripts?: Record<string, unknown>[] }>({
      method: "GET",
      endpoint: `https://meet.googleapis.com/v2/${encodeMeetResourceName(conferenceRecordName)}/transcripts`,
    });
    return (data.transcripts ?? []).map(toTranscript);
  }

  async listTranscriptEntries(
    transcriptName: string,
  ): Promise<GoogleMeetTranscriptEntry[]> {
    const data = await this.proxy<{
      transcriptEntries?: Record<string, unknown>[];
    }>({
      method: "GET",
      endpoint: `https://meet.googleapis.com/v2/${encodeMeetResourceName(transcriptName)}/entries`,
    });
    return (data.transcriptEntries ?? []).map(toTranscriptEntry);
  }

  private proxy<T>({
    endpoint,
    method,
    body,
  }: {
    endpoint: string;
    method: "GET" | "POST";
    body?: unknown;
  }) {
    return this.client.proxy<T>({
      connectedAccountId: this.connectedAccountId,
      method,
      endpoint,
      body,
    });
  }
}

function toMeetSpace(item: Record<string, unknown>): GoogleMeetSpace {
  return {
    name: stringOrFallback(item.name, "spaces/unknown"),
    meetingUri: stringOrNull(item.meetingUri),
    meetingCode: stringOrNull(item.meetingCode),
    config: recordOrNull(item.config),
  };
}

function toConferenceRecord(
  item: Record<string, unknown>,
): GoogleMeetConferenceRecord {
  return {
    name: stringOrFallback(item.name, "conferenceRecords/unknown"),
    space: stringOrNull(item.space),
    conferenceId: stringOrNull(item.conferenceId),
    startTime: dateOrNull(item.startTime),
    endTime: dateOrNull(item.endTime),
    expireTime: dateOrNull(item.expireTime),
  };
}

function toRecording(item: Record<string, unknown>): GoogleMeetRecording {
  const driveDestination = recordOrNull(item.driveDestination);
  return {
    name: stringOrFallback(item.name, "recordings/unknown"),
    state: stringOrNull(item.state),
    startTime: dateOrNull(item.startTime),
    endTime: dateOrNull(item.endTime),
    driveDestination: driveDestination
      ? {
          file: stringOrNull(driveDestination.file),
          exportUri: stringOrNull(driveDestination.exportUri),
        }
      : null,
  };
}

function toTranscript(item: Record<string, unknown>): GoogleMeetTranscript {
  const docsDestination = recordOrNull(item.docsDestination);
  return {
    name: stringOrFallback(item.name, "transcripts/unknown"),
    state: stringOrNull(item.state),
    startTime: dateOrNull(item.startTime),
    endTime: dateOrNull(item.endTime),
    docsDestination: docsDestination
      ? {
          document: stringOrNull(docsDestination.document),
          exportUri: stringOrNull(docsDestination.exportUri),
        }
      : null,
  };
}

function toTranscriptEntry(
  item: Record<string, unknown>,
): GoogleMeetTranscriptEntry {
  return {
    name: stringOrFallback(item.name, "entries/unknown"),
    participant: stringOrNull(item.participant),
    text: stringOrNull(item.text),
    languageCode: stringOrNull(item.languageCode),
    startTime: dateOrNull(item.startTime),
    endTime: dateOrNull(item.endTime),
  };
}

function encodeMeetResourceName(name: string) {
  return name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringOrFallback(value: unknown, fallback: string) {
  return stringOrNull(value) ?? fallback;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function dateOrNull(value: unknown) {
  const text = stringOrNull(value);
  return text ? new Date(text) : null;
}
