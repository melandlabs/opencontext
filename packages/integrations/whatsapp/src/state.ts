/**
 * WhatsApp State Utilities
 *
 * Pure functions extracted from adapter.ts for testability.
 * No Baileys imports - fully isolated unit test support.
 */

import type { WAMessage } from "@whiskeysockets/baileys";
import type { ExtractedMessageInfo } from "@openloomi/integrations/channels/sources/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Standardized WhatsApp connection states used by the adapter.
 */
export type ConnectionState = "connected" | "connecting" | "disconnected";

/**
 * Standardized message types for routing purposes.
 */
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "other";

/**
 * Result of QR code state parsing.
 */
export type QrCodeState = {
  isValid: boolean;
  codeIndex: number;
};

// ---------------------------------------------------------------------------
// F1: parseQrCodeState
// ---------------------------------------------------------------------------

/**
 * Parses a QR code string from Baileys into validation state and code index.
 *
 * QR strings from Baileys are comma-separated Base64 encoded data.
 * The last segment contains the code index (0-3).
 *
 * @param qrString - Raw QR code string from Baileys onQR callback
 * @returns QrCodeState with validation and index
 *
 * @example
 * parseQrCodeState("xxx,yyy,zzz,0")  // { isValid: true, codeIndex: 0 }
 * parseQrCodeState("xxx,yyy,zzz,5")  // { isValid: false, codeIndex: 5 }
 */
export function parseQrCodeState(qrString: string): QrCodeState {
  if (!qrString || typeof qrString !== "string") {
    return { isValid: false, codeIndex: -1 };
  }

  const parts = qrString.split(",");
  if (parts.length < 4) {
    return { isValid: false, codeIndex: -1 };
  }

  const codeIndexStr = parts[parts.length - 1];
  const codeIndex = Number.parseInt(codeIndexStr, 10);

  if (Number.isNaN(codeIndex)) {
    return { isValid: false, codeIndex: -1 };
  }

  const isValid = codeIndex >= 0 && codeIndex <= 3;
  return { isValid, codeIndex };
}

// ---------------------------------------------------------------------------
// F2: isOwnMessage
// ---------------------------------------------------------------------------

/**
 * Determines whether a message was sent by the bot itself.
 *
 * @param message - Extracted message info
 * @param selfJid - The bot's own JID (user part only)
 * @returns true if the message sender matches the bot's JID
 *
 * @example
 * isOwnMessage({ sender: "alice" }, "alice")  // true
 * isOwnMessage({ sender: "bob" }, "alice")     // false
 * isOwnMessage({ sender: "bob" }, undefined)   // false
 */
export function isOwnMessage(
  message: ExtractedMessageInfo | null | undefined,
  selfJid: string | undefined,
): boolean {
  if (!message || !selfJid) {
    return false;
  }

  return message.sender === selfJid || message.isOutgoing === true;
}

// ---------------------------------------------------------------------------
// F3: routeMessageType
// ---------------------------------------------------------------------------

/**
 * Routes a Baileys WAMessage to a standardized message type.
 *
 * This function provides a single point for message type classification,
 * enabling testable routing logic without Baileys Socket dependencies.
 *
 * @param msg - Raw Baileys message object (expecting { message: {...} })
 * @returns MessageType enum value
 *
 * @example
 * routeMessageType({ message: { conversation: "hello" } })  // "text"
 * routeMessageType({ message: { imageMessage: {} } })        // "image"
 */
export function routeMessageType(msg: unknown): MessageType {
  if (!msg || typeof msg !== "object") {
    return "other";
  }

  const m = msg as Record<string, unknown>;
  const message = m.message as Record<string, unknown> | undefined;

  if (!message) {
    return "other";
  }

  // Text types
  if (message.conversation) return "text";
  if ((message.extendedTextMessage as Record<string, unknown>)?.text)
    return "text";

  // Media types - check presence, not content
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";

  return "other";
}

// ---------------------------------------------------------------------------
// F4: resolveBaileysConnectionState
// ---------------------------------------------------------------------------

/**
 * Maps Baileys connection state strings to adapter's standardized states.
 *
 * @param state - Raw connection state from Baileys Socket
 * @returns Standardized connection state
 *
 * @example
 * resolveBaileysConnectionState("open")        // "connected"
 * resolveBaileysConnectionState("connecting")  // "connecting"
 * resolveBaileysConnectionState("close")       // "disconnected"
 * resolveBaileysConnectionState(null)          // "disconnected"
 */
export function resolveBaileysConnectionState(
  state: "open" | "connecting" | "close" | null | undefined,
): ConnectionState {
  switch (state) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting";
    case "close":
    case null:
    case undefined:
      return "disconnected";
    default:
      return "disconnected";
  }
}
