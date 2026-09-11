/**
 * `@melandlabs/workspace/search/hybrid` — lexical × semantic fusion.
 *
 * Wraps `fuseHybridResults` (`@melandlabs/rag`) with the RRF k=60 default
 * the plan specifies. The store-side rank list is normalised to the
 * `VectorSearchResult` shape that the RAG fusion helper expects.
 */

import { type VectorSearchResult, fuseHybridResults } from "@melandlabs/rag";
import type { WorkspaceSearchHit } from "../types";

function toVectorResult(hit: WorkspaceSearchHit): VectorSearchResult {
	return {
		id: hit.chunk_id,
		documentId: hit.canonical_key,
		content: hit.snippet,
		score: hit.score,
		metadata: {
			resource_id: hit.resource_id,
			version_id: hit.version_id,
			resource_type: hit.resource_type,
			resource_title: hit.resource_title,
		},
	};
}

function fromVectorResult(result: VectorSearchResult, original: WorkspaceSearchHit): WorkspaceSearchHit {
	const meta = result.metadata ?? {};
	return {
		...original,
		score: result.score,
		signals: {
			...original.signals,
			lexical: original.signals.lexical,
			semantic: original.signals.semantic,
			edge_boost: original.signals.edge_boost,
		},
		chunk_id: result.id,
		canonical_key: (meta.documentId as string) ?? original.canonical_key,
	};
}

export interface HybridSearchInput {
	lexical: WorkspaceSearchHit[];
	semantic: WorkspaceSearchHit[];
	limit: number;
	rrfK?: number;
	alpha?: number;
}

export function fuseHybridHits(input: HybridSearchInput): WorkspaceSearchHit[] {
	const dense = input.semantic.map(toVectorResult);
	const lexical = input.lexical.map(toVectorResult);
	const fused = fuseHybridResults({
		dense,
		lexical,
		strategy: "rrf",
		rrfK: input.rrfK ?? 60,
		alpha: input.alpha ?? 0.5,
		limit: input.limit,
	});
	// `fuseHybridResults` mutates `result.score`; look up the original
	// WorkspaceSearchHit by chunk_id so the return shape carries the
	// signals / edges / metadata that the lexical / semantic passes built.
	const byChunkId = new Map<string, WorkspaceSearchHit>();
	for (const hit of input.lexical) byChunkId.set(hit.chunk_id, hit);
	for (const hit of input.semantic) byChunkId.set(hit.chunk_id, hit);
	return fused.map((result) => {
		const original = byChunkId.get(result.id);
		if (!original) {
			return {
				chunk_id: result.id,
				resource_id: 0,
				version_id: 0,
				resource_type: "document",
				resource_title: "",
				canonical_key: result.documentId,
				snippet: result.content,
				matched_terms: [],
				score: result.score,
				signals: {},
				reference_edges: [],
			};
		}
		return fromVectorResult(result, original);
	});
}
