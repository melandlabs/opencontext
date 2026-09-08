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
}

const PARAGRAPH_BOUNDARIES = ["\n\n", "\r\n\r\n"] as const;
const SENTENCE_BOUNDARY = /[.!?。！？；;]\s*$/u;

function largestEndWithinTokenBudget(text: string, start: number, maxTokens: number): number {
	let low = start + 1;
	let high = text.length;
	let best = low;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (estimateTokens(text.slice(start, middle)) <= maxTokens) {
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

function overlapStart(text: string, chunkStart: number, chunkEnd: number, overlapTokens: number): number {
	if (overlapTokens <= 0) return chunkEnd;
	let low = chunkStart + 1;
	let high = chunkEnd;
	let best = chunkEnd;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (estimateTokens(text.slice(middle, chunkEnd)) <= overlapTokens) {
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
	if (text.length === 0) return [];
	const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? RAW_MESSAGE_CHUNK_MAX_TOKENS));
	const overlapTokens = Math.max(0, Math.floor(options.overlapTokens ?? RAW_MESSAGE_CHUNK_OVERLAP_TOKENS));
	if (overlapTokens >= maxTokens) {
		throw new Error("overlapTokens must be smaller than maxTokens");
	}

	const chunks: TextChunk[] = [];
	let start = 0;
	while (start < text.length) {
		const hardEnd = largestEndWithinTokenBudget(text, start, maxTokens);
		const end = preferNaturalEnd(text, start, hardEnd);
		chunks.push({
			chunkIndex: chunks.length,
			startPosition: start,
			endPosition: end,
			content: text.slice(start, end),
		});
		if (end >= text.length) break;
		start = overlapStart(text, start, end, overlapTokens);
	}
	return chunks;
}
