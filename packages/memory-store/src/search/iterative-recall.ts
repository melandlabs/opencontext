/**
 * Iterative, LLM-driven memory retrieval.
 *
 * Instead of issuing one fixed query, a small planner model examines the
 * original question and the evidence collected so far, then decides:
 *   - search again with different keywords / time bounds
 *   - save some of the last results as evidence
 *   - finish gathering
 *
 * This trades latency and token cost for better evidence location on
 * multi-hop, temporal, or underspecified questions.
 *
 * The module is provider-agnostic: callers inject a `complete` callback.
 */

export interface IterativeRecallCandidate {
	id: string;
	content: string;
	similarity: number;
	metadata: Record<string, unknown>;
}

export interface IterativeRecallSearchRequest {
	keywords: string[];
	dateFrom?: string;
	dateTo?: string;
}

export interface IterativeRecallSearchResult {
	candidates: IterativeRecallCandidate[];
}

export interface IterativeRecallExecutor {
	search(request: IterativeRecallSearchRequest): Promise<IterativeRecallSearchResult>;
}

export interface IterativeRecallStats {
	iterations: number;
	searches: number;
	notes: number;
}

export interface IterativeRecallResult {
	/** Evidence selected by the planner, in the order it was collected. */
	evidence: IterativeRecallCandidate[];
	/** Diagnostic statistics. */
	stats: IterativeRecallStats;
}

export interface IterativeRecallPlanner {
	plan(input: {
		query: string;
		executor: IterativeRecallExecutor;
		options?: IterativeRecallPlannerOptions;
		/**
		 * Optional absolute date range for the search. The planner passes these
		 * bounds to the executor and may also emit narrower ranges in later actions.
		 */
		dateFrom?: string;
		dateTo?: string;
	}): Promise<IterativeRecallResult>;
	/**
	 * Optional. When implemented, returns true iff the most recent `plan()`
	 * could not run the planner as designed and fell back to a degraded
	 * result — for example the LLM call threw, every iteration produced an
	 * unparseable action, or the result relied on the fallback path
	 * (recent-hits or baseline search) because the planner never committed
	 * any evidence via a `note` action.
	 */
	lastDegraded?: () => boolean;
}

export interface IterativeRecallPlannerOptions {
	/** Maximum planner actions. @default 4 */
	maxIterations?: number;
	/** Results exposed to the planner per internal search. @default 5 */
	searchTopK?: number;
	/** When true, skip planning and return no evidence. @default false */
	disabled?: boolean;
	/**
	 * When true (default), if the planner finishes without noting any
	 * evidence the planner falls back to either the most recent hits or a
	 * baseline keyword search against the original query, so the call is
	 * never a total loss. Set to false to surface empty results honestly
	 * when the planner never committed anything.
	 * @default true
	 */
	fallbackToBaseline?: boolean;
}

export interface IterativeRecallPlannerDeps {
	/** LLM completion callback. */
	complete: (prompt: string) => Promise<string>;
	/** Default options. */
	options?: IterativeRecallPlannerOptions;
}

export type PlannerAction =
	| { type: "search"; keywords: string[]; dateFrom?: string; dateTo?: string }
	| { type: "note"; indices: number[] }
	| { type: "finish" };

const SYSTEM_PROMPT = `You are a research assistant collecting evidence from a user's conversation history. You are NOT answering the question; only gather the most useful memory.

Actions:
search — search by concise keywords. Previously returned chunks are automatically excluded.
Action Input: {"keywords":["keyword1","keyword2"],"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}
The date fields are optional; omit them unless an absolute date range is useful.

note — save relevant results from the LAST search by their 1-based result number.
Action Input: {"indices":[1,3]}

finish — finish collecting evidence.
Action Input: {}

Workflow: search -> note -> search again -> note -> finish.
Review every result. Call note before another search because the prior result list is replaced. Use diverse keywords on later searches. Never answer the question.

Output exactly:
Thought: one short sentence
Action: one action name
Action Input: valid JSON object`;

function deriveKeywordsFromQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length >= 2);
}

function formatDateHint(dateFrom?: string, dateTo?: string): string | undefined {
	if (!dateFrom && !dateTo) {
		return undefined;
	}
	const fromText = dateFrom ?? "the beginning";
	const toText = dateTo ?? "now";
	return `Restrict searches to the date range ${fromText} to ${toText}. You may still emit narrower date_from/date_to bounds when useful.`;
}

function buildInitialPrompt(query: string, dateHint?: string): string {
	const hintText = dateHint ? `\n${dateHint}` : "";
	return `${SYSTEM_PROMPT}\n\nQuestion to research: ${query}${hintText}\nSearch the conversation history and collect all relevant evidence. Start with a broad keyword search.`;
}

function buildObservationPrompt(hits: IterativeRecallCandidate[]): string {
	if (hits.length === 0) {
		return "Observation: No matching memory found.\nRespond with the next action only.";
	}

	const blocks = hits.map((hit, index) => {
		const lines = [`Result ${index + 1} | score=${hit.similarity.toFixed(4)}`];
		for (const line of hit.content.split("\n")) {
			if (line.trim()) lines.push(line);
		}
		return lines.join("\n");
	});

	return `Observation:\n${blocks.join("\n\n")}\n\nRespond with the next action only.`;
}

function stripCodeFences(text: string): string {
	return text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, "$1");
}

/**
 * Locate the first balanced JSON object starting at or after `start`, while
 * correctly handling strings and backslash escapes. Without the string-aware
 * state machine a string value like `{"keywords":["a {b} c"]}` would close
 * early at the first inner `}`.
 */
function extractJsonObject(text: string): string | undefined {
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

function parseAction(text: string): PlannerAction | null {
	const cleaned = stripCodeFences(text);
	const actionMatch = cleaned.match(/Action:\s*([\w_]+)/);
	if (!actionMatch) return null;

	const action = actionMatch[1].trim().toLowerCase();

	if (action === "finish") {
		return { type: "finish" };
	}

	const inputMatch = cleaned.match(/Action Input:\s*/s);
	if (!inputMatch || inputMatch.index === undefined) return null;

	const jsonText = extractJsonObject(cleaned.slice(inputMatch.index + inputMatch[0].length));
	if (!jsonText) return null;

	let parsedJson: Record<string, unknown> | null = null;
	for (const candidate of [jsonText, jsonText.replace(/'/g, '"')]) {
		try {
			parsedJson = JSON.parse(candidate) as Record<string, unknown>;
			break;
		} catch {
			// try next candidate
		}
	}
	if (!parsedJson) return null;

	if (action === "search") {
		const keywords = parsedJson.keywords;
		if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === "string")) {
			return null;
		}
		return {
			type: "search",
			keywords: keywords as string[],
			dateFrom: typeof parsedJson.date_from === "string" ? parsedJson.date_from : undefined,
			dateTo: typeof parsedJson.date_to === "string" ? parsedJson.date_to : undefined,
		};
	}

	if (action === "note") {
		const indices = parsedJson.indices;
		if (!Array.isArray(indices) || !indices.every((i) => typeof i === "number")) {
			return null;
		}
		return { type: "note", indices: indices as number[] };
	}

	return null;
}

export function createIterativeRecallPlanner(deps: IterativeRecallPlannerDeps): IterativeRecallPlanner {
	const { complete, options = {} } = deps;
	const defaults: Required<IterativeRecallPlannerOptions> = {
		maxIterations: 4,
		searchTopK: 5,
		disabled: false,
		fallbackToBaseline: true,
	};

	let lastDegraded = false;
	let iterationsWithValidAction = 0;

	return {
		lastDegraded: () => lastDegraded,
		async plan(input: {
			query: string;
			executor: IterativeRecallExecutor;
			options?: IterativeRecallPlannerOptions;
			dateFrom?: string;
			dateTo?: string;
		}): Promise<IterativeRecallResult> {
			const opts: Required<IterativeRecallPlannerOptions> = {
				...defaults,
				...options,
				...input.options,
			};
			lastDegraded = false;
			iterationsWithValidAction = 0;
			if (opts.disabled || !input.query.trim()) {
				return { evidence: [], stats: { iterations: 0, searches: 0, notes: 0 } };
			}

			const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: buildInitialPrompt(input.query, formatDateHint(input.dateFrom, input.dateTo)),
				},
			];

			const evidence = new Map<string, IterativeRecallCandidate>();
			const excludedIds = new Set<string>();
			let lastHits: IterativeRecallCandidate[] = [];
			let searches = 0;
			let notes = 0;
			let iterations = 0;
			let completeThrew = false;

			for (let i = 0; i < opts.maxIterations; i += 1) {
				iterations = i + 1;
				let reply: string;
				try {
					reply = await complete(messages.map((m) => `${m.role}: ${m.content}`).join("\n\n"));
				} catch {
					// Catch the LLM error locally so the planner degrades
					// gracefully (empty evidence + lastDegraded=true) instead
					// of bubbling up to the unified-search caller. This mirrors
					// the QueryRewriter pattern: surface degraded state through
					// lastDegraded() rather than via a thrown error.
					completeThrew = true;
					break;
				}
				messages.push({ role: "assistant", content: reply });

				const action = parseAction(reply);
				if (!action) {
					messages.push({
						role: "user",
						content:
							"Observation: Use exactly one valid action: search, note, or finish. Respond with the next action only.",
					});
					continue;
				}
				iterationsWithValidAction += 1;

				if (action.type === "finish") {
					break;
				}

				if (action.type === "search") {
					const result = await input.executor.search({
						keywords: action.keywords,
						dateFrom: action.dateFrom ?? input.dateFrom,
						dateTo: action.dateTo ?? input.dateTo,
					});
					lastHits = result.candidates.filter((c) => !excludedIds.has(c.id)).slice(0, opts.searchTopK);
					for (const hit of lastHits) {
						excludedIds.add(hit.id);
					}
					searches += 1;
					messages.push({ role: "user", content: buildObservationPrompt(lastHits) });
					continue;
				}

				if (action.type === "note") {
					let saved = 0;
					for (const index of action.indices) {
						if (index >= 1 && index <= lastHits.length) {
							const hit = lastHits[index - 1];
							if (!evidence.has(hit.id)) {
								evidence.set(hit.id, hit);
								saved += 1;
							}
						}
					}
					notes += saved;
					messages.push({
						role: "user",
						content: `Observation: Saved ${saved} new result(s). Total notes: ${evidence.size}.\nRespond with the next action only.`,
					});
				}
			}

			// If the planner never noted anything, fall back to the most recent hits
			// so the call is never a total loss. If there are no recent hits either,
			// run a baseline keyword search with the original query. Both fallback
			// paths are gated on `fallbackToBaseline` so callers that want honest
			// "planner committed zero evidence" semantics can opt out.
			// Either fallback counts as degraded for lastDegraded() purposes.
			let fallbackRan = false;
			if (evidence.size === 0 && opts.fallbackToBaseline) {
				fallbackRan = true;
				if (lastHits.length > 0) {
					for (const hit of lastHits) {
						if (!evidence.has(hit.id)) {
							evidence.set(hit.id, hit);
						}
					}
				} else {
					// Last resort: search with keywords derived from the original query
					// so the fallback is not a total loss, while still honouring the
					// caller-supplied date range.
					const baseline = await input.executor.search({
						keywords: deriveKeywordsFromQuery(input.query),
						dateFrom: input.dateFrom,
						dateTo: input.dateTo,
					});
					searches += 1;
					for (const hit of baseline.candidates.slice(0, opts.searchTopK)) {
						if (!evidence.has(hit.id)) {
							evidence.set(hit.id, hit);
						}
					}
				}
			}

			// Degraded when the planner did not deliver a deliberate result.
			// - LLM call threw mid-loop (no further iterations ran)
			// - every iteration produced an unparseable action
			// - the fallback path supplied the evidence the planner should have
			lastDegraded = completeThrew || iterationsWithValidAction === 0 || fallbackRan;

			return {
				evidence: Array.from(evidence.values()),
				stats: { iterations, searches, notes },
			};
		},
	};
}

/**
 * A no-op planner that never runs iterative retrieval.
 */
export function createIdentityIterativePlanner(): IterativeRecallPlanner {
	return {
		lastDegraded: () => false,
		async plan(): Promise<IterativeRecallResult> {
			return { evidence: [], stats: { iterations: 0, searches: 0, notes: 0 } };
		},
	};
}
