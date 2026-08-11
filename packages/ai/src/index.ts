export * from "./types";
export * from "./memory/index";
export * from "./audio";

// Agent barrel — re-exports the full `@melandlabs/ai/agent` surface (types,
// base class, registry, runtime, defineAgentPlugin, StandaloneAgent, etc.).
// Billing / compaction / context / model / routing / utils are intentionally
// NOT re-exported from the agent barrel itself (see the comment in
// `./agent/index.ts`) to avoid duplicate identifiers. Each of them is
// re-imported below from its canonical submodule so existing consumers
// keep their import paths from `@melandlabs/ai`.
export * from "./agent/index";

// Billing (tokens, pricing)
export {
	INPUT_TOKENS_PER_CREDIT,
	OUTPUT_TOKENS_PER_CREDIT,
	MODEL_PRICING,
	CREDIT_VALUE_USD,
	calculateImageCredits,
	calculateInputCredits,
	calculateOutputCredits,
	calculateTotalCredits,
	calculateTranscriptionCredits,
	calculateTTSCredits,
	estimateTokens,
	getAudioModelPricing,
	getCanonicalImageModel,
	getImageModelPricing,
	getInputCredits,
	getModelMultiplier,
	getModelPricing,
	getOutputCredits,
	getTotalCredits,
} from "./agent/billing";
export type { ModelType } from "./agent/billing";

// Compaction
export {
	COMPACTION_EMERGENCY_RATIO,
	COMPACTION_HARD_RATIO,
	COMPACTION_MODEL,
	COMPACTION_SOFT_RATIO,
	buildCompactionPrompt,
	triggerCompaction,
	triggerCompactionAsync,
} from "./agent/compaction";
export type {
	CompactionLevel,
	CompactionOptions,
	CompactionPlatform,
	CompactionResponse,
	CompactionResult,
} from "./agent/compaction";

// Context (conversation windows)
export {
	DEFAULT_CONVERSATION_WINDOW_CONFIG,
	estimateConversationTokens,
	getConversationBucket,
	prepareConversationWindows,
} from "./agent/context";
export type {
	ConversationWindowBucket,
	ConversationWindowBucketStats,
	ConversationWindowConfig,
	ConversationWindowMessage,
	ConversationWindowResult,
	ConversationWindowRole,
	TokenizedConversationWindowMessage,
} from "./agent/context";

// Model providers
export {
	clearAIUserContext,
	createDynamicModel,
	getAIUserContext,
	getModel,
	getModelProvider,
	getVLMModel,
	setAIUserContext,
} from "./agent/model";
export type { AIUserContext, UserType } from "./agent/model";

// Routing
export {
	checkCloudAIAvailability,
	getRecommendedMode,
	routeModelCall,
} from "./agent/routing";
export type { ModelCallOptions, ModelCallResult } from "./agent/routing";

// Utils
export { extractJsonFromMarkdown } from "./agent/utils";
