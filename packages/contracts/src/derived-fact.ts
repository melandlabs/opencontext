/**
 * Canonical `DerivedFact` contract shared between the runtime (the
 * `derive` primitive) and any host-side persistence / Loop-engine layer.
 *
 * A `DerivedFact` is a single natural-language statement synthesized
 * by a host-injected `deriver` from a window of raw messages or
 * candidate facts. The SDK never persists derived facts itself; the
 * host decides whether to feed them back as raw messages, into the
 * graph, or to a Loop-engine schedule.
 *
 * `DerivedKind` is intentionally narrow — these are the four shapes the
 * reference extractor / deriver implementations target. Hosts are free
 * to extend the taxonomy via the `kind` string but downstream code
 * MUST be tolerant of unknown values.
 */
export type DerivedKind = "summary" | "frequency" | "contradiction_candidate" | "temporal_trend";

export const DERIVED_KINDS: readonly DerivedKind[] = [
	"summary",
	"frequency",
	"contradiction_candidate",
	"temporal_trend",
] as const;

export function isDerivedKind(value: unknown): value is DerivedKind {
	return typeof value === "string" && (DERIVED_KINDS as readonly string[]).includes(value);
}

export interface DerivedFact {
	/** Derived natural-language fact text. */
	text: string;
	/** Coarse-grained derivation shape — see `DerivedKind`. */
	kind: DerivedKind;
	/** Source fact ids the derivation was synthesized from. */
	sources: string[];
	/** Optional time window [fromMs, toMs] — used by `frequency` / `temporal_trend`. */
	window?: { from: number; to: number };
	/** Optional deriver confidence in [0..1]. */
	confidence?: number;
	/** Derivation timestamp in ms since epoch. */
	derivedAt: number;
}
