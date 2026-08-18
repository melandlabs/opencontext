/**
 * Opencontext facade integration tests — exercise the thin LLM-provider
 * wiring in `memory-reasoning.ts` against a real OpenAI-compatible API
 * using credentials from the repo-root `.env`. Skipped automatically
 * when the env vars are missing or the endpoint is unreachable.
 *
 * Pairs with `@melandlabs/memory-store`'s `*.integration.test.ts` files:
 *   - those test the provider-agnostic primitives (createUserVoiceRewriter,
 *     createIterativeRecallPlanner) with a hand-rolled `complete` callback;
 *   - these test the opencontext facade factories
 *     (createQueryRewriter, createIterativePlanner) which build a real
 *     AI SDK model from env and call generateText().
 *
 * Run with:
 *   pnpm --filter @melandlabs/opencontext test:integration
 */

import { beforeAll, describe, expect, it } from "vitest";
import { hasLLMEnv, loadRepoEnv, pingLLMConnectivity, requireLLMEnv } from "./_integration-env";

import type { IterativeRecallExecutor } from "@melandlabs/memory-store";
import {
	createDisabledMemoryReasoningProviders,
	createIterativePlanner,
	createMemoryReasoningProviders,
	createQueryRewriter,
} from "./memory-reasoning";

const skipUnlessLLM = await hasLLMEnv();
// Connectivity probe: env vars may be present but the endpoint may still
// be unreachable (DNS, firewall, rate-limit). Either condition should
// skip the suite cleanly rather than fail assertions.
const connectivityOk = skipUnlessLLM ? await pingLLMConnectivity() : false;

beforeAll(async () => {
	await loadRepoEnv();
});

describe.runIf(skipUnlessLLM && connectivityOk)("createMemoryReasoningProviders facade (integration)", () => {
	it("createQueryRewriter reads env and returns a working rewriter", async () => {
		const rewriter = createQueryRewriter(requireLLMEnv());
		const variants = await rewriter.rewrite({
			query: "What is my favorite color?",
			userId: "integration-facade-u1",
		});

		// Expect original plus at least one valid rewrite that differs
		// from the original (case-insensitive).
		expect(variants.length).toBeGreaterThanOrEqual(2);
		expect(variants[0]).toBe("What is my favorite color?");
		const originalLower = "what is my favorite color?";
		const newVariants = variants.slice(1).filter((v) => v.toLowerCase() !== originalLower);
		expect(newVariants.length).toBeGreaterThanOrEqual(1);
	}, 30_000);

	it("createIterativePlanner reads env and runs a planner loop", async () => {
		const planner = createIterativePlanner(requireLLMEnv(), { maxIterations: 3 });
		const executor: IterativeRecallExecutor = {
			search: async () => ({
				candidates: [
					{
						id: "m1",
						content: "I told you I adopted a black cat named Luna in March 2023.",
						similarity: 0.95,
						metadata: {},
					},
				],
			}),
		};
		const result = await planner.plan({
			query: "When did I adopt Luna the cat?",
			executor,
		});

		// The smoke check: the planner loop ran, didn't blow up on
		// real LLM output (code fences, prose, etc.), and stats
		// match the budget.
		expect(Array.isArray(result.evidence)).toBe(true);
		expect(result.stats.iterations).toBeGreaterThan(0);
		expect(result.stats.iterations).toBeLessThanOrEqual(3);
		expect(result.stats.searches).toBeGreaterThanOrEqual(0);
		expect(result.stats.notes).toBeGreaterThanOrEqual(0);
	}, 60_000);

	it("createMemoryReasoningProviders bundles both factories with shared model config", async () => {
		const providers = createMemoryReasoningProviders(requireLLMEnv());
		expect(typeof providers.queryRewriter.rewrite).toBe("function");
		expect(typeof providers.iterativePlanner.plan).toBe("function");

		const variants = await providers.queryRewriter.rewrite({
			query: "Anything",
			userId: "integration-facade-u1",
		});
		// disabled=false on the inner rewriter, but with maxVariants=1
		// and LLM returning garbage it could degrade. Either way
		// variants should be a non-empty array.
		expect(Array.isArray(variants)).toBe(true);
		expect(variants.length).toBeGreaterThanOrEqual(1);
	}, 30_000);
});

describe("createDisabledMemoryReasoningProviders (no LLM needed)", () => {
	it("returns identity rewriter and identity planner without making any HTTP calls", async () => {
		const providers = createDisabledMemoryReasoningProviders();

		const variants = await providers.queryRewriter.rewrite({
			query: "hello",
			userId: "integration-facade-u1",
		});
		expect(variants).toEqual(["hello"]);

		const result = await providers.iterativePlanner.plan({
			query: "hello",
			executor: { search: async () => ({ candidates: [] }) },
		});
		expect(result.evidence).toEqual([]);
		expect(result.stats.iterations).toBe(0);
	});
});
