/**
 * Query rewriting for memory retrieval.
 *
 * The memory corpus is usually a first-person chat log ("I told you ...",
 * "I prefer ..."). A query asked in the assistant's register ("What does the
 * user prefer?") often misses the best evidence. A rewriter rephrases the
 * question into the register the memory was written in, improving dense
 * retrieval without changing the underlying index.
 *
 * The module is provider-agnostic: callers inject a `complete` callback that
 * talks to whatever LLM they already use.
 */

export interface QueryRewriterInput {
	query: string;
	userId: string;
	authToken?: string;
}

export interface QueryRewriter {
	/**
	 * Return one or more query variants. The first element is always the
	 * original query; subsequent elements are rewritten variants.
	 */
	rewrite(input: QueryRewriterInput): Promise<string[]>;
	/**
	 * Optional hook that reports whether the most recent `rewrite` call
	 * silently degraded to the original query (for example because the LLM
	 * call failed or produced no usable variants).
	 */
	lastDegraded?(): boolean;
}

export interface QueryRewriterOptions {
	/**
	 * LLM completion callback. Receives the full prompt and returns the raw
	 * model output. The rewriter parses the output and falls back to the
	 * original query on any failure.
	 */
	complete: (prompt: string) => Promise<string>;
	/**
	 * Maximum number of rewritten variants to return in addition to the
	 * original query. Use `0` to return only the original. Higher values ask
	 * the LLM for more alternatives and multiply embedding/search cost
	 * proportionally, so callers should bound it (typical: 1–3).
	 * @default 1
	 */
	maxVariants?: number;
	/**
	 * When true, the rewriter returns only the original query and skips the
	 * LLM call. Useful as a kill-switch.
	 * @default false
	 */
	disabled?: boolean;
}

const SYSTEM_PROMPT = `You are a memory retrieval assistant.

The memory store contains a user's past messages, written in the first person (e.g. "I told you about my sister's wedding", "I prefer dark mode").

Your job is NOT to answer the question. Your job is to rewrite the assistant's question into a short, natural question that the USER would ask their own memory log to find the relevant entry.

Rules:
- Use first person: "Did I tell you about ...?", "What did I say about ...?", "Have I mentioned ...?"
- Do NOT address the user as "you".
- Do NOT answer the question.
- Output each rephrasing on its own line, prefixed with "- ".
- Keep each rephrasing under 20 words.
- Output exactly the requested number of lines.`;

function buildPrompt(query: string, numVariants: number): string {
	const label = numVariants === 1 ? "1 alternative rephrasing" : `${numVariants} alternative rephrasings`;
	return `${SYSTEM_PROMPT}

Output exactly ${label}.

Example:
Question: What is the name of my cat?
- Did I tell you the name of my cat?

Question: ${query}
Output:`;
}

function sanitizeLine(text: string): string {
	return text
		.replace(/^\s*["'`]+|["'`]+\s*$/g, "")
		.replace(/^Rewritten:\s*/i, "")
		.trim();
}

/**
 * Parse the model output into up to `maxVariants` variants.
 *
 * The prompt requests a bullet list (one variant per line, prefixed with
 * `- `). For backward compatibility we also accept a single bare sentence
 * with no bullet (the legacy prompt format). Anything that doesn't
 * structurally match returns an empty array and the caller falls back to
 * the original query.
 */
function parseVariants(raw: string, maxVariants: number, original: string): string[] {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => sanitizeLine(line.replace(/^\s*-\s+/, "")))
		.filter((line) => line.length > 0);

	if (lines.length === 0) return [];

	// Dedup against the original (case-insensitive) and across each other.
	const seen = new Set<string>([original.toLowerCase()]);
	const variants: string[] = [];
	for (const line of lines) {
		if (variants.length >= maxVariants) break;
		const key = line.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		variants.push(line);
	}
	return variants;
}

export function createUserVoiceRewriter(options: QueryRewriterOptions): QueryRewriter {
	const { complete, maxVariants = 1, disabled = false } = options;
	const wantedVariants = Math.max(0, Math.floor(maxVariants));
	let lastDegraded = false;

	return {
		async rewrite(input: QueryRewriterInput): Promise<string[]> {
			if (disabled || !input.query || !input.query.trim()) {
				lastDegraded = false;
				return [input.query];
			}

			const original = input.query.trim();
			if (wantedVariants === 0) {
				lastDegraded = false;
				return [original];
			}

			try {
				const raw = await complete(buildPrompt(original, wantedVariants));
				const variants = parseVariants(raw, wantedVariants, original);
				if (variants.length === 0) {
					lastDegraded = true;
					return [original];
				}
				lastDegraded = false;
				return [original, ...variants];
			} catch {
				// Degrade gracefully: the caller can still search with the original query.
				lastDegraded = true;
				return [original];
			}
		},
		lastDegraded(): boolean {
			return lastDegraded;
		},
	};
}

/**
 * A no-op rewriter that always returns the original query.
 */
export function createIdentityRewriter(): QueryRewriter {
	return {
		async rewrite(input: QueryRewriterInput): Promise<string[]> {
			return [input.query];
		},
	};
}
