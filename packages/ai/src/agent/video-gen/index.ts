/**
 * @openloomi/ai - Video Generation Provider
 *
 * Video generation provider abstraction with OpenAI Sora support.
 */

// Types
export type {
  VideoGenerationRequest,
  VideoGenerationResponse,
  VideoModelInfo,
  VideoCapabilities,
} from "./types";

// Base class
export { VideoGenProvider } from "./base";

// Registry
export {
  registerVideoGenProvider,
  getVideoGenProvider,
  getAllVideoGenProviders,
  getDefaultVideoGenProvider,
  generateVideo,
  getVideoGenProviderCapabilities,
} from "./registry";

// OpenAI Provider
export { OpenAIVideoGenProvider } from "./providers/openai";

// OpenRouter Provider
export { OpenRouterVideoGenProvider } from "./providers/openrouter";

// Re-export billing functions for convenience
export {
  calculateVideoCredits,
  VIDEO_MODEL_PRICING,
  VIDEO_MODEL_ALIASES,
  getCanonicalVideoModel,
  getVideoModelPricing,
} from "../billing/model-pricing";
