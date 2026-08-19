/**
 * Reranker adapter contract.
 *
 * A `Reranker` is an optional plug-in applied to the unified-search output
 * after per-source merge but before the final `slice(0, limit)`. It lets a
 * host swap in a cross-encoder, a learned ranker, or any other deterministic
 * ordering without changing the retrieval pipeline.
 *
 * Implementations MUST be deterministic for the same `(query, candidates)`
 * pair — non-deterministic orderings would defeat the existing
 * `rrfScore`/`similarity` tie-break tests.
 */

export interface RerankerCandidate {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
}

export interface RerankerInput {
	query: string;
	candidates: RerankerCandidate[];
	topK?: number;
}

export interface RerankerScore {
	id: string;
	score: number;
}

export interface Reranker {
	rerank(input: RerankerInput): Promise<RerankerScore[]>;
}

/**
 * No-op reranker that preserves the input order. Each candidate receives a
 * score equal to the `1 / (1 + rank)` decay so the type signature stays
 * useful for downstream consumers that expect strictly positive scores.
 */
export class IdentityReranker implements Reranker {
	async rerank(input: RerankerInput): Promise<RerankerScore[]> {
		const { candidates, topK } = input;
		const limit =
			typeof topK === "number" && topK > 0 ? Math.min(topK, candidates.length) : candidates.length;
		return candidates.slice(0, limit).map((candidate, index) => ({
			id: candidate.id,
			score: 1 / (1 + index),
		}));
	}
}

/**
 * Internal helper used by the unified-search facade to apply a reranker when
 * one is configured. Returns the original list unchanged when no reranker is
 * supplied so the default pipeline is unaffected.
 */
export async function applyReranker<
	T extends { id: string; content: string; metadata: Record<string, unknown> },
>(reranker: Reranker | undefined, query: string, results: T[]): Promise<T[]> {
	if (!reranker || results.length === 0) {
		return results;
	}

	const scores = await reranker.rerank({
		query,
		candidates: results.map((result) => ({
			id: result.id,
			content: result.content,
			metadata: result.metadata,
		})),
	});

	if (scores.length === 0) {
		return results;
	}

	const byId = new Map(results.map((result) => [result.id, result]));
	const reordered: T[] = [];
	const seen = new Set<string>();
	for (const { id, score } of scores) {
		const hit = byId.get(id);
		if (!hit || seen.has(id)) {
			continue;
		}
		seen.add(id);
		reordered.push({ ...hit, metadata: { ...hit.metadata, rerankerScore: score } });
	}

	// Append any candidates the reranker omitted so we never silently lose
	// results. Their position is the original merge order (stable), which
	// preserves the upstream `rrfScore`/`similarity` tie-break.
	for (const hit of results) {
		if (!seen.has(hit.id)) {
			reordered.push(hit);
		}
	}

	return reordered;
}
