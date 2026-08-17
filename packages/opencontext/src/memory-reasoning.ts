/**
 * Convenience factories that wire opencontext's memory reasoning layer
 * (@melandlabs/memory-store/query-rewriter and iterative-recall) to a concrete
 * LLM provider.
 *
 * These factories are intentionally thin: they create a `complete` callback
 * from an OpenAI-compatible endpoint and hand it to the provider-agnostic
 * reasoning primitives in memory-store.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	type IterativeRecallPlanner,
	type IterativeRecallPlannerOptions,
	type QueryRewriter,
	type QueryRewriterOptions,
	createIdentityIterativePlanner,
	createIdentityRewriter,
	createIterativeRecallPlanner,
	createUserVoiceRewriter,
} from "@melandlabs/memory-store";
import { type LanguageModel, generateText } from "ai";

export interface ReasoningModelOptions {
	/** OpenAI-compatible API key. Falls back to OPENCONTEXT_LLM_API_KEY. */
	apiKey?: string;
	/** OpenAI-compatible base URL. Falls back to OPENCONTEXT_LLM_BASE_URL. */
	baseUrl?: string;
	/** Model identifier. Falls back to OPENCONTEXT_LLM_MODEL. */
	model?: string;
	/**
	 * A pre-built language model. When provided, apiKey/baseUrl/model are
	 * ignored.
	 */
	languageModel?: LanguageModel;
	/**
	 * Request timeout in milliseconds. @default 30000
	 */
	timeoutMs?: number;
}

function resolveEnv(key: string): string | undefined {
	if (typeof process !== "undefined" && process.env) {
		return process.env[key];
	}
	return undefined;
}

function resolveIntEnv(key: string, fallback: number): number {
	const raw = resolveEnv(key);
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function createModel(options: ReasoningModelOptions): LanguageModel {
	if (options.languageModel) {
		return options.languageModel;
	}

	const apiKey = options.apiKey ?? resolveEnv("OPENCONTEXT_LLM_API_KEY") ?? "";
	const baseUrl = options.baseUrl ?? resolveEnv("OPENCONTEXT_LLM_BASE_URL") ?? "https://openrouter.ai/api/v1";
	const modelName = options.model ?? resolveEnv("OPENCONTEXT_LLM_MODEL") ?? "openai/gpt-4o-mini";

	if (!apiKey) {
		throw new Error("Reasoning model API key is required. Set OPENCONTEXT_LLM_API_KEY or pass apiKey.");
	}

	return createOpenAICompatible({
		baseURL: baseUrl,
		apiKey,
		name: "opencontext-reasoning",
	}).chatModel(modelName);
}

function createComplete(options: ReasoningModelOptions) {
	const model = createModel(options);
	const timeoutMs = options.timeoutMs ?? 30000;

	return async (prompt: string): Promise<string> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		// `unref()` so a long-running `await` (test harness, hot reload, …) does
		// not pin the Node event loop on a timeout the caller never asked to
		// keep alive. The `clearTimeout` in `finally` keeps the active path
		// leak-free; the unref only matters when the timeout is the *only*
		// thing keeping the process alive.
		timeout.unref?.();

		try {
			const result = await generateText({
				model,
				prompt,
				temperature: 0,
				abortSignal: controller.signal,
			});
			return result.text.trim();
		} finally {
			clearTimeout(timeout);
		}
	};
}

/**
 * Create a query rewriter backed by an OpenAI-compatible LLM.
 *
 * The rewriter rephrases the assistant's question into a first-person
 * memory-check question (e.g. "Did I tell you about ...?"), which tends to
 * match the register of chat-log memories better.
 */
export function createQueryRewriter(
	modelOptions: ReasoningModelOptions,
	rewriterOptions?: Omit<QueryRewriterOptions, "complete">,
): QueryRewriter {
	const complete = createComplete(modelOptions);
	// Resolve env defaults the same way `createIterativePlanner` does so
	// hosts can tune either provider without touching code. Explicit
	// `rewriterOptions` always win over env.
	const envDefaults: Pick<QueryRewriterOptions, "maxVariants"> = {
		maxVariants: resolveIntEnv("OPENCONTEXT_LLM_REWRITER_MAX_VARIANTS", 1),
	};
	return createUserVoiceRewriter({
		complete,
		...envDefaults,
		...rewriterOptions,
	});
}

/**
 * Create an iterative recall planner backed by an OpenAI-compatible LLM.
 *
 * The planner searches, notes evidence, and searches again under LLM control,
 * which helps on multi-hop or temporally constrained questions.
 */
export function createIterativePlanner(
	modelOptions: ReasoningModelOptions,
	plannerOptions?: IterativeRecallPlannerOptions,
): IterativeRecallPlanner {
	const complete = createComplete(modelOptions);
	const options: IterativeRecallPlannerOptions = {
		maxIterations: resolveIntEnv("OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS", 4),
		searchTopK: resolveIntEnv("OPENCONTEXT_LLM_REASONING_SEARCH_TOP_K", 5),
		...plannerOptions,
	};
	return createIterativeRecallPlanner({
		complete,
		options,
	});
}

/**
 * Convenience bundle that creates both reasoning providers from the same
 * model configuration.
 */
export interface MemoryReasoningProviders {
	queryRewriter: QueryRewriter;
	iterativePlanner: IterativeRecallPlanner;
}

export function createMemoryReasoningProviders(
	modelOptions: ReasoningModelOptions,
	options?: {
		rewriter?: Omit<QueryRewriterOptions, "complete">;
		planner?: IterativeRecallPlannerOptions;
	},
): MemoryReasoningProviders {
	return {
		queryRewriter: createQueryRewriter(modelOptions, options?.rewriter),
		iterativePlanner: createIterativePlanner(modelOptions, options?.planner),
	};
}

/**
 * No-op providers for hosts that do not want reasoning. Using these keeps the
 * `reasoningStrategy` input ignored even when a default strategy is configured.
 */
export function createDisabledMemoryReasoningProviders(): MemoryReasoningProviders {
	return {
		queryRewriter: createIdentityRewriter(),
		iterativePlanner: createIdentityIterativePlanner(),
	};
}
