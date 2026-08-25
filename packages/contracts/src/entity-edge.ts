/**
 * Canonical `EntityEdge` contract shared between the runtime (entity
 * extraction, sub-query signal) and any host-side persistence layer.
 *
 * An `EntityEdge` is a single tuple of `(label, kind, relation, source)`,
 * produced by a host-injected `entityExtractor` and consumed by either:
 *
 *   - `store.distill()` — the distil primitive materializes a batch of
 *     edges from a single raw message and lets the host decide where to
 *     persist them (the SDK never writes an entity table itself).
 *
 *   - the unified search entity sub-query — matches in the host's
 *     entity store are surfaced as additional `UnifiedMemorySearchResult`
 *     rows that participate in RRF fusion alongside semantic / lexical
 *     channels.
 *
 * `EntityKind` is a closed enum — narrower than the existing
 * `EntityType` (which is scoped to the graph-node taxonomy) but
 * forward-compatible: `isEntityKind` uses `Array.includes` so adding a
 * new variant only requires extending the union + array. Downstream
 * code MUST be tolerant of unknown values when reading edges written
 * by a newer SDK version.
 */
export type EntityKind = "person" | "place" | "org" | "product" | "event" | "concept" | "other";

export const ENTITY_KINDS: readonly EntityKind[] = [
	"person",
	"place",
	"org",
	"product",
	"event",
	"concept",
	"other",
] as const;

export function isEntityKind(value: unknown): value is EntityKind {
	return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}

export interface EntityEdge {
	/** Canonical entity label, normalized (lowercased + trimmed). */
	label: string;
	/** Coarse-grained entity kind — see `EntityKind`. */
	kind: EntityKind;
	/**
	 * Relation to the source message. Host-defined string (e.g. `"mentions"`,
	 * `"owns"`, `"lives_in"`). The SDK treats this as opaque.
	 */
	relation: string;
	/** Raw message id the edge was extracted from — used for traceability. */
	sourceMessageId: string;
	/** Extraction timestamp in ms since epoch. */
	extractedAt: number;
	/** Optional extractor confidence in [0..1]. */
	confidence?: number;
}
