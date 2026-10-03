/** Search-only excerpts from one parent message. They are never persisted. */
export interface MatchedEvidenceSpan {
	content: string;
	sourceChunkId?: string;
	sourceChunkIds?: string[];
	startPosition?: number;
	endPosition?: number;
	channels: Array<{ name: string; rank: number }>;
}

type EvidenceHit = { content: string; metadata: Record<string, unknown> };

function isSpan(value: unknown): value is MatchedEvidenceSpan {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as MatchedEvidenceSpan).content === "string" &&
		Array.isArray((value as MatchedEvidenceSpan).channels)
	);
}

function spansFor(hit: EvidenceHit): MatchedEvidenceSpan[] {
	const stored = hit.metadata.matchedSpans;
	if (Array.isArray(stored) && stored.length > 0 && stored.every(isSpan)) return stored;
	return [
		{
			content: hit.content,
			...(typeof hit.metadata.sourceChunkId === "string"
				? { sourceChunkId: hit.metadata.sourceChunkId }
				: {}),
			...(typeof hit.metadata.sourceStartPosition === "number"
				? { startPosition: hit.metadata.sourceStartPosition }
				: {}),
			...(typeof hit.metadata.sourceEndPosition === "number"
				? { endPosition: hit.metadata.sourceEndPosition }
				: {}),
			channels: [],
		},
	];
}

function sameSpan(left: MatchedEvidenceSpan, right: MatchedEvidenceSpan): boolean {
	if (
		left.startPosition !== undefined &&
		left.endPosition !== undefined &&
		right.startPosition !== undefined &&
		right.endPosition !== undefined
	) {
		return left.startPosition === right.startPosition && left.endPosition === right.endPosition;
	}
	return left.sourceChunkId === right.sourceChunkId && left.content === right.content;
}

function combineSpans(spans: MatchedEvidenceSpan[]): MatchedEvidenceSpan[] {
	const combined: MatchedEvidenceSpan[] = [];
	for (const span of spans) {
		const existing = combined.find((candidate) => sameSpan(candidate, span));
		if (!existing) {
			combined.push({
				...span,
				sourceChunkIds: [...(span.sourceChunkIds ?? (span.sourceChunkId ? [span.sourceChunkId] : []))],
				channels: [...span.channels],
			});
			continue;
		}
		for (const chunkId of span.sourceChunkIds ?? (span.sourceChunkId ? [span.sourceChunkId] : [])) {
			if (!existing.sourceChunkIds?.includes(chunkId)) existing.sourceChunkIds?.push(chunkId);
		}
		for (const channel of span.channels) {
			if (!existing.channels.some((item) => item.name === channel.name && item.rank === channel.rank)) {
				existing.channels.push(channel);
			}
		}
	}
	return combined;
}

export function withMatchedEvidence<T extends EvidenceHit>(hit: T, channel: string, rank: number): T {
	const spans = spansFor(hit).map((span) => ({
		...span,
		channels: span.channels.some((item) => item.name === channel)
			? span.channels
			: [...span.channels, { name: channel, rank }],
	}));
	return { ...hit, metadata: { ...hit.metadata, matchedSpans: combineSpans(spans) } };
}

/** Keep the preferred hit's score/text for ranking, but retain other excerpts. */
export function mergeMatchedEvidence<T extends EvidenceHit>(preferred: T, other: T): T {
	const truncated =
		Number(preferred.metadata.matchedSpansTruncated || 0) + Number(other.metadata.matchedSpansTruncated || 0);
	return {
		...preferred,
		metadata: {
			...preferred.metadata,
			matchedSpans: combineSpans([...spansFor(preferred), ...spansFor(other)]),
			...(truncated > 0 ? { matchedSpansTruncated: truncated } : {}),
		},
	};
}

/**
 * Materialize all distinct selected excerpts only after reranking. Overlapping
 * windows use their exact parent-message offsets to avoid repeating text.
 */
export function renderMatchedEvidence(hit: EvidenceHit): string {
	const spans = combineSpans(spansFor(hit));
	if (spans.length <= 1) return hit.content;
	const ordered = [...spans].sort(
		(a, b) => (a.startPosition ?? Number.MAX_SAFE_INTEGER) - (b.startPosition ?? Number.MAX_SAFE_INTEGER),
	);
	const windows: Array<{ content: string; start?: number; end?: number }> = [];
	for (const span of ordered) {
		const previous = windows.at(-1);
		if (
			previous &&
			previous.start !== undefined &&
			previous.end !== undefined &&
			span.startPosition !== undefined &&
			span.endPosition !== undefined &&
			span.startPosition <= previous.end
		) {
			if (span.endPosition > previous.end) {
				previous.content += span.content.slice(previous.end - span.startPosition);
				previous.end = span.endPosition;
			}
			continue;
		}
		windows.push({
			content: span.content,
			start: span.startPosition,
			end: span.endPosition,
		});
	}
	return windows.map((window, index) => `[Matched excerpt ${index + 1}]\n${window.content}`).join("\n\n");
}
