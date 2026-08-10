/**
 * Video Generation Provider Base Class
 *
 * Abstract base class for video generation providers.
 */

import type {
  VideoCapabilities,
  VideoGenerationRequest,
  VideoGenerationResponse,
  VideoModelInfo,
} from "./types";

export abstract class VideoGenProvider {
  abstract get name(): string;
  abstract get displayName(): string;

  abstract isAvailable(): boolean;
  abstract listModels(): VideoModelInfo[];
  abstract defaultModel(): string | null;
  abstract capabilities(): VideoCapabilities;

  abstract generate(
    request: VideoGenerationRequest,
  ): Promise<VideoGenerationResponse>;

  protected routeModality(imageUrl?: string): "text" | "image" {
    return imageUrl ? "image" : "text";
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
