/**
 * WhatsApp Integration Package
 *
 * Platform adapter and utilities for WhatsApp messaging via Baileys WebSocket.
 */

export { WhatsAppAdapter, activeAdapters } from "./adapter";
export type { WhatsAppDialogInfo, WhatsAppUserInfo } from "./adapter";
export { WhatsAppConversationStore } from "./conversation-store";
export { WhatsAppMessageHistoryStore } from "./message-history-store";
export type { PersistedChatInfo } from "./message-history-store";
export { WhatsAppClientRegistry } from "./client-registry";
export { markdownToWhatsApp } from "./markdown";
