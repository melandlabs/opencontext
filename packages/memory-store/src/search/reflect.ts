/**
 * `reflect()` — single-turn LLM synthesis over already-gathered evidence.
 *
 * Distinct from the iterative planner (`iterative-recall.ts`):
 *
 *   - The iterative planner *generates* its own evidence by re-querying
 *     per action; its LLM is in the loop during retrieval.
 *   - `reflect()` *consumes* the unified-search evidence pipeline (raw
 *     messages, summaries, insights, knowledge) and asks the LLM once to
 *     synthesise an answer. This is a "single-shot synthesis" — no
 *     agentic loop, no action parsing.
 *
 * The function is designed to fail safely: an LLM exception never causes
 * `reflect()` to throw — instead, the collected evidence is preserved in
 * `evidence[]` and a `reflect_llm_failed` warning is added. Callers can
 * still surface the underlying hits when synthesis is unavailable.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import type { MemorySummaryHit, UnifiedSearchDeps } from "../config";
import { applyReranker } from "./reranker";
import {
	type UnifiedMemorySearchResult,
	type UnifiedMemorySearchWarning,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	mergeUnifiedMemorySearchResultsRrf,
	resolveScopePeer,
} from "./utilities";

export type ReflectTier = "summary" | "raw" | "insight" | "knowledge";

export interface ReflectInput {
	userId: string;
	query: string;
	botIds?: string[];
	dateFrom?: string;
	dateTo?: string;
	/**
	 * Which tiers to consult. Defaults to `["summary", "raw", "insight",
	 * "knowledge"]` — every tier the unified-search pipeline can serve.
	 */
	tiers?: ReadonlyArray<ReflectTier>;
	limit?: number;
	threshold?: number;
	/**
	 * Optional structured output schema. When supplied, the prompt asks the
	 * LLM to return JSON conforming to this shape; the parser attempts to
	 * decode `answer` accordingly. When omitted, `answer` is the raw text.
	 */
	responseSchema?: Record<string, unknown>;
	authToken?: string;
	/** Optional additive peer filter — see `UnifiedMemorySearchInput.peerFilter`. */
	peerFilter?: ReadonlyArray<Peer>;
}

export interface ReflectEvidence {
	id: string;
	source: ReflectTier;
	snippet: string;
	score: number;
	/**
	 * Original message / posting timestamp when the source carried one
	 * (e.g. `metadata.timestamp` or `metadata.startTimestamp`). Carried
	 * through so the write-back path can preserve temporal ordering
	 * instead of stamping every evidence record with `Date.now()`.
	 */
	timestamp?: number;
}

export interface ReflectOutput {
	answer: string;
	evidence: ReflectEvidence[];
	warnings: UnifiedMemorySearchWarning[];
}

const DEFAULT_TIERS: ReflectTier[] = ["summary", "raw", "insight", "knowledge"];
const MAX_EVIDENCE_CHARS = 600;

function truncate(input: string, max: number = MAX_EVIDENCE_CHARS): string {
	if (input.length <= max) {
		return input;
	}
	return `${input.slice(0, max - 1)}…`;
}

function makeReflectEvidence(hit: UnifiedMemorySearchResult): ReflectEvidence {
	// Summaries are stored as `type: "memory"` with a `metadata.tier`
	// marker; everything else falls back to its `type` value.
	const tierMarker = (hit.metadata as Record<string, unknown> | undefined)?.tier;
	let source: ReflectTier;
	const meta = hit.metadata as Record<string, unknown> | undefined;
	if (tierMarker === "summary") {
		source = "summary";
	} else if (hit.type === "memory") {
		source = "raw";
	} else if (hit.type === "insight") {
		source = "insight";
	} else if (hit.type === "knowledge") {
		source = "knowledge";
	} else {
		source = hit.type;
	}
	return {
		id: hit.id,
		source,
		snippet: truncate(hit.content),
		score: hit.similarity,
		timestamp:
			typeof meta?.timestamp === "number"
				? meta.timestamp
				: typeof meta?.startTimestamp === "number"
					? meta.startTimestamp
					: undefined,
	};
}

function buildPrompt(input: {
	query: string;
	evidence: ReflectEvidence[];
	responseSchema?: Record<string, unknown>;
}): string {
	const grouped = new Map<ReflectTier, ReflectEvidence[]>();
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

interface GatheredEvidence {
	hits: UnifiedMemorySearchResult[];
	warnings: UnifiedMemorySearchWarning[];
}

async function gatherRaw(
	deps: UnifiedSearchDeps,
	input: ReflectInput,
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
): Promise<GatheredEvidence> {
	if (!deps.searchRawMessagesAnn && !deps.searchRawMessagesLexical) {
		return { hits: [], warnings: [] };
	}
	const warnings: UnifiedMemorySearchWarning[] = [];
	const hits: UnifiedMemorySearchResult[] = [];

	const filters = input.botIds && input.botIds.length > 0 ? input.botIds : [undefined];

	if (typeof deps.searchRawMessagesAnn === "function" && typeof deps.embedQuery === "function") {
		try {
			const embedding = await deps.embedQuery({
				userId: input.userId,
				query: input.query,
				authToken: input.authToken,
			});
			const annResults = (
				await Promise.all(
					filters.map((botId) =>
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
			logger.warn?.("[memory-store] reflect: raw semantic search failed:", error);
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
						filters.map((botId) =>
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
				logger.warn?.("[memory-store] reflect: raw lexical search failed:", error);
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

async function gatherSummaries(
	deps: UnifiedSearchDeps,
	input: ReflectInput,
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
): Promise<GatheredEvidence> {
	if (typeof deps.searchSummaries !== "function") {
		return {
			hits: [],
			warnings: [
				{
					source: "memory",
					code: "reflect_summaries_unavailable",
					message: "Summary tier is not configured; reflect() ran without long-form summaries.",
				},
			],
		};
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
			dateFrom: input.dateFrom,
			dateTo: input.dateTo,
			authToken: input.authToken,
			...(peerPeers.length > 0 ? { peers: peerPeers } : {}),
		});
		const hits = rows.map(toSummaryResult);
		return { hits, warnings: [] };
	} catch (error) {
		logger.warn?.("[memory-store] reflect: summary search failed:", error);
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

async function gatherInsights(
	deps: UnifiedSearchDeps,
	input: ReflectInput,
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
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
		logger.warn?.("[memory-store] reflect: insights search failed:", error);
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
	input: ReflectInput,
	limit: number,
	threshold: number,
	logger: Pick<Console, "warn">,
	peerPeers: ReadonlyArray<Peer> = [],
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
		logger.warn?.("[memory-store] reflect: knowledge search failed:", error);
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

export async function reflect(
	deps: UnifiedSearchDeps,
	input: ReflectInput,
	logger: Pick<Console, "log" | "warn">,
): Promise<ReflectOutput> {
	const query = input.query.trim();
	const warnings: UnifiedMemorySearchWarning[] = [];
	const limit = clampUnifiedMemorySearchLimit(input.limit);
	const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
	const tiers = input.tiers && input.tiers.length > 0 ? input.tiers : DEFAULT_TIERS;

	if (!query) {
		return { answer: "", evidence: [], warnings };
	}

	// Resolve the optional `peerFilter` against the host's `peerScopeCheck`.
	const peerScope = await resolveScopePeer({
		userId: input.userId,
		peerFilter: input.peerFilter,
		scopeCheck: deps.peerScopeCheck,
	});
	warnings.push(...peerScope.warnings);
	const peerPeers = peerScope.peers;

	const tierTasks: Array<{ tier: ReflectTier; task: Promise<GatheredEvidence> }> = [];
	if (tiers.includes("summary"))
		tierTasks.push({
			tier: "summary",
			task: gatherSummaries(deps, input, limit, threshold, logger, peerPeers),
		});
	if (tiers.includes("raw"))
		tierTasks.push({ tier: "raw", task: gatherRaw(deps, input, limit, threshold, logger, peerPeers) });
	if (tiers.includes("insight"))
		tierTasks.push({
			tier: "insight",
			task: gatherInsights(deps, input, limit, threshold, logger, peerPeers),
		});
	if (tiers.includes("knowledge"))
		tierTasks.push({
			tier: "knowledge",
			task: gatherKnowledge(deps, input, limit, threshold, logger, peerPeers),
		});

	const settled = await Promise.all(tierTasks.map((t) => t.task));

	// Fuse the per-tier ranked lists with RRF rather than concatenating them
	// into a single list. Concatenation let RRF degenerate to insertion order
	// (summary → raw → insight → knowledge), so `limit` starved the more
	// relevant raw / insight / knowledge hits once summaries filled the
	// budget. Passing one ranked list per tier lets RRF interleave by
	// reciprocal rank across tiers, so the evidence actually reflects
	// relevance and the `limit` cap selects the top-ranked hits overall.
	const tierLists: Array<{ name: ReflectTier; hits: UnifiedMemorySearchResult[] }> = [];
	for (let i = 0; i < tierTasks.length; i += 1) {
		const bucket = settled[i];
		warnings.push(...bucket.warnings);
		if (bucket.hits.length > 0) {
			tierLists.push({ name: tierTasks[i].tier, hits: bucket.hits });
		}
	}

	const merged = mergeUnifiedMemorySearchResultsRrf(tierLists, limit);
	const ranked = deps.reranker ? await applyReranker(deps.reranker, query, merged) : merged;
	const evidence = ranked.map(makeReflectEvidence);

	const complete = deps.reasoning?.complete;
	if (!complete) {
		warnings.push({
			source: "memory",
			code: "reflect_llm_not_configured",
			message:
				"No `reasoning.complete` callback is configured; reflect() returned evidence without an LLM synthesis.",
		});
		return { answer: "", evidence, warnings };
	}

	const prompt = buildPrompt({ query, evidence, responseSchema: input.responseSchema });

	try {
		const raw = await complete(prompt);
		const answer = coerceAnswer(raw, input.responseSchema);
		logger.log?.("[memory-store] reflect synthesis completed", {
			evidenceCount: evidence.length,
			answerChars: answer.length,
		});
		return { answer, evidence, warnings };
	} catch (error) {
		logger.warn?.("[memory-store] reflect synthesis failed:", error);
		warnings.push({
			source: "memory",
			code: "reflect_llm_failed",
			message: (error as Error).message ?? "reflect_llm_failed",
		});
		return { answer: "", evidence, warnings };
	}
}
