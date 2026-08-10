/**
 * @melandlabs/integrations-telegram - Telegram integration package
 */

export { TelegramAdapter } from "./adapter";
export { markdownToTelegramHtml } from "./markdown";
export { TelegramConversationStore } from "./conversation-store";

// Re-export types
export type {
	DialogInfo,
	ExtractedMessageInfo,
} from "@melandlabs/integrations/channels/sources/types";
export type {
	TelegramContactMeta,
	ContactMeta,
} from "@melandlabs/integrations/contacts";

// Re-export utility functions
export {
	opencontextMessageToTgText,
	tgMessageToopencontextMessage,
} from "./adapter";
export { withTimeout, CONNECT_TIMEOUT_MS } from "./adapter";
