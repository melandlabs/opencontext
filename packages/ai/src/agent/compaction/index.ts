/**
 * @melandlabs/ai - Compaction: conversation compaction logic
 */

export {
	COMPACTION_SOFT_RATIO,
	COMPACTION_HARD_RATIO,
	COMPACTION_EMERGENCY_RATIO,
	COMPACTION_MODEL,
	buildCompactionPrompt,
} from "./compaction";
export type {
	CompactionLevel,
	CompactionPlatform,
	CompactionResult,
} from "./compaction";
export { triggerCompaction, triggerCompactionAsync } from "./compaction-client";
export type {
	CompactionOptions,
	CompactionResponse,
} from "./compaction-client";
export {
	prepareConversationWindows,
	estimateConversationTokens,
	getConversationBucket,
	DEFAULT_CONVERSATION_WINDOW_CONFIG,
} from "./conversation-windows";
export type {
	ConversationWindowMessage,
	ConversationWindowConfig,
	ConversationWindowBucket,
	ConversationWindowResult,
	TokenizedConversationWindowMessage,
	ConversationWindowBucketStats,
	ConversationWindowRole,
} from "./conversation-windows";
