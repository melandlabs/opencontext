export type PlatformAgentErrorCode =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error"
  | "process_crash"
  | "stream_interrupted"
  | "network_offline"
  | "custom_api_incompatible"
  | "internal_error";

export type PlatformErrorEnvelope = {
  type: "error";
  error: {
    type: PlatformAgentErrorCode;
    message: string;
  };
  request_id?: string;
};

export type PlatformAdapterErrorContext = {
  platform: string;
  operation: string;
  status?: number;
  code?: string;
  cause?: unknown;
};

const KNOWN_CODES = new Set<PlatformAgentErrorCode>([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
  "process_crash",
  "stream_interrupted",
  "network_offline",
  "custom_api_incompatible",
  "internal_error",
]);

export class PlatformAdapterError extends Error {
  public readonly type = "error";
  public readonly error: PlatformErrorEnvelope["error"];
  public readonly request_id?: string;
  public readonly platform: string;
  public readonly operation: string;
  public readonly status?: number;
  public readonly code?: string;
  public readonly rawMessage: string;
  public readonly originalCause?: unknown;

  constructor(
    envelope: PlatformErrorEnvelope,
    context: PlatformAdapterErrorContext,
  ) {
    super(platformErrorEnvelopeToWireMessage(envelope));
    this.name = "PlatformAdapterError";
    this.error = envelope.error;
    this.request_id = envelope.request_id;
    this.platform = context.platform;
    this.operation = context.operation;
    this.status = context.status;
    this.code = context.code;
    this.rawMessage = envelope.error.message;
    this.originalCause = context.cause;
  }

  toJSON(): PlatformErrorEnvelope {
    return {
      type: "error",
      error: this.error,
      ...(this.request_id ? { request_id: this.request_id } : {}),
    };
  }
}

export function platformErrorEnvelopeToWireMessage(
  envelope: PlatformErrorEnvelope,
): string {
  return JSON.stringify({
    type: envelope.type,
    error: envelope.error,
    ...(envelope.request_id ? { request_id: envelope.request_id } : {}),
  });
}

export function isPlatformAdapterError(
  input: unknown,
): input is PlatformAdapterError {
  return (
    input instanceof PlatformAdapterError ||
    Boolean(
      input &&
      typeof input === "object" &&
      (input as { name?: unknown }).name === "PlatformAdapterError" &&
      isPlatformErrorEnvelope(input),
    )
  );
}

export function isPlatformErrorEnvelope(
  input: unknown,
): input is PlatformErrorEnvelope {
  if (!input || typeof input !== "object") return false;
  const candidate = input as {
    type?: unknown;
    error?: { type?: unknown; message?: unknown };
  };
  return (
    candidate.type === "error" &&
    typeof candidate.error?.type === "string" &&
    KNOWN_CODES.has(candidate.error.type as PlatformAgentErrorCode)
  );
}

export function makePlatformErrorEnvelope(
  code: PlatformAgentErrorCode,
  message: string,
  opts?: { request_id?: string },
): PlatformErrorEnvelope {
  return {
    type: "error",
    error: { type: code, message },
    ...(opts?.request_id ? { request_id: opts.request_id } : {}),
  };
}

export function toPlatformAdapterError(
  platform: string,
  operation: string,
  error: unknown,
  opts?: {
    fallbackCode?: PlatformAgentErrorCode;
    fallbackMessage?: string;
    request_id?: string;
  },
): PlatformAdapterError {
  if (isPlatformAdapterError(error)) return error;

  const explicitStatus = getNumericProperty(error, "status", "statusCode");
  const code = getStringProperty(error, "code");
  const raw = coerceErrorMessage(error) || opts?.fallbackMessage || operation;
  const status = explicitStatus ?? extractHttpStatus(raw);
  const errorCode =
    classifyPlatformErrorCode(error, raw, status) ??
    opts?.fallbackCode ??
    "api_error";
  const message = `[${platform}] ${operation} failed: ${raw}`;

  return new PlatformAdapterError(
    makePlatformErrorEnvelope(errorCode, message, {
      request_id: opts?.request_id ?? getStringProperty(error, "request_id"),
    }),
    {
      platform,
      operation,
      ...(status !== undefined ? { status } : {}),
      ...(code ? { code } : {}),
      cause: error,
    },
  );
}

export function createPlatformAdapterError(
  platform: string,
  operation: string,
  code: PlatformAgentErrorCode,
  message: string,
  opts?: { request_id?: string; cause?: unknown },
): PlatformAdapterError {
  return new PlatformAdapterError(
    makePlatformErrorEnvelope(code, `[${platform}] ${operation}: ${message}`, {
      request_id: opts?.request_id,
    }),
    { platform, operation, cause: opts?.cause },
  );
}

function getNumericProperty(
  input: unknown,
  ...keys: string[]
): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const response = (obj.response ?? obj.res) as Record<string, unknown> | null;
  const responseStatus = response?.status;
  return typeof responseStatus === "number" && Number.isFinite(responseStatus)
    ? responseStatus
    : undefined;
}

function getStringProperty(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractHttpStatus(raw: string): number | undefined {
  const match =
    raw.match(/\bHTTP\s+([1-5]\d{2})\b/i) ??
    raw.match(/\bstatus[=: ]+([1-5]\d{2})\b/i);
  if (!match) return undefined;
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : undefined;
}

function coerceErrorMessage(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Error) return input.message;
  if (input && typeof input === "object") {
    const obj = input as {
      message?: unknown;
      error?: { message?: unknown };
      data?: { message?: unknown };
    };
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error?.message === "string") return obj.error.message;
    if (typeof obj.data?.message === "string") return obj.data.message;
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return String(input ?? "");
}

function classifyPlatformErrorCode(
  input: unknown,
  raw: string,
  status?: number,
): PlatformAgentErrorCode | null {
  if (input && typeof input === "object") {
    const embeddedCode = (input as { error?: { type?: unknown } }).error?.type;
    if (
      typeof embeddedCode === "string" &&
      KNOWN_CODES.has(embeddedCode as PlatformAgentErrorCode)
    ) {
      return embeddedCode as PlatformAgentErrorCode;
    }
  }

  const lower = raw.toLowerCase();
  const invalidCredential =
    lower.includes("invalid token") ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid access token") ||
    lower.includes("access token invalid") ||
    lower.includes("access_token invalid") ||
    lower.includes("tenant_access_token invalid") ||
    lower.includes("invalid app secret") ||
    lower.includes("app secret invalid") ||
    lower.includes("app_secret invalid") ||
    lower.includes("invalid app_secret") ||
    lower.includes("invalid appsecret") ||
    lower.includes("appsecret invalid") ||
    lower.includes("invalid client secret") ||
    lower.includes("client secret invalid") ||
    lower.includes("clientsecret invalid") ||
    lower.includes("invalid clientsecret") ||
    lower.includes("invalid app credential") ||
    lower.includes("app credential invalid") ||
    lower.includes("invalid app credentials") ||
    lower.includes("app credentials invalid") ||
    lower.includes("invalid appid") ||
    lower.includes("appid invalid") ||
    lower.includes("invalid app id") ||
    lower.includes("app id invalid") ||
    lower.includes("invalid appkey") ||
    lower.includes("appkey invalid") ||
    lower.includes("invalid app key") ||
    lower.includes("app key invalid");
  if (
    invalidCredential ||
    lower.includes("unauthorized") ||
    lower.includes("auth_key_unregistered") ||
    lower.includes("auth_bytes_invalid") ||
    lower.includes("failed to authenticate") ||
    lower.includes("authentication failed") ||
    lower.includes("session expired")
  ) {
    return "authentication_error";
  }

  if (typeof status === "number") {
    const fromStatus = codeFromHttpStatus(status);
    if (fromStatus) return fromStatus;
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("enetunreach") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  ) {
    return "network_offline";
  }
  if (
    lower.includes("etimedout") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "timeout_error";
  }
  if (lower.includes("permission") || lower.includes("forbidden")) {
    return "permission_error";
  }
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate_limit_error";
  }
  if (
    lower.includes("payload too large") ||
    lower.includes("request too large") ||
    lower.includes("file too large")
  ) {
    return "request_too_large";
  }
  return null;
}

function codeFromHttpStatus(status: number): PlatformAgentErrorCode | null {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 504:
      return "timeout_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 && status <= 599 ? "api_error" : null;
  }
}
