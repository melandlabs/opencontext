export type ConnectorAuthPlatform = "telegram" | "whatsapp";

const platformNames: Record<ConnectorAuthPlatform, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

const userActionTimeoutPatterns = [
  /password input timed out/i,
  /verification code timed out/i,
  /qr login timed out/i,
];

// Server routes return getConnectorNetworkAuthErrorMessage() and client UI
// localizes it by running this matcher again. Keep those generated messages
// covered here whenever their wording changes.
// Auth-stage formatting preserves actionable auth messages and codes, while
// connection-stage formatting hides unknown SDK internals behind a fallback.
const networkErrorPatterns = [
  /\[whatsapp\]\s*socket failed to connect within \d+ms/i,
  /\b(socket|connection|connect|request)\b.*\b(timed out|timeout)\b/i,
  /\b(timed out|timeout)\b.*\b(socket|connection|connect|request|qr code)\b/i,
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)\b/i,
  /\bfetch failed\b/i,
  /\bnetworkerror\b/i,
  /\bnetwork error\b/i,
  /failed to connect to (telegram|whatsapp)/i,
  /unable to connect to (telegram|whatsapp)/i,
  /timeout generating qr code/i,
];

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "";
  return String(error);
}

export function getConnectorNetworkAuthErrorMessage(
  platform: ConnectorAuthPlatform,
): string {
  return `Unable to connect to ${platformNames[platform]}. Please check your network connection and try again.`;
}

export function isConnectorAuthNetworkError(error: unknown): boolean {
  const message = errorToMessage(error).trim();
  if (!message) return false;
  if (userActionTimeoutPatterns.some((pattern) => pattern.test(message))) {
    return false;
  }
  return networkErrorPatterns.some((pattern) => pattern.test(message));
}

export function formatConnectorAuthError(
  error: unknown,
  platform: ConnectorAuthPlatform,
  fallback = "Authentication failed. Please try again.",
): string {
  if (isConnectorAuthNetworkError(error)) {
    return getConnectorNetworkAuthErrorMessage(platform);
  }

  const message = errorToMessage(error).trim();
  return message || fallback;
}

export function formatConnectorConnectionError(
  error: unknown,
  platform: ConnectorAuthPlatform,
  fallback = `Failed to connect to ${platformNames[platform]} servers`,
): string {
  if (isConnectorAuthNetworkError(error)) {
    return getConnectorNetworkAuthErrorMessage(platform);
  }

  return fallback;
}
