/**
 * Model Pricing Configuration
 *
 * Based on OpenRouter pricing (approximate values as of 2026)
 * Prices are in USD per million tokens
 * Source: https://openrouter.ai/models
 */

export type ModelType =
  | "default"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-sonnet-4.5"
  | "anthropic/claude-opus-4.6"
  | "anthropic/claude-opus-4.7"
  | "anthropic/claude-haiku-4.5"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.4-nano"
  | "openai/gpt-5.4"
  | "openai/gpt-5.4-pro"
  | "openai/gpt-5.5"
  | "openai/gpt-5.5-pro"
  | "google/gemini-3-flash-preview"
  | "google/gemini-3-pro-preview"
  | "google/gemini-3.1-flash-lite-preview"
  | "google/gemini-3.1-pro-preview"
  | "x-ai/grok-4.3"
  | "x-ai/grok-4.20"
  | "deepseek/deepseek-v4-flash"
  | "deepseek/deepseek-v4-pro"
  | "z-ai/glm-5"
  | "z-ai/glm-5.1"
  | "moonshotai/kimi-k2.5"
  | "moonshotai/kimi-k2.6"
  | "minimax/minimax-m2.5"
  | "minimax/minimax-m2.7"
  | "qwen/qwen3.6-plus"
  | "qwen/qwen3.6-flash"
  | "qwen/qwen3.7-max"
  | "xiaomi/mimo-v2.5"
  | "xiaomi/mimo-v2.5-pro"
  | "stepfun/step-3.7-flash"
  | "openrouter/auto"
  | "openrouter/fusion";

/**
 * Routing mode type for OpenRouter Auto Route and Fusion
 */
export type RoutingMode = "direct" | "auto-route" | "fusion";

export interface ModelPricing {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  supportsVision: boolean;
  supportsAudio?: boolean;
  supportsTranscription?: boolean;
}

/**
 * Model pricing configuration based on OpenRouter
 * Source: https://openrouter.ai/models
 */
export const MODEL_PRICING: Record<ModelType, ModelPricing> = {
  default: {
    inputPricePerMillion: 3, // Default to Claude Sonnet pricing
    outputPricePerMillion: 15,
    supportsVision: true,
  },
  "anthropic/claude-sonnet-4.6": {
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    supportsVision: true,
  },
  "anthropic/claude-sonnet-4.5": {
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    supportsVision: true,
  },
  "anthropic/claude-opus-4.6": {
    inputPricePerMillion: 5,
    outputPricePerMillion: 25,
    supportsVision: true,
  },
  "anthropic/claude-opus-4.7": {
    inputPricePerMillion: 5,
    outputPricePerMillion: 25,
    supportsVision: true,
  },
  "anthropic/claude-haiku-4.5": {
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
    supportsVision: true,
  },
  "deepseek/deepseek-v4-flash": {
    inputPricePerMillion: 1.392,
    outputPricePerMillion: 2.784,
    supportsVision: false,
  },
  "deepseek/deepseek-v4-pro": {
    inputPricePerMillion: 1.7,
    outputPricePerMillion: 3.4,
    supportsVision: false,
  },
  "google/gemini-3-flash-preview": {
    inputPricePerMillion: 0.5,
    outputPricePerMillion: 3,
    supportsVision: true,
  },
  "google/gemini-3-pro-preview": {
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
    supportsVision: true,
  },
  "google/gemini-3.1-pro-preview": {
    inputPricePerMillion: 2,
    outputPricePerMillion: 12,
    supportsVision: true,
  },
  "google/gemini-3.1-flash-lite-preview": {
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 1.5,
    supportsVision: true,
  },
  "z-ai/glm-5": {
    inputPricePerMillion: 0.6,
    outputPricePerMillion: 2.08,
    supportsVision: false,
  },
  "z-ai/glm-5.1": {
    inputPricePerMillion: 1.05,
    outputPricePerMillion: 3.5,
    supportsVision: false,
  },
  "x-ai/grok-4.3": {
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 2.5,
    supportsVision: true,
  },
  "x-ai/grok-4.20": {
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 2.5,
    supportsVision: true,
  },
  "moonshotai/kimi-k2.5": {
    inputPricePerMillion: 0.44,
    outputPricePerMillion: 2,
    supportsVision: true,
  },
  "moonshotai/kimi-k2.6": {
    inputPricePerMillion: 0.74,
    outputPricePerMillion: 3.49,
    supportsVision: true,
  },
  "minimax/minimax-m2.5": {
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 1.15,
    supportsVision: false,
  },
  "minimax/minimax-m2.7": {
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 1.2,
    supportsVision: false,
  },
  "openai/gpt-5.4-mini": {
    inputPricePerMillion: 30,
    outputPricePerMillion: 180,
    supportsVision: true,
  },
  "openai/gpt-5.4-nano": {
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 15,
    supportsVision: true,
  },
  "openai/gpt-5.4": {
    inputPricePerMillion: 5,
    outputPricePerMillion: 15,
    supportsVision: true,
  },
  "openai/gpt-5.4-pro": {
    inputPricePerMillion: 30,
    outputPricePerMillion: 180,
    supportsVision: true,
  },
  "openai/gpt-5.5": {
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 1.25,
    supportsVision: true,
  },
  "openai/gpt-5.5-pro": {
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 4.5,
    supportsVision: true,
  },
  "stepfun/step-3.7-flash": {
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.3,
    supportsVision: false,
  },
  "xiaomi/mimo-v2.5": {
    inputPricePerMillion: 0.4,
    outputPricePerMillion: 2,
    supportsVision: true,
    supportsAudio: true,
    supportsTranscription: true,
  },
  "xiaomi/mimo-v2.5-pro": {
    inputPricePerMillion: 1,
    outputPricePerMillion: 3,
    supportsVision: true,
    supportsAudio: true,
    supportsTranscription: true,
  },
  "qwen/qwen3.6-flash": {
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.3,
    supportsVision: false,
  },
  "qwen/qwen3.6-plus": {
    inputPricePerMillion: 0.3,
    outputPricePerMillion: 1,
    supportsVision: true,
  },
  "qwen/qwen3.7-max": {
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 7.5,
    supportsVision: true,
  },
  "openrouter/auto": {
    inputPricePerMillion: 2.5, // Weighted average for auto-selected models
    outputPricePerMillion: 10,
    supportsVision: true,
  },
  "openrouter/fusion": {
    inputPricePerMillion: 8, // 2-3x due to multi-model calls
    outputPricePerMillion: 30,
    supportsVision: true,
  },
};

/**
 * Base conversion rate: 1 credit = $0.0000667 (USD)
 * This means 1 USD = 15,000 credits
 * Based on average model cost ($15/million tokens), 1 credit ≈ 13.33 tokens
 */
export const CREDIT_VALUE_USD = 0.0000667;

/**
 * Base tokens per credit for the default model (Claude Sonnet)
 * Used as reference for backward compatibility
 */
export const BASE_INPUT_TOKENS_PER_CREDIT = 30;
export const BASE_OUTPUT_TOKENS_PER_CREDIT = 3;

/**
 * Calculate credits required for input tokens based on model pricing
 * @param tokens Number of input tokens
 * @param model Model type
 * @returns Number of credits required
 */
export function calculateInputCredits(
  tokens: number,
  model: ModelType = "default",
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
  const costUsd = (tokens / 1_000_000) * pricing.inputPricePerMillion;
  return costUsd / CREDIT_VALUE_USD;
}

/**
 * Calculate credits required for output tokens based on model pricing
 * @param tokens Number of output tokens
 * @param model Model type
 * @returns Number of credits required
 */
export function calculateOutputCredits(
  tokens: number,
  model: ModelType = "default",
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
  const costUsd = (tokens / 1_000_000) * pricing.outputPricePerMillion;
  return costUsd / CREDIT_VALUE_USD;
}

/**
 * Calculate total credits for input and output tokens
 * @param inputTokens Number of input tokens
 * @param outputTokens Number of output tokens
 * @param model Model type
 * @returns Total credits required
 */
export function calculateTotalCredits(
  inputTokens: number,
  outputTokens: number,
  model: ModelType = "default",
): number {
  return (
    calculateInputCredits(inputTokens, model) +
    calculateOutputCredits(outputTokens, model)
  );
}

/**
 * Get pricing information for a model
 * @param model Model type
 * @returns Model pricing information
 */
export function getModelPricing(model: ModelType = "default"): ModelPricing {
  return MODEL_PRICING[model] || MODEL_PRICING.default;
}

/**
 * Get the multiplier for a model relative to the default model
 * @param model Model type
 * @returns Multiplier (e.g., 1.0 for default, 5.0 for models 5x more expensive)
 */
export function getModelMultiplier(model: ModelType = "default"): number {
  const defaultPricing = MODEL_PRICING.default;
  const modelPricing = MODEL_PRICING[model] || defaultPricing;

  const defaultAvg =
    (defaultPricing.inputPricePerMillion +
      defaultPricing.outputPricePerMillion) /
    2;
  const modelAvg =
    (modelPricing.inputPricePerMillion + modelPricing.outputPricePerMillion) /
    2;

  return modelAvg / defaultAvg;
}

// ============================================================
// Audio Model Pricing
// ============================================================

/**
 * Audio model pricing configuration
 * whisper-1: transcription, 30 credits/minute
 * tts-1: tts, 0.5 credits/character
 * tts-1-hd: tts, 0.8 credits/character
 */
export const AUDIO_MODEL_PRICING: Record<
  string,
  { type: "transcription" | "tts"; creditsPerUnit: number; description: string }
> = {
  "whisper-1": {
    type: "transcription",
    creditsPerUnit: 30, // 30 credits per minute
    description: "Whisper-1 transcription model",
  },
  "tts-1": {
    type: "tts",
    creditsPerUnit: 0.5, // 0.5 credits per character
    description: "TTS-1 standard quality",
  },
  "tts-1-hd": {
    type: "tts",
    creditsPerUnit: 0.8, // 0.8 credits per character
    description: "TTS-1 HD high quality",
  },
};

/**
 * Calculate credits for audio transcription
 * @param durationSeconds Audio duration in seconds
 * @param model Model name (default: whisper-1)
 * @returns Credits required
 */
export function calculateTranscriptionCredits(
  durationSeconds: number,
  model: string = "whisper-1",
): number {
  const pricing =
    AUDIO_MODEL_PRICING[model] || AUDIO_MODEL_PRICING["whisper-1"];
  const minutes = durationSeconds / 60;
  return Math.ceil(minutes * pricing.creditsPerUnit);
}

/**
 * Calculate credits for TTS generation
 * @param characterCount Number of characters to synthesize
 * @param model Model name (default: tts-1)
 * @returns Credits required
 */
export function calculateTTSCredits(
  characterCount: number,
  model: string = "tts-1",
): number {
  const pricing = AUDIO_MODEL_PRICING[model] || AUDIO_MODEL_PRICING["tts-1"];
  return Math.ceil(characterCount * pricing.creditsPerUnit);
}

/**
 * Get audio model pricing info
 */
export function getAudioModelPricing(
  model: string,
): (typeof AUDIO_MODEL_PRICING)[keyof typeof AUDIO_MODEL_PRICING] | null {
  return AUDIO_MODEL_PRICING[model] || null;
}

// ============================================================
// Image Model Pricing
// ============================================================

/**
 * Image model ID aliases - maps common names to canonical model IDs
 */
export const IMAGE_MODEL_ALIASES: Record<string, string> = {
  "flux-pro": "black-forest-labs/flux-2-pro",
  "flux-schnell": "black-forest-labs/flux-1-schnell",
  "flux-dev": "black-forest-labs/flux-1-dev",
  "dall-e-3": "openai/dall-e-3",
  "dall-e-2": "openai/dall-e-2",
  "gpt-5-image": "openai/gpt-5-image",
  "imagen-3": "google/imagen-3",
  "imagen-3-fast": "google/imagen-3-fast",
  "gemini-2-flash-image": "google/gemini-2-flash-image-preview",
  "gemini-3-pro-image": "google/gemini-3-pro-image-preview",
};

/**
 * Image model pricing configuration
 * Credits per image for standard quality at base size
 * 1 credit ≈ $0.0000667 (USD) based on CREDIT_VALUE_USD
 */
export const IMAGE_MODEL_PRICING: Record<
  string,
  { creditsPerImage: number; hdMultiplier: number; description: string }
> = {
  // Black Forest Labs - Flux (Replicate/OpenRouter)
  "black-forest-labs/flux-2-pro": {
    creditsPerImage: 750, // ~$0.05/image
    hdMultiplier: 2,
    description: "FLUX.2 Pro (schnell, realistic, high quality)",
  },
  "black-forest-labs/flux-1-schnell": {
    creditsPerImage: 150, // ~$0.01/image
    hdMultiplier: 2,
    description: "FLUX.1 Schnell (fast generation)",
  },
  "black-forest-labs/flux-1-dev": {
    creditsPerImage: 300, // ~$0.02/image
    hdMultiplier: 2,
    description: "FLUX.1 Dev (open-weight, non-commercial)",
  },

  // OpenAI - DALL-E / GPT Image
  "openai/dall-e-3": {
    creditsPerImage: 600, // ~$0.04/image
    hdMultiplier: 2,
    description: "DALL-E 3 (high quality, strict content)",
  },
  "openai/dall-e-2": {
    creditsPerImage: 300, // ~$0.02/image
    hdMultiplier: 2,
    description: "DALL-E 2",
  },
  "openai/gpt-5-image": {
    creditsPerImage: 600, // ~$0.04/image (estimated)
    hdMultiplier: 2,
    description: "GPT-5 Image Generation",
  },

  // Google - Imagen / Gemini Image
  "google/imagen-3": {
    creditsPerImage: 450, // ~$0.03/image
    hdMultiplier: 2,
    description: "Imagen 3 (photorealistic, text rendering)",
  },
  "google/imagen-3-fast": {
    creditsPerImage: 150, // ~$0.01/image
    hdMultiplier: 2,
    description: "Imagen 3 Fast",
  },
  "google/gemini-2-flash-image-preview": {
    creditsPerImage: 300, // ~$0.02/image
    hdMultiplier: 2,
    description: "Gemini 2.0 Flash Image",
  },
  "google/gemini-3-pro-image-preview": {
    creditsPerImage: 450, // ~$0.03/image
    hdMultiplier: 2,
    description: "Gemini 3.0 Pro Image",
  },

  // Default fallback
  default: {
    creditsPerImage: 750, // ~$0.05/image
    hdMultiplier: 2,
    description: "Default image model",
  },
};

/**
 * Get canonical model name from alias
 */
export function getCanonicalImageModel(model: string): string {
  const lower = model.toLowerCase();
  return IMAGE_MODEL_ALIASES[lower] || IMAGE_MODEL_ALIASES[model] || model;
}

/**
 * Calculate credits for image generation
 * @param model Image model name (supports aliases)
 * @param imageCount Number of images to generate
 * @param quality Quality level ("standard" | "hd")
 * @returns Credits required (rounded up)
 */
export function calculateImageCredits(
  model: string,
  imageCount = 1,
  quality: "standard" | "hd" = "standard",
): number {
  const canonical = getCanonicalImageModel(model);
  const pricing = IMAGE_MODEL_PRICING[canonical] || IMAGE_MODEL_PRICING.default;

  const qualityMultiplier = quality === "hd" ? pricing.hdMultiplier : 1;
  return Math.ceil(imageCount * pricing.creditsPerImage * qualityMultiplier);
}

/**
 * Get image model pricing info
 */
export function getImageModelPricing(
  model: string,
): (typeof IMAGE_MODEL_PRICING)[keyof typeof IMAGE_MODEL_PRICING] {
  const canonical = getCanonicalImageModel(model);
  return IMAGE_MODEL_PRICING[canonical] || IMAGE_MODEL_PRICING.default;
}

// ============================================================
// Video Model Pricing
// ============================================================

/**
 * Video model ID aliases - maps common names to canonical model IDs
 */
export const VIDEO_MODEL_ALIASES: Record<string, string> = {
  "kling-v3.0-pro": "kwaivgi/kling-v3.0-pro",
  "kling-v3.0-std": "kwaivgi/kling-v3.0-std",
  "veo-3.1-fast": "google/veo-3.1-fast",
  "veo-3.1": "google/veo-3.1",
  "hailuo-2.3": "minimax/hailuo-2.3",
  "seedance-2.0-fast": "bytedance/seedance-2.0-fast",
  "wan-2.7": "alibaba/wan-2.7",
};

/**
 * Video model pricing configuration
 * Credits per second of video generated
 * 1 credit ≈ $0.0000667 (USD) based on CREDIT_VALUE_USD
 */
export const VIDEO_MODEL_PRICING: Record<
  string,
  { creditsPerSecond: number; description: string }
> = {
  // OpenRouter Video Models
  // Pricing based on OpenRouter market rates (approximate)
  // 1 credit ≈ $0.0000667 (USD)
  "kwaivgi/kling-v3.0-pro": {
    creditsPerSecond: 500,
    description: "Kling 3.0 Pro (OpenRouter)",
  },
  "kwaivgi/kling-v3.0-std": {
    creditsPerSecond: 300,
    description: "Kling 3.0 Standard (OpenRouter)",
  },
  "google/veo-3.1-fast": {
    creditsPerSecond: 400,
    description: "Google Veo 3.1 Fast (OpenRouter)",
  },
  "google/veo-3.1": {
    creditsPerSecond: 800,
    description: "Google Veo 3.1 (OpenRouter)",
  },

  // MiniMax Hailuo
  "minimax/hailuo-2.3": {
    creditsPerSecond: 200,
    description: "MiniMax Hailuo 2.3 (OpenRouter)",
  },

  // ByteDance Seedance
  "bytedance/seedance-2.0-fast": {
    creditsPerSecond: 200,
    description: "ByteDance Seedance 2.0 Fast (OpenRouter)",
  },

  // Alibaba Wan
  "alibaba/wan-2.7": {
    creditsPerSecond: 400,
    description: "Alibaba Wan 2.7 (OpenRouter)",
  },

  // Default fallback
  default: {
    creditsPerSecond: 300,
    description: "Default video model",
  },
};

/**
 * Get canonical model name from alias
 */
export function getCanonicalVideoModel(model: string): string {
  const lower = model.toLowerCase();
  return VIDEO_MODEL_ALIASES[lower] || VIDEO_MODEL_ALIASES[model] || model;
}

/**
 * Calculate credits for video generation
 * @param model Video model name (supports aliases)
 * @param durationSeconds Duration of video in seconds
 * @returns Credits required (rounded up)
 */
export function calculateVideoCredits(
  model: string,
  durationSeconds: number,
): number {
  const canonical = getCanonicalVideoModel(model);
  const pricing = VIDEO_MODEL_PRICING[canonical] || VIDEO_MODEL_PRICING.default;
  return Math.ceil(durationSeconds * pricing.creditsPerSecond);
}

/**
 * Get video model pricing info
 */
export function getVideoModelPricing(
  model: string,
): (typeof VIDEO_MODEL_PRICING)[keyof typeof VIDEO_MODEL_PRICING] {
  const canonical = getCanonicalVideoModel(model);
  return VIDEO_MODEL_PRICING[canonical] || VIDEO_MODEL_PRICING.default;
}

// ============================================================
// Prompt Cache Pricing
// ============================================================

/**
 * Prompt cache pricing multipliers (Anthropic)
 * 5m cache writes cost 25% more than normal input tokens
 * 1h cache writes cost 100% more (2x) than normal input tokens
 * Cache reads cost 90% less than normal input tokens
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Statistics for prompt cache usage and cost savings
 */
export interface PromptCacheStats {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation1hTokens: number;
  cacheCreation5mTokens: number;
  cacheHitRate: number; // 0-1, ratio of cache_read to total input tokens
  creditsSaved: number; // credits saved by cache reads vs full price
  creditsWithoutCache: number; // hypothetical cost if no caching
  creditsWithCache: number; // actual cost with caching
}

/**
 * Calculate prompt cache statistics including cost savings
 *
 * Note on inputTokens: The Anthropic SDK reports inputTokens as the count of
 * non-cached input tokens only. Total input = inputTokens + cacheCreationInputTokens + cacheReadInputTokens.
 *
 * @param usage Token usage including cache breakdown
 * @param model Model type for pricing lookup
 * @returns PromptCacheStats with hit rate, actual cost, and savings
 */
export function calculatePromptCacheStats(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    cacheCreation1hTokens?: number;
    cacheCreation5mTokens?: number;
  },
  model: ModelType = "default",
): PromptCacheStats {
  const {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheCreation1hTokens = 0,
    cacheCreation5mTokens = 0,
  } = usage;

  // Total input tokens = non-cached + cache write + cache read
  const totalInputTokens =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

  // Cache hit rate: proportion of input served from cache
  const cacheHitRate =
    totalInputTokens > 0 ? cacheReadInputTokens / totalInputTokens : 0;

  // Hypothetical cost without caching: all input at full price
  const creditsWithoutCache =
    calculateInputCredits(totalInputTokens, model) +
    calculateOutputCredits(outputTokens, model);

  // Separate 1h and 5m cache write costs (different pricing tiers)
  // Remainder (tokens not accounted for by 1h/5m breakdown) uses the
  // cheaper 5m rate as a conservative fallback — avoids overreporting
  // savings when the TTL split is unavailable or a new tier appears.
  const remainderWriteTokens = Math.max(
    0,
    cacheCreationInputTokens - cacheCreation1hTokens - cacheCreation5mTokens,
  );
  const cacheWriteCredits =
    calculateInputCredits(cacheCreation1hTokens, model) *
      CACHE_WRITE_1H_MULTIPLIER +
    calculateInputCredits(cacheCreation5mTokens, model) *
      CACHE_WRITE_5M_MULTIPLIER +
    calculateInputCredits(remainderWriteTokens, model) *
      CACHE_WRITE_5M_MULTIPLIER;

  const creditsWithCache =
    calculateInputCredits(inputTokens, model) +
    cacheWriteCredits +
    calculateInputCredits(cacheReadInputTokens, model) * CACHE_READ_MULTIPLIER +
    calculateOutputCredits(outputTokens, model);

  const creditsSaved = creditsWithoutCache - creditsWithCache;

  return {
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheCreation1hTokens,
    cacheCreation5mTokens,
    cacheHitRate,
    creditsSaved,
    creditsWithoutCache,
    creditsWithCache,
  };
}

/**
 * Legacy backward compatibility: calculate credits using simple ratio
 */
export function calculateCreditsLegacy(
  inputTokens: number,
  outputTokens: number,
  model?: ModelType,
): number {
  if (model && model !== "default") {
    return calculateTotalCredits(inputTokens, outputTokens, model);
  }
  return (
    inputTokens / BASE_INPUT_TOKENS_PER_CREDIT +
    outputTokens / BASE_OUTPUT_TOKENS_PER_CREDIT
  );
}
