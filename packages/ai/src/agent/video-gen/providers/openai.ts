/**
 * OpenAI Video Generation Provider
 *
 * Provider implementation for OpenAI Sora video generation.
 */

import { VideoGenProvider } from "../base";
import type {
  VideoCapabilities,
  VideoGenerationRequest,
  VideoGenerationResponse,
  VideoModelInfo,
} from "../types";

const SORA_BASE_URL = "https://api.openai.com/v1";

const SORA_MODELS: VideoModelInfo[] = [
  {
    id: "sora",
    name: "sora",
    displayName: "OpenAI Sora",
    supportedModality: ["text", "image"],
    maxDuration: 20,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["480p", "720p", "1080p"],
  },
  {
    id: "sora-720p",
    name: "sora-720p",
    displayName: "OpenAI Sora 720p",
    supportedModality: ["text", "image"],
    maxDuration: 20,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p"],
  },
  {
    id: "sora-1080p",
    name: "sora-1080p",
    displayName: "OpenAI Sora 1080p",
    supportedModality: ["text", "image"],
    maxDuration: 20,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["1080p"],
  },
];

const SORA_CAPABILITIES: VideoCapabilities = {
  supportsTextToVideo: true,
  supportsImageToVideo: true,
  supportsAudio: false,
  maxDuration: 20,
  supportedAspectRatios: ["16:9", "9:16", "1:1"],
  supportedResolutions: ["480p", "720p", "1080p"],
};

export class OpenAIVideoGenProvider extends VideoGenProvider {
  get name(): string {
    return "openai";
  }

  get displayName(): string {
    return "OpenAI Sora";
  }

  isAvailable(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  listModels(): VideoModelInfo[] {
    return SORA_MODELS;
  }

  defaultModel(): string | null {
    return this.isAvailable() ? "sora" : null;
  }

  capabilities(): VideoCapabilities {
    return SORA_CAPABILITIES;
  }

  async generate(
    request: VideoGenerationRequest,
  ): Promise<VideoGenerationResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        model: request.model || "sora",
        prompt: request.prompt,
        modality: this.routeModality(request.image_url),
        aspect_ratio: request.aspect_ratio || "16:9",
        duration: request.duration || 10,
        provider: this.name,
        error: "OpenAI API key not configured",
        error_type: "configuration_error",
      };
    }

    const model = request.model || "sora";
    const duration = request.duration || 10;
    const aspectRatio = request.aspect_ratio || "16:9";
    const modality = this.routeModality(request.image_url);

    try {
      // Build the request payload for OpenAI Video API
      const payload: Record<string, unknown> = {
        model: model,
        prompt: request.prompt,
      };

      // Add aspect_ratio
      if (aspectRatio === "16:9") {
        payload.aspect_ratio = "16:9";
      } else if (aspectRatio === "9:16") {
        payload.aspect_ratio = "9:16";
      } else if (aspectRatio === "1:1") {
        payload.aspect_ratio = "1:1";
      }

      // Add duration if supported
      if (duration && duration <= 20) {
        payload.duration = duration;
      }

      // Add image_url for image-to-video
      if (request.image_url) {
        payload.image_url = request.image_url;
      }

      // Add reference_image_urls if provided
      if (
        request.reference_image_urls &&
        request.reference_image_urls.length > 0
      ) {
        payload.reference_image_urls = request.reference_image_urls;
      }

      // Add audio if requested
      if (request.audio) {
        payload.audio = true;
      }

      // Add negative_prompt if provided
      if (request.negative_prompt) {
        payload.negative_prompt = request.negative_prompt;
      }

      // Add seed if provided
      if (request.seed !== undefined) {
        payload.seed = request.seed;
      }

      // Add resolution
      if (request.resolution) {
        payload.resolution = request.resolution;
      }

      console.log(
        `[OpenAI Video Gen] Calling ${SORA_BASE_URL}/video/generations with model=${model}`,
      );

      const response = await fetch(`${SORA_BASE_URL}/video/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          model: model,
          prompt: request.prompt,
          modality: modality,
          aspect_ratio: aspectRatio,
          duration: duration,
          provider: this.name,
          error: `OpenAI API error ${response.status}: ${errorText}`,
          error_type: "api_error",
        };
      }

      const result = (await response.json()) as {
        data?: Array<{ url?: string; revised_prompt?: string }>;
      };

      const videoData = result.data?.[0];
      if (!videoData?.url) {
        return {
          success: false,
          model: model,
          prompt: request.prompt,
          modality: modality,
          aspect_ratio: aspectRatio,
          duration: duration,
          provider: this.name,
          error: "No video URL returned from OpenAI API",
          error_type: "api_error",
        };
      }

      return {
        success: true,
        video: videoData.url,
        model: model,
        prompt: request.prompt,
        modality: modality,
        aspect_ratio: aspectRatio,
        duration: duration,
        provider: this.name,
      };
    } catch (error) {
      return {
        success: false,
        model: request.model || "sora",
        prompt: request.prompt,
        modality: modality,
        aspect_ratio: request.aspect_ratio || "16:9",
        duration: request.duration || 10,
        provider: this.name,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        error_type: "unknown_error",
      };
    }
  }
}
