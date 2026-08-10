export type ErrorType =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "offline";

export type Surface =
  | "chat"
  | "bot"
  | "auth"
  | "api"
  | "insight"
  | "stream"
  | "database"
  | "history"
  | "vote"
  | "document"
  | "suggestions"
  | "quota"
  | "feedback"
  | "survey"
  | "telegram"
  | "whatsapp"
  | "discord"
  | "rag"
  | "category"
  | "note"
  | "x_token_expired";

export type ErrorCode = `${ErrorType}:${Surface}`;

export type ErrorVisibility = "response" | "log" | "none";

export const visibilityBySurface: Record<Surface, ErrorVisibility> = {
  database: "log",
  chat: "response",
  bot: "response",
  auth: "response",
  stream: "response",
  api: "response",
  insight: "response",
  history: "response",
  vote: "response",
  document: "response",
  suggestions: "response",
  quota: "response",
  feedback: "response",
  survey: "response",
  telegram: "response",
  whatsapp: "response",
  discord: "response",
  rag: "response",
  category: "response",
  note: "response",
  x_token_expired: "response",
};

export class AppError extends Error {
  public type: ErrorType;
  public surface: Surface;
  public statusCode: number;

  constructor(errorCode: ErrorCode, cause?: string) {
    super();

    const [type, surface] = errorCode.split(":");

    this.type = type as ErrorType;
    this.cause = cause;
    this.surface = surface as Surface;
    this.message = getMessageByErrorCode(errorCode, cause);
    this.statusCode = getStatusCodeByType(this.type);
  }

  public toResponse() {
    const code: ErrorCode = `${this.type}:${this.surface}`;
    const visibility = visibilityBySurface[this.surface];

    const { message, cause, statusCode } = this;

    if (visibility === "log") {
      console.error({
        code,
        message,
        cause,
      });

      return Response.json(
        { code: "", message: "Something went wrong. Please try again later." },
        { status: statusCode },
      );
    }

    return Response.json({ code, message, cause }, { status: statusCode });
  }
}

export function getMessageByErrorCode(
  errorCode: ErrorCode,
  cause?: string,
): string {
  if (errorCode.includes("database")) {
    return "An error occurred while executing a database query.";
  }

  switch (errorCode) {
    case "bad_request:api":
      return `The request couldn't be processed. Please check your input and try again.${cause ? ` Cause: ${cause}` : ""}`;

    case "unauthorized:auth":
      return "You need to sign in before continuing.";
    case "forbidden:auth":
      return "Your account does not have access to this feature.";
    case "unauthorized:x_token_expired":
      return (
        cause ||
        "X access token expired. Please reconnect X in Settings > Integrations."
      );

    case "rate_limit:chat":
      return cause
        ? cause
        : "You have exceeded your maximum number of messages for the day. Please try again tomorrow.";
    case "not_found:chat":
      return "The requested chat was not found. Please check the chat ID and try again.";
    case "forbidden:chat":
      return "This chat belongs to another user. Please check the chat ID and try again.";
    case "unauthorized:chat":
      return "You need to sign in to view this chat. Please sign in and try again.";
    case "offline:chat":
      return "We're having trouble sending your message. Please check your internet connection and try again.";

    case "not_found:document":
      return "The requested document was not found. Please check the document ID and try again.";
    case "forbidden:document":
      return "This document belongs to another user. Please check the document ID and try again.";
    case "unauthorized:document":
      return "You need to sign in to view this document. Please sign in and try again.";
    case "bad_request:document":
      return "The request to create or update the document was invalid. Please check your input and try again.";

    case "unauthorized:category":
      return "You need to sign in to manage categories. Please sign in and try again.";
    case "bad_request:category":
      return cause
        ? cause
        : "The request to create or update the category was invalid. Please check your input and try again.";
    case "not_found:category":
      return "The requested category was not found. Please check the category ID and try again.";

    case "unauthorized:note":
      return "You need to sign in to manage notes. Please sign in and try again.";
    case "bad_request:note":
      return cause
        ? cause
        : "The request to create or update the note was invalid. Please check your input and try again.";
    case "not_found:note":
      return "The requested note was not found. Please check the note ID and try again.";
    case "forbidden:note":
      return "This note belongs to another user. Please check the note ID and try again.";

    default:
      return cause ? cause : "Something went wrong. Please try again later.";
  }
}

function getStatusCodeByType(type: ErrorType) {
  switch (type) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "rate_limit":
      return 429;
    case "offline":
      return 503;
    default:
      return 500;
  }
}

export const telegramAuthBytesInvalidError = "400: AUTH_BYTES_INVALID";
export const telegramAuthKeyUnregisteredError = "401: AUTH_KEY_UNREGISTERED";
export const telegramAuthDuplicatedError = "406: AUTH_KEY_DUPLICATED";

export const telegramMethodInvalidError = "400: BOT_METHOD_INVALID";
export const telegramInvalidSessionError = "Not a valid string";
export const slackMissingScopeError = "An API error occurred: missing_scope";
export const invalidAuthErrors = [
  telegramAuthBytesInvalidError,
  telegramAuthKeyUnregisteredError,
  telegramAuthDuplicatedError, // Telegram string session error
  telegramMethodInvalidError, // Telegram bot token is not valid.
  telegramInvalidSessionError, // Telegram dup login
  slackMissingScopeError, // Slack scope error
];

export function isTelegramAuthIssue(msg: string | null | undefined) {
  return (
    msg?.includes(telegramAuthBytesInvalidError) ||
    msg?.includes(telegramAuthKeyUnregisteredError) ||
    msg?.includes(telegramAuthDuplicatedError) ||
    false
  );
}
