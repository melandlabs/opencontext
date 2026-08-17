/**
 * @melandlabs/opencontext — reasoning-backed memory retrieval facade.
 *
 * These tests verify the thin wiring layer in `memory-reasoning.ts` without
 * calling a real LLM. The actual query-rewriting / iterative-planning logic is
 * tested inside `@melandlabs/memory-store`; here we only confirm that the
 * facade factories assemble provider-agnostic primitives correctly and honor
 * the documented configuration shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LanguageModel } from "ai";

import {
	createDisabledMemoryReasoningProviders,
	createIterativePlanner,
	createMemoryReasoningProviders,
	createQueryRewriter,
} from "./memory-reasoning";

const generateTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
	const original = await importOriginal<typeof import("ai")>();
	return {
		...original,
		generateText: (...args: Parameters<typeof original.generateText>) => generateTextMock(...args),
	};
});

function fakeModel(): LanguageModel {
	return {
		specificationVersion: "v1",
		provider: "test-provider",
		modelId: "test-model",
		defaultObjectGenerationMode: "json",
		doGenerate: vi.fn(),
		doStream: vi.fn(),
	} as unknown as LanguageModel;
}

describe("memory-reasoning facade", () => {
	beforeEach(() => {
		generateTextMock.mockReset();
	});

	it("createQueryRewriter returns a rewriter object wired to the supplied model", async () => {
		generateTextMock.mockResolvedValue({ text: "Did I mention hiking?" });

		const rewriter = createQueryRewriter({ languageModel: fakeModel() });
		expect(typeof rewriter.rewrite).toBe("function");

		const variants = await rewriter.rewrite({ query: "hiking", userId: "u-1" });
		expect(variants).toContain("hiking");
		expect(variants).toContain("Did I mention hiking?");
		expect(generateTextMock).toHaveBeenCalledTimes(1);
	});

	it("createIterativePlanner returns a planner object wired to the supplied model", async () => {
		generateTextMock.mockResolvedValue({
			text: "Action: finish\nAction Input: {}",
		});

		const planner = createIterativePlanner({ languageModel: fakeModel() });
		expect(typeof planner.plan).toBe("function");

		const result = await planner.plan({
			query: "hiking",
			executor: { search: async () => ({ candidates: [] }) },
		});
		expect(result.evidence).toEqual([]);
		expect(generateTextMock).toHaveBeenCalledTimes(1);
	});

	it("createMemoryReasoningProviders bundles both factories", () => {
		const providers = createMemoryReasoningProviders({
			languageModel: fakeModel(),
		});
		expect(typeof providers.queryRewriter.rewrite).toBe("function");
		expect(typeof providers.iterativePlanner.plan).toBe("function");
	});

	it("createDisabledMemoryReasoningProviders returns no-op identity providers", async () => {
		const providers = createDisabledMemoryReasoningProviders();

		const variants = await providers.queryRewriter.rewrite({
			query: "hello",
			userId: "u-1",
		});
		expect(variants).toEqual(["hello"]);

		const result = await providers.iterativePlanner.plan({
			query: "hello",
			executor: { search: async () => ({ candidates: [] }) },
		});
		expect(result.evidence).toEqual([]);
		expect(result.stats.iterations).toBe(0);
	});

	it("throws a clear error when no API key or language model is supplied", () => {
		expect(() => createQueryRewriter({})).toThrow(/Reasoning model API key is required/);
		expect(() => createIterativePlanner({})).toThrow(/Reasoning model API key is required/);
	});

	it("falls back to OPENCONTEXT_LLM_API_KEY when no explicit key is provided", () => {
		const previousLlmKey = process.env.OPENCONTEXT_LLM_API_KEY;
		process.env.OPENCONTEXT_LLM_API_KEY = "deepseek-flash-test-key";

		try {
			// Should not throw: the LLM key is picked up from the environment.
			expect(() => createQueryRewriter({})).not.toThrow();
			expect(() => createIterativePlanner({})).not.toThrow();
		} finally {
			process.env.OPENCONTEXT_LLM_API_KEY = previousLlmKey;
		}
	});

	it("honors OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS and SEARCH_TOP_K", async () => {
		const previousMaxIterations = process.env.OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS;
		const previousSearchTopK = process.env.OPENCONTEXT_LLM_REASONING_SEARCH_TOP_K;
		process.env.OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS = "2";
		process.env.OPENCONTEXT_LLM_REASONING_SEARCH_TOP_K = "3";

		generateTextMock.mockResolvedValue({
			text: 'Action: search\nAction Input: {"keywords":["test"]}',
		});

		try {
			const planner = createIterativePlanner({ languageModel: fakeModel() });
			const result = await planner.plan({
				query: "hiking",
				executor: { search: async () => ({ candidates: [] }) },
			});
			expect(result.stats.iterations).toBe(2);
		} finally {
			process.env.OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS = previousMaxIterations;
			process.env.OPENCONTEXT_LLM_REASONING_SEARCH_TOP_K = previousSearchTopK;
		}
	});
});
