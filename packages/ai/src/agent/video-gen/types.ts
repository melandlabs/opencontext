/**
 * Video Generation Provider Types
 *
 * Defines the interface and types for video generation providers.
 */

export interface VideoGenerationRequest {
	model?: string;
	prompt: string;
	image_url?: string;
	reference_image_urls?: string[];
	duration?: number;
	aspect_ratio?: string;
	resolution?: string;
	negative_prompt?: string;
	audio?: boolean;
	seed?: number;
	/**
	 * Optional cancellation handle forwarded by the caller. Provider adapters
	 * may attach this to long-running upstream requests so an in-flight
	 * generation can be aborted promptly.
	 */
	signal?: AbortSignal;
}

export type VideoGenerationErrorType =
	| "configuration_error"
	| "api_error"
	| "generation_error"
	| "timeout_error"
	| "provider_not_found"
	| "unknown_error";

export interface VideoGenerationResponse {
	success: boolean;
	video?: string;
	model: string;
	prompt: string;
	modality: "text" | "image";
	aspect_ratio: string;
	duration: number;
	provider: string;
	error?: string;
	error_type?: VideoGenerationErrorType;
}

export interface VideoModelInfo {
	id: string;
	name: string;
	displayName: string;
	supportedModality: ("text" | "image")[];
	maxDuration: number;
	supportedAspectRatios: string[];
	supportedResolutions: string[];
}

export interface VideoCapabilities {
	supportsTextToVideo: boolean;
	supportsImageToVideo: boolean;
	supportsAudio: boolean;
	maxDuration: number;
	supportedAspectRatios: string[];
	supportedResolutions: string[];
}
