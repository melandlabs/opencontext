const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 600_000;

export interface WhisperPluginOptions {
	enabled?: boolean;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
}

export interface WhisperTranscriptionInput {
	file: Blob;
	filename?: string;
	model?: string;
	language?: string;
	prompt?: string;
	responseFormat?: "json" | "text" | "verbose_json" | "srt" | "vtt";
	temperature?: number;
	signal?: AbortSignal;
}

export interface WhisperTranscriptionResult {
	text: string;
	raw?: unknown;
}

function normalizeAudioBaseUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) {
		return DEFAULT_OPENAI_AUDIO_BASE_URL;
	}
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

async function readProviderError(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return `Provider returned HTTP ${response.status.toString()}`;
	}

	try {
		const parsed = JSON.parse(text) as {
			error?: { message?: unknown };
			message?: unknown;
		};
		const message =
			typeof parsed.error?.message === "string"
				? parsed.error.message
				: typeof parsed.message === "string"
					? parsed.message
					: null;
		return message ?? text.trim().slice(0, 400);
	} catch {
		return text.trim().slice(0, 400);
	}
}

function createRequestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const abortFromInput = () => controller.abort();

	if (signal) {
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", abortFromInput, { once: true });
		}
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", abortFromInput);
		},
	};
}

export class WhisperPlugin {
	public enabled: boolean;
	public model: string;
	public apiKey?: string;
	public baseUrl: string;
	public timeoutMs: number;

	constructor(options?: WhisperPluginOptions) {
		this.enabled = options?.enabled ?? true;
		this.model = options?.model ?? DEFAULT_TRANSCRIPTION_MODEL;
		this.apiKey = options?.apiKey;
		this.baseUrl = options?.baseUrl ?? DEFAULT_OPENAI_AUDIO_BASE_URL;
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	public get ready(): boolean {
		return this.enabled && Boolean(this.apiKey?.trim());
	}

	public async transcribe(input: WhisperTranscriptionInput): Promise<WhisperTranscriptionResult> {
		if (!this.enabled) {
			throw new Error("Speech-to-text is disabled.");
		}

		const apiKey = this.apiKey?.trim();
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY is not configured for audio APIs.");
		}

		const model = input.model?.trim() || this.model || DEFAULT_TRANSCRIPTION_MODEL;
		const formData = new FormData();
		formData.append("file", input.file, input.filename || "voice-input.wav");
		formData.append("model", model);
		formData.append("response_format", input.responseFormat || "json");

		if (input.language?.trim()) {
			formData.append("language", input.language.trim());
		}
		if (input.prompt?.trim()) {
			formData.append("prompt", input.prompt.trim());
		}
		if (typeof input.temperature === "number" && Number.isFinite(input.temperature)) {
			formData.append("temperature", input.temperature.toString());
		}

		const { signal, cleanup } = createRequestSignal(input.signal, this.timeoutMs);

		try {
			const response = await fetch(`${normalizeAudioBaseUrl(this.baseUrl)}/audio/transcriptions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
				body: formData,
				signal,
			});

			if (!response.ok) {
				throw new Error(await readProviderError(response));
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("application/json")) {
				const data = (await response.json().catch(() => null)) as {
					text?: unknown;
				} | null;
				const text = typeof data?.text === "string" ? data.text.trim() : "";
				if (!text) {
					throw new Error("Transcription response did not include text.");
				}
				return { text, raw: data };
			}

			const text = (await response.text()).trim();
			if (!text) {
				throw new Error("Transcription response was empty.");
			}
			return { text };
		} finally {
			cleanup();
		}
	}
}
