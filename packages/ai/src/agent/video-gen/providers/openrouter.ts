/**
 * OpenRouter Video Generation Provider
 *
 * Provider implementation for OpenRouter video generation via chat completions.
 */

import { VideoGenProvider } from "../base";
import type {
  VideoCapabilities,
  VideoGenerationRequest,
  VideoGenerationResponse,
  VideoModelInfo,
} from "../types";

const OPENROUTER_MODELS: VideoModelInfo[] = [
  {
    id: "kwaivgi/kling-v3.0-pro",
    name: "kwaivgi/kling-v3.0-pro",
    displayName: "Kling 3.0 Pro (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 30,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
  {
    id: "kwaivgi/kling-v3.0-std",
    name: "kwaivgi/kling-v3.0-std",
    displayName: "Kling 3.0 Standard (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 30,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
  {
    id: "google/veo-3.1-fast",
    name: "google/veo-3.1-fast",
    displayName: "Google Veo 3.1 Fast (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 30,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
  {
    id: "google/veo-3.1",
    name: "google/veo-3.1",
    displayName: "Google Veo 3.1 (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 60,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
  {
    id: "minimax/hailuo-2.3",
    name: "minimax/hailuo-2.3",
    displayName: "MiniMax Hailuo 2.3 (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 30,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
  {
    id: "bytedance/seedance-2.0-fast",
    name: "bytedance/seedance-2.0-fast",
    displayName: "ByteDance Seedance 2.0 Fast (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 30,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
  {
    id: "alibaba/wan-2.7",
    name: "alibaba/wan-2.7",
    displayName: "Alibaba Wan 2.7 (OpenRouter)",
    supportedModality: ["text", "image"],
    maxDuration: 30,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedResolutions: ["720p", "1080p"],
  },
];

const OPENROUTER_CAPABILITIES: VideoCapabilities = {
  supportsTextToVideo: true,
  supportsImageToVideo: true,
  supportsAudio: false,
  maxDuration: 30,
  supportedAspectRatios: ["16:9", "9:16", "1:1"],
  supportedResolutions: ["720p", "1080p"],
};

export class OpenRouterVideoGenProvider extends VideoGenProvider {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    super();
    this.baseUrl = "https://openrouter.ai/api/v1";
    this.apiKey = "";
  }

  get name(): string {
    return "openrouter";
  }

  get displayName(): string {
    return "OpenRouter Video";
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey && this.baseUrl);
  }

  listModels(): VideoModelInfo[] {
    return OPENROUTER_MODELS;
  }

  defaultModel(): string | null {
    return this.isAvailable() ? "kwaivgi/kling-v3.0-pro" : null;
  }

  capabilities(): VideoCapabilities {
    return OPENROUTER_CAPABILITIES;
  }

  async generate(
    request: VideoGenerationRequest,
  ): Promise<VideoGenerationResponse> {
    if (!this.isAvailable()) {
      return {
        success: false,
        model: request.model || "kwaivgi/kling-v3.0-pro",
        prompt: request.prompt,
        modality: this.routeModality(request.image_url),
        aspect_ratio: request.aspect_ratio || "16:9",
        duration: request.duration || 10,
        provider: this.name,
        error:
          "OpenRouter API not configured. Save an OpenRouter API key in your AI provider preferences.",
        error_type: "configuration_error",
      };
    }

    const model = request.model || "kwaivgi/kling-v3.0-pro";
    const duration = request.duration || 10;
    const aspectRatio = request.aspect_ratio || "16:9";
    const modality = this.routeModality(request.image_url);

    try {
      // Build request payload for OpenRouter videos API
      const payload: Record<string, unknown> = {
        model: model,
        prompt: request.prompt,
      };

      // Add image_url for image-to-video
      if (request.image_url) {
        payload.image_url = request.image_url;
      }

      // Add optional parameters
      if (request.aspect_ratio) {
        payload.aspect_ratio = request.aspect_ratio;
      }
      if (request.duration) {
        payload.duration = request.duration;
      }
      if (request.resolution) {
        payload.resolution = request.resolution;
      }

      console.log(
        `[OpenRouter Video Gen] Calling ${this.baseUrl}/videos with model=${model}`,
      );

      // Step 1: Submit video generation request
      const response = await fetch(`${this.baseUrl}/videos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[OpenRouter Video Gen] API Error ${response.status}: ${errorText}`,
        );
        console.error(
          "[OpenRouter Video Gen] Request payload:",
          JSON.stringify(payload, null, 2),
        );
        return {
          success: false,
          model: model,
          prompt: request.prompt,
          modality: modality,
          aspect_ratio: aspectRatio,
          duration: duration,
          provider: this.name,
          error: `OpenRouter API error ${response.status}: ${errorText}`,
          error_type: "api_error",
        };
      }

      const submitResult = (await response.json()) as {
        id?: string;
        polling_url?: string;
        error?: string;
      };

      // OpenRouter returns { id, polling_url } for async video generation
      const jobId = submitResult.id;
      const pollingUrl = submitResult.polling_url;

      if (!jobId || !pollingUrl) {
        console.error(
          "[OpenRouter Video Gen] Missing job id or polling_url in response:",
          JSON.stringify(submitResult),
        );
        return {
          success: false,
          model: model,
          prompt: request.prompt,
          modality: modality,
          aspect_ratio: aspectRatio,
          duration: duration,
          provider: this.name,
          error:
            submitResult.error ||
            "Invalid response from OpenRouter: missing job id or polling_url",
          error_type: "api_error",
        };
      }

      console.log(
        `[OpenRouter Video Gen] Job submitted: ${jobId}, polling URL: ${pollingUrl}`,
      );

      // Step 2: Poll for completion
      const maxPollAttempts = 120; // 2 minutes max (120 * 1s)
      const pollIntervalMs = 1000;
      let pollAttempts = 0;

      while (pollAttempts < maxPollAttempts) {
        pollAttempts++;

        const pollResponse = await fetch(pollingUrl, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        });

        if (!pollResponse.ok) {
          const errorText = await pollResponse.text();
          return {
            success: false,
            model: model,
            prompt: request.prompt,
            modality: modality,
            aspect_ratio: aspectRatio,
            duration: duration,
            provider: this.name,
            error: `Polling error ${pollResponse.status}: ${errorText}`,
            error_type: "api_error",
          };
        }

        const statusData = (await pollResponse.json()) as {
          status?: string;
          error?: string;
          unsigned_urls?: string[];
        };

        console.log(
          `[OpenRouter Video Gen] Poll ${pollAttempts}: status=${statusData.status}`,
        );

        if (statusData.status === "completed") {
          const videoUrls = statusData.unsigned_urls || [];
          const videoUrl = videoUrls[0];

          if (!videoUrl) {
            return {
              success: false,
              model: model,
              prompt: request.prompt,
              modality: modality,
              aspect_ratio: aspectRatio,
              duration: duration,
              provider: this.name,
              error: "Video generation completed but no URL returned",
              error_type: "api_error",
            };
          }

          console.log(
            `[OpenRouter Video Gen] Video ready: ${videoUrl.substring(0, 100)}...`,
          );

          return {
            success: true,
            video: videoUrl,
            model: model,
            prompt: request.prompt,
            modality: modality,
            aspect_ratio: aspectRatio,
            duration: duration,
            provider: this.name,
          };
        }

        if (statusData.status === "failed") {
          return {
            success: false,
            model: model,
            prompt: request.prompt,
            modality: modality,
            aspect_ratio: aspectRatio,
            duration: duration,
            provider: this.name,
            error: statusData.error || "Video generation failed",
            error_type: "generation_error",
          };
        }

        // Still processing, wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Timeout - exceeded max poll attempts
      return {
        success: false,
        model: model,
        prompt: request.prompt,
        modality: modality,
        aspect_ratio: aspectRatio,
        duration: duration,
        provider: this.name,
        error: `Video generation timeout after ${maxPollAttempts} polls`,
        error_type: "timeout_error",
      };
    } catch (error) {
      return {
        success: false,
        model: request.model || "kwaivgi/kling-v3.0-pro",
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
