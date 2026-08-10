/**
 * Video Generation Provider Registry
 *
 * Registry for video generation providers with plugin-style registration.
 */

import type { VideoGenProvider } from "./base";
import type {
  VideoCapabilities,
  VideoGenerationRequest,
  VideoGenerationResponse,
} from "./types";

const providers = new Map<string, VideoGenProvider>();

export function registerVideoGenProvider(provider: VideoGenProvider): void {
  providers.set(provider.name, provider);
}

export function getVideoGenProvider(
  name: string,
): VideoGenProvider | undefined {
  return providers.get(name);
}

export function getAllVideoGenProviders(): VideoGenProvider[] {
  return Array.from(providers.values());
}

export function getDefaultVideoGenProvider(): VideoGenProvider | undefined {
  for (const provider of providers.values()) {
    if (provider.isAvailable()) {
      return provider;
    }
  }
  return undefined;
}

export async function generateVideo(
  request: VideoGenerationRequest,
): Promise<VideoGenerationResponse> {
  const modelName = request.model || "openai";
  const provider =
    getVideoGenProvider(modelName) || getDefaultVideoGenProvider();

  if (!provider) {
    return {
      success: false,
      model: modelName,
      prompt: request.prompt,
      modality: request.image_url ? "image" : "text",
      aspect_ratio: request.aspect_ratio || "16:9",
      duration: request.duration || 10,
      provider: "unknown",
      error: "No video generation provider available",
      error_type: "provider_not_found",
    };
  }

  return provider.generate(request);
}

export function getVideoGenProviderCapabilities(
  name: string,
): VideoCapabilities | null {
  const provider = getVideoGenProvider(name);
  if (!provider) {
    return null;
  }
  return provider.capabilities();
}
