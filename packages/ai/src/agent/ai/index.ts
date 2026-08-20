/**
 * Public barrel for the agent-side AI surface.
 *
 * Re-exports the agent tree plus the billing / pricing primitives so hosts
 * can import them via `@melandlabs/ai/agent/ai` without reaching into
 * specific sub-trees.
 */

export * from "../index";

// Pricing + model layer
export {
	MODEL_PRICING,
	AUDIO_MODEL_PRICING,
	IMAGE_MODEL_PRICING,
	VIDEO_MODEL_PRICING,
	IMAGE_MODEL_ALIASES,
	type ModelType,
	type ModelPricing,
	type FinalUsage,
	type PromptCacheStats,
	calculateTTSCredits,
	calculateTranscriptionCredits,
	calculateImageCredits,
	calculateInputCredits,
	calculateOutputCredits,
	calculateTotalCredits,
	calculateCreditsLegacy,
	computeFinalCredits,
	getModelPricing,
	getModelMultiplier,
	getAudioModelPricing,
	getImageModelPricing,
	getCanonicalImageModel,
	CREDIT_VALUE_USD,
	BASE_INPUT_TOKENS_PER_CREDIT,
	BASE_OUTPUT_TOKENS_PER_CREDIT,
} from "../billing/model-pricing";

// Provider model functions + user context live alongside `agent/model`.
export {
	getModel,
	getVLMModel,
	createDynamicModel,
	getModelProvider,
	setAIUserContext,
	clearAIUserContext,
	getAIUserContext,
	type AIUserContext,
	type UserType,
	type LLMProviderType,
} from "../model/providers";

// Token / credit helpers (the legacy credit interface)
export {
	INPUT_TOKENS_PER_CREDIT,
	OUTPUT_TOKENS_PER_CREDIT,
	getInputCredits,
	getOutputCredits,
	getTotalCredits,
	estimateTokens,
} from "../billing/tokens";

// Routing layer
export {
	routeModelCall,
	getRecommendedMode,
	type ModelCallOptions,
	type ModelCallResult,
} from "../routing/router";

// Compaction
export {
	COMPACTION_SOFT_RATIO,
	COMPACTION_HARD_RATIO,
	COMPACTION_EMERGENCY_RATIO,
	COMPACTION_MODEL,
	buildCompactionPrompt,
	type CompactionLevel,
	type CompactionPlatform,
	type CompactionResult,
} from "../compaction/compaction";

export {
	triggerCompaction,
	triggerCompactionAsync,
	type CompactionOptions,
	type CompactionResponse,
} from "../compaction/compaction-client";

export {
	prepareConversationWindows,
	estimateConversationTokens,
	getConversationBucket,
	DEFAULT_CONVERSATION_WINDOW_CONFIG,
} from "../compaction/conversation-windows";
export type {
	ConversationWindowMessage,
	ConversationWindowConfig,
	ConversationWindowBucket,
	ConversationWindowResult,
	TokenizedConversationWindowMessage,
	ConversationWindowBucketStats,
	ConversationWindowRole,
} from "../compaction/conversation-windows";
