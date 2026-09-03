/**
 * Shared evidence-gather + synthesis helpers used by the unified
 * `store.search()` entry point.
 *
 * This module collapses the per-tier gather functions that previously
 * lived in `unified-search.ts` (`runMemorySource`) and `reflect.ts`
 * (`gatherSummaries` / `gatherRaw` / `gatherInsights` / `gatherKnowledge`)
 * into a single implementation. Both the read-only and synthesize paths
 * call into here so the underlying hit surface stays consistent.
 *
 * Design contract:
 *   - `gatherEvidence` runs the cross-tier gather (memory + summaries +
 *     insights + knowledge) and returns RRF-merged hits plus warnings
 *     and reasoning metadata.
 *   - `mergeEvidenceAcrossTiers` is a thin wrapper around
 *     `mergeUnifiedMemorySearchResultsRrf` so callers don't need to
 *     construct `UnifiedMemoryRankedList[]` manually.
 *   - `synthesizeAnswer` runs `reasoning.complete` against the gathered
 *     evidence, applying the same schema-aware extraction and graceful
 *     failure rules as the legacy `reflect()` path.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import type { MemorySummaryHit, UnifiedSearchDeps } from "../config";
import { applyReranker } from "./reranker";
import type {
	SearchEvidence,
	SearchInput,
	SearchOutput,
	SearchTier,
	UnifiedMemoryRankedList,
	UnifiedMemoryReasoningInfo,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchWarning,
} from "./utilities";
import {
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	mergeUnifiedMemorySearchResultsRrf,
	resolveScopePeer,
} from "./utilities";

const DEFAULT_TIERS: SearchTier[] = ["summary", "raw", "insight", "knowledge"];

export interface GatherOptions {
	input: SearchInput;
	deps: UnifiedSearchDeps;
	logger: Pick<Console, "warn">;
	peerPeers: ReadonlyArray<Peer>;
}

export interface GatherResult {
	hits: UnifiedMemorySearchResult[];
	warnings: UnifiedMemorySearchWarning[];
	reasoning: UnifiedMemoryReasoningInfo;
}

/**
 * Reciprocal-rank fusion across the per-tier ranked lists. When fewer
 * than two tiers contributed hits, RRF degenerates to insertion order
 * and we return the concatenation (capped at `limit`).
 */
export function mergeEvidenceAcrossTiers(
	tiers: ReadonlyArray<{ name: SearchTier; hits: UnifiedMemorySearchResult[] }>,
	limit: number,
): UnifiedMemorySearchResult[] {
	const lists: UnifiedMemoryRankedList[] = [];
	for (const tier of tiers) {
		if (tier.hits.length > 0) {
			lists.push({ name: tier.name, hits: tier.hits });
		}
	}
	if (lists.length <= 1) {
		return lists[0] ? lists[0].hits.slice(0, limit) : [];
	}
	return mergeUnifiedMemorySearchResultsRrf(lists, limit);
}

interface GatheredEvidence {
	hits: UnifiedMemorySearchResult[];
	warnings: UnifiedMemorySearchWarning[];
}

function toSummaryResult(row: MemorySummaryHit): UnifiedMemorySearchResult {
	const start = typeof row.startTimestamp === "number" ? row.startTimestamp : undefined;
	const end = typeof row.endTimestamp === "number" ? row.endTimestamp : undefined;
	return {
		type: "memory",
		id: row.summaryId,
		content: row.summaryText,
		similarity: 1,
		metadata: {
			tier: "summary",
			summaryTier: row.summaryTier,
			keywords: row.keywords,
			startTimestamp: start,
			endTimestamp: end,
		},
	};
}

export async function gatherSummaries(
	deps: UnifiedSearchDeps,
	input: { userId: string; query: string; authToken?: string },
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer>,
): Promise<GatheredEvidence> {
	if (typeof deps.searchSummaries !== "function") {
		return { hits: [], warnings: [] };
	}

	const keywords = input.query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length >= 2)
		.slice(0, 16);

	try {
		const rows = await deps.searchSummaries({
			userId: input.userId,
			query: input.query,
			keywords,
			limit,
			threshold,
			authToken: input.authToken,
			...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
		});
		const hits = rows.map(toSummaryResult);
		return { hits, warnings: [] };
	} catch (error) {
		logger.warn?.("[memory-store] gather-evidence: summary search failed:", error);
		return {
			hits: [],
			warnings: [
				{
					source: "memory",
					code: "reflect_summaries_failed",
					message: (error as Error).message ?? "reflect_summaries_failed",
				},
			],
		};
	}
}

async function gatherRaw(
	deps: UnifiedSearchDeps,
	input: { userId: string; query: string; authToken?: string },
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer>,
): Promise<GatheredEvidence> {
	if (!deps.searchRawMessagesAnn && !deps.searchRawMessagesLexical) {
		return { hits: [], warnings: [] };
	}
	const warnings: UnifiedMemorySearchWarning[] = [];
	const hits: UnifiedMemorySearchResult[] = [];

	if (typeof deps.searchRawMessagesAnn === "function" && typeof deps.embedQuery === "function") {
		try {
			const embedding = await deps.embedQuery({
				userId: input.userId,
				query: input.query,
				authToken: input.authToken,
			});
			const annResults = (
				await Promise.all(
					[undefined].map((botId) =>
						deps.searchRawMessagesAnn?.({
							userId: input.userId,
							queryEmbedding: embedding,
							limit,
							threshold,
							botId,
							...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
						}),
					),
				)
			)
				.flat()
				.filter((hit): hit is NonNullable<typeof hit> => hit !== undefined)
				.map((hit) => ({
					type: "memory" as const,
					id: hit.id,
					content: hit.content,
					similarity: hit.similarity,
					metadata: hit.metadata,
				}));
			hits.push(...annResults);
		} catch (error) {
			logger.warn?.("[memory-store] gather-evidence: raw semantic search failed:", error);
			warnings.push({
				source: "memory",
				code: "reflect_raw_search_failed",
				message: (error as Error).message ?? "reflect_raw_search_failed",
			});
		}
	}

	if (typeof deps.searchRawMessagesLexical === "function") {
		const keywords = input.query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length >= 2);
		if (keywords.length > 0) {
			try {
				const lexicalResults = (
					await Promise.all(
						[undefined].map((botId) =>
							deps.searchRawMessagesLexical?.({
								userId: input.userId,
								keywords,
								limit,
								botId,
								...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
							}),
						),
					)
				)
					.flat()
					.filter((hit): hit is NonNullable<typeof hit> => hit !== undefined)
					.map((hit) => ({
						type: "memory" as const,
						id: hit.id,
						content: hit.content,
						similarity: hit.similarity,
						metadata: { ...hit.metadata, scoring: "bm25" },
					}));
				hits.push(...lexicalResults);
			} catch (error) {
				logger.warn?.("[memory-store] gather-evidence: raw lexical search failed:", error);
				warnings.push({
					source: "memory",
					code: "reflect_raw_lexical_failed",
					message: (error as Error).message ?? "reflect_raw_lexical_failed",
				});
			}
		}
	}

	return { hits, warnings };
}

async function gatherInsights(
	deps: UnifiedSearchDeps,
	input: { userId: string; query: string; authToken?: string; botIds?: string[] },
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer>,
): Promise<GatheredEvidence> {
	if (typeof deps.searchInsights !== "function") {
		return { hits: [], warnings: [] };
	}
	try {
		const rows = await deps.searchInsights({
			userId: input.userId,
			query: input.query,
			limit,
			threshold,
			botIds: input.botIds,
			includeArchived: false,
			authToken: input.authToken,
			...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
		});
		const hits: UnifiedMemorySearchResult[] = rows.map((hit) => ({
			type: "insight",
			id: hit.id,
			content: hit.content,
			similarity: hit.similarity,
			metadata: hit.metadata,
		}));
		return { hits, warnings: [] };
	} catch (error) {
		logger.warn?.("[memory-store] gather-evidence: insights search failed:", error);
		return {
			hits: [],
			warnings: [
				{
					source: "insights",
					code: "reflect_insights_failed",
					message: (error as Error).message ?? "reflect_insights_failed",
				},
			],
		};
	}
}

async function gatherKnowledge(
	deps: UnifiedSearchDeps,
	input: { userId: string; query: string; authToken?: string },
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer>,
): Promise<GatheredEvidence> {
	if (typeof deps.searchKnowledge !== "function") {
		return { hits: [], warnings: [] };
	}
	try {
		const rows = await deps.searchKnowledge({
			userId: input.userId,
			query: input.query,
			options: { limit, threshold },
			authToken: input.authToken,
			...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
		});
		const hits: UnifiedMemorySearchResult[] = rows.map((hit) => ({
			type: "knowledge",
			id: hit.chunkId,
			content: hit.content,
			similarity: hit.similarity,
			metadata: {
				documentId: hit.documentId,
				documentName: hit.documentName,
				chunkIndex: hit.chunkIndex,
			},
		}));
		return { hits, warnings: [] };
	} catch (error) {
		logger.warn?.("[memory-store] gather-evidence: knowledge search failed:", error);
		return {
			hits: [],
			warnings: [
				{
					source: "knowledge",
					code: "reflect_knowledge_failed",
					message: (error as Error).message ?? "reflect_knowledge_failed",
				},
			],
		};
	}
}

/**
 * Run the cross-tier gather in parallel and merge with RRF. The
 * returned `hits` are capped at `limit` and ready for synthesis /
 * serialization.
 */
export async function gatherEvidence(opts: GatherOptions): Promise<GatherResult> {
	const { input, deps, logger, peerPeers } = opts;
	const tiers = input.tiers && input.tiers.length > 0 ? input.tiers : DEFAULT_TIERS;
	const limit = clampUnifiedMemorySearchLimit(input.limit);
	const threshold = clampUnifiedMemorySearchThreshold(input.threshold);

	const tierTasks: Array<{ tier: SearchTier; task: Promise<GatheredEvidence> }> = [];
	if (tiers.includes("summary")) {
		tierTasks.push({
			tier: "summary",
			task: gatherSummaries(deps, input, limit, threshold, logger, peerPeers),
		});
	}
	if (tiers.includes("raw")) {
		tierTasks.push({ tier: "raw", task: gatherRaw(deps, input, limit, threshold, logger, peerPeers) });
	}
	if (tiers.includes("insight")) {
		tierTasks.push({
			tier: "insight",
			task: gatherInsights(deps, input, limit, threshold, logger, peerPeers),
		});
	}
	if (tiers.includes("knowledge")) {
		tierTasks.push({
			tier: "knowledge",
			task: gatherKnowledge(deps, input, limit, threshold, logger, peerPeers),
		});
	}

	const settled = await Promise.all(tierTasks.map((t) => t.task));

	const warnings: UnifiedMemorySearchWarning[] = [];
	for (const bucket of settled) {
		warnings.push(...bucket.warnings);
	}
	const tierLists: Array<{ name: SearchTier; hits: UnifiedMemorySearchResult[] }> = [];
	for (let i = 0; i < tierTasks.length; i += 1) {
		const bucket = settled[i];
		if (bucket && bucket.hits.length > 0) {
			tierLists.push({ name: tierTasks[i].tier, hits: bucket.hits });
		}
	}

	const merged = mergeEvidenceAcrossTiers(tierLists, limit);
	const ranked = deps.reranker ? await applyReranker(deps.reranker, input.query, merged) : merged;

	const reasoning: UnifiedMemoryReasoningInfo = { strategy: "none" };
	return { hits: ranked, warnings, reasoning };
}

/**
 * Build the prompt the LLM receives when `synthesize: true` is set.
 * Mirrors the legacy `reflect.ts` prompt format so callers see identical
 * behaviour before and after the merge.
 */
export function buildSynthesisPrompt(input: {
	query: string;
	evidence: Array<{ id: string; source: SearchTier; snippet: string; score: number }>;
	responseSchema?: Record<string, unknown>;
}): string {
	const grouped = new Map<SearchTier, typeof input.evidence>();
	for (const item of input.evidence) {
		const bucket = grouped.get(item.source) ?? [];
		bucket.push(item);
		grouped.set(item.source, bucket);
	}

	const sections: string[] = [];
	for (const tier of DEFAULT_TIERS) {
		const items = grouped.get(tier) ?? [];
		if (items.length === 0) {
			continue;
		}
		const lines = items.map(
			(item, index) => `  [${index + 1}] (${item.id}, score=${item.score.toFixed(4)}) ${item.snippet}`,
		);
		sections.push(`## ${tier}\n${lines.join("\n")}`);
	}

	const schemaDirective = input.responseSchema
		? `\nRespond with a JSON object that conforms to the following schema:\n${JSON.stringify(input.responseSchema, null, 2)}\nWrap your JSON in a single fenced \`\`\`json code block; do not add any prose outside the code block.`
		: "\nRespond in plain prose. Be concise; cite evidence by its [n] number.";

	if (sections.length === 0) {
		return `You are a reflection assistant.\n\nQuestion: ${input.query}\n\nNo evidence was found across any tier. State that explicitly.${schemaDirective}`;
	}

	return `You are a reflection assistant. Synthesise the user's question using only the evidence below. Do not invent facts.\n\nQuestion: ${input.query}\n\nEvidence (grouped by tier):\n${sections.join("\n\n")}${schemaDirective}`;
}

function extractJsonPayload(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fenced?.[1]) {
		return fenced[1];
	}
	const start = text.indexOf("{");
	if (start === -1) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

function coerceAnswer(text: string, schema: Record<string, unknown> | undefined): string {
	if (!schema) {
		return text;
	}
	const payload = extractJsonPayload(text);
	if (!payload) {
		return text;
	}
	try {
		const parsed = JSON.parse(payload);
		if (parsed && typeof parsed === "object") {
			const answer = (parsed as Record<string, unknown>).answer;
			if (typeof answer === "string") {
				return answer;
			}
		}
	} catch {
		// fall through to raw text
	}
	return text;
}

/**
 * Run `reasoning.complete` against the gathered hits, applying the
 * same schema-aware extraction and graceful-failure rules as the
 * legacy `reflect()` path. Returns `{ answer, warnings }`.
 */
export async function synthesizeAnswer(input: {
	query: string;
	evidence: SearchEvidence[];
	responseSchema?: Record<string, unknown>;
	deps: UnifiedSearchDeps;
	logger: Pick<Console, "log" | "warn">;
}): Promise<{ answer: string; warnings: UnifiedMemorySearchWarning[] }> {
	const { query, responseSchema, deps, logger } = input;
	const evidence = input.evidence.map((item) => ({
		id: item.id,
		source: mapEvidenceSourceToTier(item.source),
		snippet: item.snippet,
		score: item.score,
	}));
	const warnings: UnifiedMemorySearchWarning[] = [];

	const complete = deps.reasoning?.complete;
	if (!complete) {
		warnings.push({
			source: "memory",
			code: "reflect_llm_not_configured",
			message:
				"No `reasoning.complete` callback is configured; search() returned evidence without an LLM synthesis.",
		});
		return { answer: "", warnings };
	}

	const prompt = buildSynthesisPrompt({ query, evidence, responseSchema });

	try {
		const raw = await complete(prompt);
		const answer = coerceAnswer(raw, responseSchema);
		logger.log?.("[memory-store] search synthesis completed", {
			evidenceCount: evidence.length,
			answerChars: answer.length,
		});
		return { answer, warnings };
	} catch (error) {
		logger.warn?.("[memory-store] search synthesis failed:", error);
		warnings.push({
			source: "memory",
			code: "reflect_llm_failed",
			message: (error as Error).message ?? "reflect_llm_failed",
		});
		return { answer: "", warnings };
	}
}

function mapEvidenceSourceToTier(source: SearchEvidence["source"]): SearchTier {
	if (source === "memory") return "raw";
	if (source === "insights") return "insight";
	return source;
}

/**
 * Resolve the scope-checked peers for a search call. Pulled out so the
 * `search()` orchestrator can share the same narrowing as the legacy
 * read / reflect pipelines.
 */
export async function resolveSearchScopePeers(input: {
	deps: UnifiedSearchDeps;
	userId: string;
	peerFilter: ReadonlyArray<Peer> | undefined;
}): Promise<{ peers: ReadonlyArray<Peer>; warnings: UnifiedMemorySearchWarning[] }> {
	return resolveScopePeer({
		userId: input.userId,
		peerFilter: input.peerFilter,
		scopeCheck: input.deps.peerScopeCheck,
	});
}

export type { SearchOutput };
