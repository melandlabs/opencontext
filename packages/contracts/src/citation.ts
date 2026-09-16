/**
 * Cross-layer citation envelope.
 *
 * A `Citation` is the unified shape returned by every retrieval channel
 * (workspace chunks, memory facts, raw messages) so the LLM can render
 * a uniform reference block regardless of where the evidence lives.
 *
 * Key invariants:
 *   - `id` is globally unique within a workspace (composite key).
 *   - `kind` discriminates the storage layer; the union captures the
 *     fields each kind populates.
 *   - `valid_from` / `valid_until` come from the temporal context
 *     graph on memory facts; workspace chunks use them to mean
 *     "this chunk was current as of these timestamps".
 *   - `content_hash` lets `resolveCitation` detect drift between the
 *     citation's snapshot and the live content.
 *
 * Workspace `reference_edges` carry the cross-document graph; memory
 * facts expose their own `EntityEdge` graph (see `entity-edge.ts`).
 * Both reuse the same `edges` shape on the citation.
 */

export type CitationKind = "memory_fact" | "workspace_chunk" | "raw_message";

export interface CitationEdge {
	edge_type: string;
	target_id: string;
	target_kind?: CitationKind;
}

export interface CitationScores {
	lexical?: number;
	semantic?: number;
	edge_boost?: number;
	rrf?: number;
	entity?: number;
}

export interface Citation {
	/** Composite id; stable across the citation's lifetime. */
	id: string;
	kind: CitationKind;
	/** Workspace this evidence lives in (when applicable). */
	workspace_id?: string;

	// ── workspace-chunk specific ─────────────────────────────────
	resource_id?: number;
	resource_title?: string;
	resource_type?: string;
	chunk_id?: string;
	version_id?: number;
	canonical_key?: string;

	// ── memory-fact specific ─────────────────────────────────────
	memory_fact_id?: string;
	message_id?: string;

	// ── temporal graph ───────────────────────────────────────────
	/** ms epoch; undefined when not part of the temporal graph. */
	valid_from?: number;
	/** null = still in force; number = superseded at this time. */
	valid_until?: number | null;

	/** Snippet of the evidence (truncated, never full content). */
	snippet: string;

	/** Per-channel retrieval scores. */
	scores: CitationScores;

	/** Outgoing cross-reference edges (cite / supersede / etc.). */
	reference_edges?: CitationEdge[];

	/** sha256 of the content the citation was created from. */
	content_hash: string;

	/** Memory facts this citation was promoted from (Tier 4.1 bridge). */
	promoted_fact_ids?: string[];
}

/**
 * Build a deterministic citation id from its constituents. The shape
 * intentionally avoids embedding user_id / timestamp so the same
 * evidence always yields the same id across re-indexing.
 */
export function buildCitationId(input: {
	kind: CitationKind;
	workspace_id?: string;
	chunk_id?: string;
	memory_fact_id?: string;
	message_id?: string;
}): string {
	switch (input.kind) {
		case "workspace_chunk":
			return `ws:${input.workspace_id ?? ""}:${input.chunk_id ?? ""}`;
		case "memory_fact":
			return `fact:${input.memory_fact_id ?? ""}`;
		case "raw_message":
			return `msg:${input.message_id ?? ""}`;
		default: {
			// Exhaustive guard — if a new kind is added, this branch
			// is the seam to extend.
			const _exhaustive: never = input.kind;
			return `unknown:${_exhaustive}`;
		}
	}
}
