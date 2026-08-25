/**
 * `derive` primitive — synthesize `DerivedFact`s from a window of
 * candidate fact texts.
 *
 * The host wires in an LLM deriver via `UnifiedSearchDeps.deriver`.
 * When the dep is absent, the primitive short-circuits with a
 * `derive_deriver_not_configured` warning — same precedent as the
 * iterative planner path and `distill`.
 *
 * When the caller does NOT supply `candidateTexts`, the SDK pulls
 * candidate texts from `deps.searchRawMessagesLexical` (or the
 * raw-message manager's lexical fallback) using the `keywords`
 * derived from the query. The host is still in charge of any
 * semantic-only retrieval — the derive primitive is lexical-first by
 * design so it stays cheap to schedule from the Loop engine.
 *
 * Persistence is the host's responsibility via `input.persist`. The
 * SDK never writes derived facts into a graph or summary table
 * itself — the host may choose to feed them back as raw messages,
 * into the graph node set, or to a Loop-engine queue.
 *
 * Pure (no I/O of its own beyond invoking the deriver and the persist
 * callback) so it stays unit-testable.
 */

import { type DerivedFact, isDerivedKind } from "@melandlabs/contracts/derived-fact";
import type { FactType } from "@melandlabs/contracts/fact-type";
import type { Peer } from "@melandlabs/contracts/peer";
import type { UnifiedSearchDeps } from "../config";
import { deriveLexicalKeywords, isRawMemorySemanticResult, toMemoryResult } from "./utilities";

export interface DeriveInput {
	userId: string;
	/**
	 * Optional topical query — used by the lexical candidate-fetch
	 * fallback to derive keywords. Loop-engine schedulers should pass
	 * the topic they want synthesized facts about (e.g. `"cat
	 * preferences"`); without it the fallback falls back to
	 * `userId + botIds` which is rarely useful.
	 *
	 * Ignored when `candidateTexts` is supplied.
	 */
	query?: string;
	/** Optional bot-id scope for the candidate-fetch lexical fallback. */
	botIds?: string[];
	/** Optional date range for the candidate-fetch lexical fallback. */
	dateFrom?: string;
	dateTo?: string;
	/** Optional explicit time window to forward to the deriver. */
	window?: { from: number; to: number };
	/**
	 * Optional pre-computed candidate texts. When omitted, the SDK
	 * fetches up to `candidateLimit` (default 50) texts from the
	 * raw-message lexical sub-query.
	 */
	candidateTexts?: string[];
	/** Candidate-fetch ceiling when `candidateTexts` is omitted. Defaults to 50. */
	candidateLimit?: number;
	/** Optional host-side peer scope; forwarded to lexical fallback. */
	peers?: ReadonlyArray<Peer>;
	/** Optional `FactType` filter; forwarded to lexical fallback. */
	factTypes?: FactType[];
	/**
	 * Optional host-side persistence callback. Invoked exactly once
	 * with the derived facts when a deriver is wired in.
	 */
	persist?: (facts: DerivedFact[]) => Promise<void>;
}

export interface DeriveWarning {
	code: string;
	message: string;
}

export interface DeriveOutput {
	facts: DerivedFact[];
	warnings: DeriveWarning[];
}

const DEFAULT_CANDIDATE_LIMIT = 50;

/**
 * Run the deriver over a window of candidate fact texts.
 *
 *   - No deriver configured → `{ facts: [], warnings: [...] }`.
 *   - Deriver configured → pull candidates (or accept
 *     `input.candidateTexts`), call the deriver, await `persist` if
 *     provided, return the facts. Errors are surfaced as warnings
 *     and never thrown — derive is best-effort by design.
 */
export async function deriveFacts(
	deps: Pick<UnifiedSearchDeps, "deriver" | "searchRawMessagesLexical">,
	input: DeriveInput,
	logger: Pick<Console, "warn"> = console,
): Promise<DeriveOutput> {
	const warnings: DeriveWarning[] = [];

	if (typeof deps.deriver !== "function") {
		warnings.push({
			code: "derive_deriver_not_configured",
			message: "No `deriver` is wired into the unified search deps; returning an empty fact list.",
		});
		return { facts: [], warnings };
	}

	const limit = Math.max(1, Math.min(500, input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT));

	if (!input.candidateTexts || input.candidateTexts.length === 0) {
		// Without explicit candidate texts, the lexical fallback derives
		// keywords from `query`. When even that is absent it falls back to
		// `userId + botIds`, which is best-effort and usually returns noise —
		// warn so the caller (typically a Loop-engine schedule) knows to pass `query`.
		if (!input.query) {
			warnings.push({
				code: "derive_fallback_query_noise",
				message:
					"No `query` supplied and no `candidateTexts`; lexical fallback derives keywords from `userId + botIds`, which is rarely useful. Pass `query` (or `candidateTexts`) for topical derivation.",
			});
		}
	}

	let candidateTexts: string[];
	if (input.candidateTexts && input.candidateTexts.length > 0) {
		candidateTexts = input.candidateTexts;
	} else {
		candidateTexts = await loadCandidateTexts(deps, input, limit, logger);
		if (candidateTexts.length === 0) {
			warnings.push({
				code: "derive_no_candidates",
				message: "No candidate fact texts available for derivation",
			});
			return { facts: [], warnings };
		}
	}

	let facts: DerivedFact[];
	try {
		facts = await deps.deriver({
			userId: input.userId,
			userScope: {
				userId: input.userId,
				botIds: input.botIds,
				dateFrom: input.dateFrom,
				dateTo: input.dateTo,
			},
			recentFactTexts: candidateTexts,
			...(input.window ? { window: input.window } : {}),
		});
	} catch (error) {
		logger.warn?.("[memory-store/derive] deriver threw:", error);
		warnings.push({
			code: "derive_deriver_failed",
			message: (error as Error).message ?? "deriver failed",
		});
		return { facts: [], warnings };
	}

	if (!Array.isArray(facts)) {
		warnings.push({
			code: "derive_deriver_returned_invalid_shape",
			message: `deriver returned ${typeof facts}; expected DerivedFact[]`,
		});
		return { facts: [], warnings };
	}

	// Normalize: drop entries missing required fields or carrying an unknown
	// `kind` value (the contract is a closed enum — see
	// `contracts/derived-fact.ts`). Fill in `derivedAt` if absent.
	const normalized: DerivedFact[] = [];
	const now = Date.now();
	for (const fact of facts) {
		if (
			!fact ||
			typeof fact.text !== "string" ||
			fact.text.length === 0 ||
			typeof fact.kind !== "string" ||
			!isDerivedKind(fact.kind) ||
			!Array.isArray(fact.sources)
		) {
			continue;
		}
		normalized.push({
			...fact,
			derivedAt: typeof fact.derivedAt === "number" ? fact.derivedAt : now,
			sources: fact.sources.filter((s): s is string => typeof s === "string"),
		});
	}

	if (input.persist && normalized.length > 0) {
		try {
			await input.persist(normalized);
		} catch (error) {
			logger.warn?.("[memory-store/derive] persist callback threw:", error);
			warnings.push({
				code: "derive_persist_failed",
				message: (error as Error).message ?? "derive persist failed",
			});
		}
	}

	return { facts: normalized, warnings };
}

/**
 * Pull candidate fact texts via the lexical sub-query. Used when the
 * caller does not pass `candidateTexts` explicitly.
 *
 * Returns `[]` when no lexical provider is wired — the caller will
 * surface a `derive_no_candidates` warning.
 */
async function loadCandidateTexts(
	deps: Pick<UnifiedSearchDeps, "searchRawMessagesLexical">,
	input: DeriveInput,
	limit: number,
	logger: Pick<Console, "warn">,
): Promise<string[]> {
	if (typeof deps.searchRawMessagesLexical !== "function") {
		return [];
	}

	// Prefer the caller-supplied topical query so the lexical fallback
	// actually finds relevant facts. Fall back to `userId + botIds`
	// only when no query is provided — that path is best-effort and
	// usually returns noise, callers should pass `query` from a
	// Loop-engine schedule.
	const queryText = (input.query ?? `${input.userId} ${input.botIds?.join(" ") ?? ""}`).trim();
	const keywords = deriveLexicalKeywords(queryText);
	if (keywords.length === 0) {
		return [];
	}

	try {
		const filters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];
		const factTypes = input.factTypes?.length ? input.factTypes : undefined;
		const hits = (
			await Promise.all(
				filters.map((botId) =>
					deps.searchRawMessagesLexical?.({
						userId: input.userId,
						keywords,
						limit: Math.ceil(limit / filters.length),
						botId,
						...(input.peers && input.peers.length > 0 ? { peers: input.peers } : {}),
						...(factTypes ? { factTypes } : {}),
					}),
				),
			)
		)
			.flat()
			.filter(isRawMemorySemanticResult);
		return hits.map((h) => toMemoryResult(h).content);
	} catch (error) {
		logger.warn?.("[memory-store/derive] lexical candidate fetch failed:", error);
		return [];
	}
}
