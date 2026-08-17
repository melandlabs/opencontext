const DEFAULT_SPEECH_ENDPOINT = "/api/ai/v1/audio/speech";
const DEFAULT_FALLBACK_VOICE = "af_bella";
const DEFAULT_WARMUP_TEXT = "Hi.";
const FIRST_SPEECH_CHUNK_TARGET_LENGTH = 160;
const FIRST_SPEECH_CHUNK_MAX_LENGTH = 220;
const SPEECH_CHUNK_TARGET_LENGTH = 280;
const SPEECH_CHUNK_MAX_LENGTH = 420;
const MIN_SPEECH_CHUNK_BREAK_LENGTH = 80;
const MIN_FINAL_SPEECH_CHUNK_LENGTH = 40;
const HARD_SPEECH_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";"]);
const SOFT_SPEECH_BOUNDARIES = new Set(["，", ",", "、", "：", ":", ")", "）"]);
const CLOSING_BOUNDARY_CHARACTERS = new Set(['"', "'", ")", "]", "}", "”", "’", "）", "】", "》"]);

type SpeechFetchResult = { ok: true; audioBlob: Blob } | { ok: false; error: unknown };

function getNowMs(): number {
	if (typeof performance !== "undefined") {
		return performance.now();
	}
	return Date.now();
}

function normalizeSpeechText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isDigit(value: string | undefined): boolean {
	return Boolean(value && /\d/.test(value));
}

function findNextMeaningfulCharacter(text: string, index: number): string {
	let nextIndex = index + 1;
	while (CLOSING_BOUNDARY_CHARACTERS.has(text[nextIndex])) {
		nextIndex += 1;
	}
	return text[nextIndex] ?? "";
}

function isSentencePeriod(text: string, index: number): boolean {
	const previousCharacter = text[index - 1];
	const nextCharacter = findNextMeaningfulCharacter(text, index);

	if (isDigit(previousCharacter) && isDigit(text[index + 1])) {
		return false;
	}

	return !nextCharacter || /\s/.test(nextCharacter);
}

function isHardSpeechBoundary(text: string, index: number): boolean {
	const character = text[index];
	return HARD_SPEECH_BOUNDARIES.has(character) || (character === "." && isSentencePeriod(text, index));
}

function isSoftSpeechBoundary(text: string, index: number): boolean {
	const character = text[index];
	if (!SOFT_SPEECH_BOUNDARIES.has(character)) return false;
	if (character === "," && isDigit(text[index - 1]) && isDigit(text[index + 1])) {
		return false;
	}
	if (character === ":" && text[index + 1] === "/") {
		return false;
	}
	return true;
}

function extendBoundaryEnd(text: string, index: number): number {
	let endIndex = index + 1;
	while (CLOSING_BOUNDARY_CHARACTERS.has(text[endIndex])) {
		endIndex += 1;
	}
	return endIndex;
}

function findLastBoundary(
	text: string,
	startIndex: number,
	endIndex: number,
	predicate: (value: string, index: number) => boolean,
): number | null {
	const boundedEndIndex = Math.min(endIndex, text.length - 1);
	for (let index = boundedEndIndex; index >= startIndex; index -= 1) {
		if (predicate(text, index)) {
			return extendBoundaryEnd(text, index);
		}
	}
	return null;
}

function findFirstBoundary(
	text: string,
	startIndex: number,
	endIndex: number,
	predicate: (value: string, index: number) => boolean,
): number | null {
	const boundedEndIndex = Math.min(endIndex, text.length - 1);
	for (let index = startIndex; index <= boundedEndIndex; index += 1) {
		if (predicate(text, index)) {
			return extendBoundaryEnd(text, index);
		}
	}
	return null;
}

function findWhitespaceBoundary(
	text: string,
	startIndex: number,
	endIndex: number,
	direction: "first" | "last",
): number | null {
	const boundedEndIndex = Math.min(endIndex, text.length - 1);

	if (direction === "first") {
		for (let index = startIndex; index <= boundedEndIndex; index += 1) {
			if (/\s/.test(text[index])) return index;
		}
		return null;
	}

	for (let index = boundedEndIndex; index >= startIndex; index -= 1) {
		if (/\s/.test(text[index])) return index;
	}
	return null;
}

function findSpeechBreakIndex(text: string, targetLength: number, maxLength: number): number {
	const minBreakLength = Math.min(MIN_SPEECH_CHUNK_BREAK_LENGTH, Math.max(1, targetLength - 1));
	const beforeTarget = Math.min(targetLength, text.length - 1);
	const beforeMax = Math.min(maxLength, text.length - 1);

	return (
		findLastBoundary(text, minBreakLength, beforeTarget, isHardSpeechBoundary) ??
		findFirstBoundary(text, targetLength, beforeMax, isHardSpeechBoundary) ??
		findLastBoundary(text, minBreakLength, beforeTarget, isSoftSpeechBoundary) ??
		findFirstBoundary(text, targetLength, beforeMax, isSoftSpeechBoundary) ??
		findWhitespaceBoundary(text, minBreakLength, beforeTarget, "last") ??
		findWhitespaceBoundary(text, targetLength, beforeMax, "first") ??
		maxLength
	);
}

function mergeShortFinalSpeechChunk(chunks: string[]): string[] {
	if (chunks.length < 2) return chunks;

	const lastChunk = chunks[chunks.length - 1];
	if (lastChunk.length >= MIN_FINAL_SPEECH_CHUNK_LENGTH) {
		return chunks;
	}

	const previousChunk = chunks[chunks.length - 2];
	const mergedChunk = `${previousChunk} ${lastChunk}`.trim();
	if (mergedChunk.length > SPEECH_CHUNK_MAX_LENGTH) {
		return chunks;
	}

	return [...chunks.slice(0, -2), mergedChunk];
}

function splitSpeechText(text: string): string[] {
	let remainingText = normalizeSpeechText(text);
	const chunks: string[] = [];

	while (remainingText) {
		const isFirstChunk = chunks.length === 0;
		const targetLength = isFirstChunk ? FIRST_SPEECH_CHUNK_TARGET_LENGTH : SPEECH_CHUNK_TARGET_LENGTH;
		const maxLength = isFirstChunk ? FIRST_SPEECH_CHUNK_MAX_LENGTH : SPEECH_CHUNK_MAX_LENGTH;

		if (remainingText.length <= maxLength) {
			chunks.push(remainingText);
			break;
		}

		const breakIndex = findSpeechBreakIndex(remainingText, targetLength, maxLength);
		const chunk = remainingText.slice(0, breakIndex).trim();
		if (chunk) {
			chunks.push(chunk);
		}
		remainingText = remainingText.slice(breakIndex).trim();
	}

	return mergeShortFinalSpeechChunk(chunks);
}

function isKokoroDebugEnabled(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage?.getItem("opencontext:kokoro-debug") === "1";
	} catch {
		return false;
	}
}

function stripFencedCodeBlocks(text: string): string {
	const outputLines: string[] = [];
	let activeFence: { marker: string; length: number } | null = null;

	for (const line of text.split(/\r?\n/)) {
		const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

		if (activeFence) {
			const isClosingFence =
				fenceMatch &&
				fenceMatch[1][0] === activeFence.marker &&
				fenceMatch[1].length >= activeFence.length &&
				fenceMatch[2].trim().length === 0;

			if (isClosingFence) {
				activeFence = null;
			}
			continue;
		}

		if (fenceMatch) {
			activeFence = {
				marker: fenceMatch[1][0],
				length: fenceMatch[1].length,
			};
			continue;
		}

		outputLines.push(line);
	}

	return outputLines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function getBrowserSpeechSynthesis(): SpeechSynthesis | null {
	if (typeof window === "undefined") return null;
	if (!("speechSynthesis" in window)) return null;
	return window.speechSynthesis;
}

export class KokoroPlugin {
	public enabled: boolean;
	public voice: string;

	private speechEndpoint: string;
	private currentRequestController: AbortController | null;
	private currentWarmupController: AbortController | null;
	private currentAudio: HTMLAudioElement | null;
	private currentObjectUrl: string | null;
	private currentPlaybackAbort: (() => void) | null;
	private hasWarmedUp: boolean;
	private warmupPromise: Promise<void> | null;
	private speechRunId: number;

	constructor(options?: { enabled?: boolean; voice?: string }) {
		this.enabled = options?.enabled ?? true;
		this.voice = options?.voice ?? DEFAULT_FALLBACK_VOICE;
		this.speechEndpoint = DEFAULT_SPEECH_ENDPOINT;
		this.currentRequestController = null;
		this.currentWarmupController = null;
		this.currentAudio = null;
		this.currentObjectUrl = null;
		this.currentPlaybackAbort = null;
		this.hasWarmedUp = false;
		this.warmupPromise = null;
		this.speechRunId = 0;
	}

	public stop(): void {
		this.speechRunId += 1;
		this.currentRequestController?.abort();
		this.currentRequestController = null;
		this.currentWarmupController?.abort();
		this.currentWarmupController = null;

		this.currentPlaybackAbort?.();
		this.currentPlaybackAbort = null;

		if (this.currentAudio) {
			this.currentAudio.pause();
			this.currentAudio.removeAttribute("src");
			this.currentAudio.load();
			this.currentAudio = null;
		}

		if (this.currentObjectUrl) {
			URL.revokeObjectURL(this.currentObjectUrl);
			this.currentObjectUrl = null;
		}

		const synthesis = getBrowserSpeechSynthesis();
		if (synthesis) {
			synthesis.cancel();
		}
	}

	public async warmup(text: string = DEFAULT_WARMUP_TEXT): Promise<void> {
		if (!this.enabled || this.hasWarmedUp) return;

		const input = text.trim();
		if (!input) return;

		if (typeof window === "undefined") {
			return;
		}

		if (this.warmupPromise) {
			return this.warmupPromise;
		}

		const warmupPromise = this.runWarmup(input);
		this.warmupPromise = warmupPromise;
		return warmupPromise;
	}

	public async speak(text: string): Promise<void> {
		if (!this.enabled) {
			// biome-ignore lint/suspicious/noConsole: intentional user-facing disabled message
			console.log("[KokoroPlugin] Disabled, skipping TTS.");
			return;
		}

		const input = stripFencedCodeBlocks(text);
		const chunks = splitSpeechText(input);
		if (chunks.length === 0) return;

		if (typeof window === "undefined") {
			// biome-ignore lint/suspicious/noConsole: intentional user-facing browser API warning
			console.warn("[KokoroPlugin] Browser APIs are unavailable.");
			return;
		}

		this.stop();
		const runId = this.speechRunId;
		let didStartRemotePlayback = false;

		try {
			await this.speakViaRemoteService(chunks, runId, () => {
				didStartRemotePlayback = true;
			});
			return;
		} catch (error) {
			if (isAbortError(error)) {
				return;
			}

			this.stop();
			// biome-ignore lint/suspicious/noConsole: intentional user-facing remote TTS warning
			console.warn("[KokoroPlugin] Remote TTS unavailable:", error);
			if (didStartRemotePlayback) {
				return;
			}

			if (this.speakViaBrowser(input)) {
				return;
			}

			throw error;
		}
	}

	private async speakViaRemoteService(
		chunks: string[],
		runId: number,
		onPlaybackStart: () => void,
	): Promise<void> {
		if (typeof fetch !== "function") {
			throw new Error("Fetch is not available for Kokoro TTS.");
		}

		const startedAtMs = getNowMs();
		let firstAudioReadyMs: number | null = null;
		let firstPlaybackStartedMs: number | null = null;
		let nextFetchPromise: Promise<SpeechFetchResult> | null = null;

		this.logDebug("Queued TTS started.", {
			chunks: chunks.length,
			firstChunkLength: chunks[0]?.length ?? 0,
			totalLength: chunks.reduce((total, chunk) => total + chunk.length, 0),
		});

		for (let index = 0; index < chunks.length; index += 1) {
			if (runId !== this.speechRunId) {
				throw new DOMException("Kokoro TTS request was aborted.", "AbortError");
			}

			const currentFetchPromise = nextFetchPromise ?? this.prefetchSpeechBlob(chunks[index], runId);
			nextFetchPromise = null;

			const result = await currentFetchPromise;
			if (result.ok === false) {
				throw result.error;
			}

			if (index === 0) {
				firstAudioReadyMs = getNowMs() - startedAtMs;
			}

			if (runId !== this.speechRunId) {
				throw new DOMException("Kokoro TTS request was aborted.", "AbortError");
			}

			const nextChunk = chunks[index + 1];
			if (nextChunk) {
				nextFetchPromise = this.prefetchSpeechBlob(nextChunk, runId);
			}

			await this.playAudioBlob(result.audioBlob, () => {
				if (index === 0) {
					firstPlaybackStartedMs = getNowMs() - startedAtMs;
					onPlaybackStart();
					this.logDebug("Queued TTS first chunk playing.", {
						firstAudioReadyMs: Math.round(firstAudioReadyMs ?? 0),
						firstPlaybackStartedMs: Math.round(firstPlaybackStartedMs),
					});
				}
			});
		}

		this.logDebug("Queued TTS finished.", {
			chunks: chunks.length,
			firstAudioReadyMs: Math.round(firstAudioReadyMs ?? 0),
			firstPlaybackStartedMs: Math.round(firstPlaybackStartedMs ?? 0),
			totalMs: Math.round(getNowMs() - startedAtMs),
		});
	}

	private prefetchSpeechBlob(text: string, runId: number): Promise<SpeechFetchResult> {
		return this.fetchSpeechBlobForPlayback(text, runId)
			.then((audioBlob) => ({ ok: true as const, audioBlob }))
			.catch((error) => ({ ok: false as const, error }));
	}

	private async fetchSpeechBlobForPlayback(text: string, runId: number): Promise<Blob> {
		const controller = new AbortController();
		this.currentRequestController = controller;

		try {
			const audioBlob = await this.fetchSpeechBlob(text, controller.signal);
			if (runId !== this.speechRunId) {
				throw new DOMException("Kokoro TTS request was aborted.", "AbortError");
			}
			this.logDebug("Queued TTS chunk fetched.", {
				length: text.length,
				size: audioBlob.size,
			});
			return audioBlob;
		} finally {
			if (this.currentRequestController === controller) {
				this.currentRequestController = null;
			}
		}
	}

	private async runWarmup(text: string): Promise<void> {
		const controller = new AbortController();
		this.currentWarmupController = controller;

		try {
			await this.fetchSpeechBlob(text, controller.signal);
			this.hasWarmedUp = true;
		} catch (error) {
			if (isAbortError(error)) {
				return;
			}
			throw error;
		} finally {
			if (this.currentWarmupController === controller) {
				this.currentWarmupController = null;
			}
			this.warmupPromise = null;
		}
	}

	private async fetchSpeechBlob(text: string, signal: AbortSignal): Promise<Blob> {
		if (typeof fetch !== "function") {
			throw new Error("Fetch is not available for Kokoro TTS.");
		}

		const response = await fetch(this.speechEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				input: text,
				voice: this.voice === DEFAULT_FALLBACK_VOICE ? undefined : this.voice,
			}),
			signal,
		});

		if (!response.ok) {
			throw new Error(await this.readProviderError(response));
		}

		const audioBlob = await response.blob();
		if (audioBlob.size <= 0) {
			throw new Error("Kokoro TTS response was empty.");
		}

		return audioBlob;
	}

	private async playAudioBlob(audioBlob: Blob, onPlaybackStart?: () => void): Promise<void> {
		if (typeof Audio === "undefined") {
			throw new Error("Browser audio playback is not available.");
		}

		const objectUrl = URL.createObjectURL(audioBlob);
		const audio = new Audio(objectUrl);
		audio.preload = "auto";
		audio.autoplay = true;
		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const cleanup = () => {
				audio.onended = null;
				audio.onerror = null;

				if (this.currentAudio === audio) {
					this.currentAudio = null;
				}
				if (this.currentObjectUrl === objectUrl) {
					URL.revokeObjectURL(objectUrl);
					this.currentObjectUrl = null;
				}
				if (this.currentPlaybackAbort === abortPlayback) {
					this.currentPlaybackAbort = null;
				}
			};

			const settle = (error?: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};

			const abortPlayback = () => {
				audio.pause();
				audio.removeAttribute("src");
				audio.load();
				settle(new DOMException("Kokoro TTS playback was aborted.", "AbortError"));
			};

			audio.onended = () => settle();
			audio.onerror = () => settle(new Error("Kokoro TTS audio playback failed."));

			this.currentAudio = audio;
			this.currentObjectUrl = objectUrl;
			this.currentPlaybackAbort = abortPlayback;

			void audio
				.play()
				.then(() => {
					if (settled) return;
					onPlaybackStart?.();
				})
				.catch((error) => settle(error));
		});
	}

	private speakViaBrowser(text: string): boolean {
		const synthesis = getBrowserSpeechSynthesis();
		if (!synthesis) {
			// biome-ignore lint/suspicious/noConsole: intentional user-facing Web Speech API fallback warning
			console.warn("[KokoroPlugin] No Web Speech API available for fallback.");
			return false;
		}

		if (synthesis.speaking || synthesis.pending) {
			synthesis.cancel();
		}

		const utterance = new SpeechSynthesisUtterance(text);
		synthesis.speak(utterance);
		return true;
	}

	private async readProviderError(response: Response): Promise<string> {
		const text = await response.text().catch(() => "");
		if (!text.trim()) {
			return `Kokoro returned HTTP ${response.status.toString()}`;
		}

		try {
			const parsed = JSON.parse(text) as {
				error?: { message?: unknown };
				message?: unknown;
				detail?: unknown;
			};
			const message =
				typeof parsed.error?.message === "string"
					? parsed.error.message
					: typeof parsed.message === "string"
						? parsed.message
						: typeof parsed.detail === "string"
							? parsed.detail
							: null;
			return message ?? text.trim().slice(0, 400);
		} catch {
			return text.trim().slice(0, 400);
		}
	}

	private logDebug(message: string, data?: Record<string, unknown>): void {
		if (!isKokoroDebugEnabled()) return;
		// biome-ignore lint/suspicious/noConsole: intentional debug logging gated by localStorage flag
		console.info("[KokoroPlugin]", message, data ?? {});
	}
}
