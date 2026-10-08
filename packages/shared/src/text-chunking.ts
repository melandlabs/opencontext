import { estimateTokens } from "./tokens";

export const RAW_MESSAGE_CHUNK_MAX_TOKENS = 400;
export const RAW_MESSAGE_CHUNK_OVERLAP_TOKENS = 80;

export interface TextChunk {
	chunkIndex: number;
	startPosition: number;
	endPosition: number;
	content: string;
}

export interface ChunkTextOptions {
	maxTokens?: number;
	overlapTokens?: number;
	/** Count content tokens without model-specific special tokens. */
	countTokens?: (text: string) => number;
}

const PARAGRAPH_BOUNDARIES = ["\n\n", "\r\n\r\n"] as const;
const SENTENCE_BOUNDARY = /[.!?。！？；;]\s*$/u;

function largestEndWithinTokenBudget(
	text: string,
	start: number,
	maxTokens: number,
	countTokens: (text: string) => number,
): number {
	if (countTokens(text.slice(start)) <= maxTokens) return text.length;
	let low = start + 1;
	let high = text.length;
	let best = start;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (countTokens(text.slice(start, middle)) <= maxTokens) {
			best = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function preferNaturalEnd(text: string, start: number, hardEnd: number): number {
	if (hardEnd >= text.length) return text.length;
	const searchStart = start + Math.floor((hardEnd - start) * 0.6);
	const candidate = text.slice(searchStart, hardEnd);

	for (const boundary of PARAGRAPH_BOUNDARIES) {
		const index = candidate.lastIndexOf(boundary);
		if (index >= 0) return searchStart + index + boundary.length;
	}

	for (let offset = candidate.length; offset > 0; offset -= 1) {
		const prefix = candidate.slice(0, offset);
		if (SENTENCE_BOUNDARY.test(prefix)) return searchStart + offset;
	}

	for (let offset = candidate.length - 1; offset >= 0; offset -= 1) {
		if (/\s/u.test(candidate[offset] ?? "")) return searchStart + offset + 1;
	}
	return hardEnd;
}

function overlapStart(
	text: string,
	chunkStart: number,
	chunkEnd: number,
	overlapTokens: number,
	countTokens: (text: string) => number,
): number {
	if (overlapTokens <= 0) return chunkEnd;
	let low = chunkStart + 1;
	let high = chunkEnd;
	let best = chunkEnd;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (countTokens(text.slice(middle, chunkEnd)) <= overlapTokens) {
			best = middle;
			high = middle - 1;
		} else {
			low = middle + 1;
		}
	}
	return Math.min(chunkEnd, Math.max(chunkStart + 1, best));
}

/**
 * Split text into deterministic, overlapping chunks while preserving exact
 * character offsets into the original string.
 */
export function chunkTextByEstimatedTokens(text: string, options: ChunkTextOptions = {}): TextChunk[] {
	return chunkTextByTokenBudget(text, { ...options, countTokens: options.countTokens ?? estimateTokens });
}

/** Model-aware splitting; offsets always address the unchanged UTF-16 source. */
export function chunkTextByTokenBudget(
	text: string,
	options: ChunkTextOptions & { countTokens: (text: string) => number },
): TextChunk[] {
	if (text.length === 0) return [];
	if (
		(options.maxTokens !== undefined && !Number.isFinite(options.maxTokens)) ||
		(options.overlapTokens !== undefined && !Number.isFinite(options.overlapTokens))
	) {
		throw new Error("Chunk token budgets must be finite");
	}
	const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? RAW_MESSAGE_CHUNK_MAX_TOKENS));
	const overlapTokens = Math.max(0, Math.floor(options.overlapTokens ?? RAW_MESSAGE_CHUNK_OVERLAP_TOKENS));
	if (overlapTokens >= maxTokens) {
		throw new Error("overlapTokens must be smaller than maxTokens");
	}
	const countTokens = (value: string): number => {
		const count = options.countTokens(value);
		if (!Number.isSafeInteger(count) || count < 0)
			throw new Error("Token counter must return a non-negative integer");
		return count;
	};
	const boundary = (position: number, direction: -1 | 1): number => {
		const before = text.charCodeAt(position - 1);
		const after = text.charCodeAt(position);
		return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
			? position + direction
			: position;
	};

	const chunks: TextChunk[] = [];
	let start = 0;
	while (start < text.length) {
		const hardEnd = boundary(largestEndWithinTokenBudget(text, start, maxTokens, countTokens), -1);
		let end = boundary(preferNaturalEnd(text, start, hardEnd), -1);
		// Real subword counts can change when a prefix cuts a word. Recheck the
		// chosen natural boundary instead of assuming every shorter prefix fits.
		while (end > start && countTokens(text.slice(start, end)) > maxTokens) end = boundary(end - 1, -1);
		if (end <= start) throw new Error("Token budget cannot fit a source character");
		if (end <= (chunks.at(-1)?.endPosition ?? -1)) {
			start = chunks.at(-1)?.endPosition ?? start;
			continue;
		}
		chunks.push({
			chunkIndex: chunks.length,
			startPosition: start,
			endPosition: end,
			content: text.slice(start, end),
		});
		if (end >= text.length) break;
		let nextStart = boundary(overlapStart(text, start, end, overlapTokens, countTokens), 1);
		while (nextStart < end && countTokens(text.slice(nextStart, end)) > overlapTokens)
			nextStart = boundary(nextStart + 1, 1);
		start = nextStart;
	}
	return chunks;
}
