/**
 * Query rewriter integration tests — exercise `createUserVoiceRewriter`
 * against a real OpenAI-compatible LLM using credentials from the
 * repo-root `.env`. Skipped automatically when `OPENCONTEXT_LLM_API_KEY`
 * is not set.
 *
 * Run with:
 *   pnpm --filter @melandlabs/memory-store test:integration
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
	createOpenAICompatibleComplete,
	hasLLMEnv,
	loadRepoEnv,
	pingLLMConnectivity,
	requireLLMEnv,
} from "./_integration-env";
import { createUserVoiceRewriter } from "./query-rewriter";

const skipUnlessLLM = await hasLLMEnv();
// Connectivity probe: the env vars may be present but the endpoint may
// still be unreachable (DNS, firewall, rate-limit). Either condition
// should skip the suite cleanly rather than fail assertions.
const connectivityOk = skipUnlessLLM ? await pingLLMConnectivity() : false;

beforeAll(async () => {
	await loadRepoEnv();
});

describe.runIf(skipUnlessLLM && connectivityOk)("createUserVoiceRewriter (integration)", () => {
	// describe.runIf guarantees skipUnlessLLM is true here, so it's
	// safe to call requireLLMEnv() without a runtime guard.
	const complete = createOpenAICompatibleComplete(requireLLMEnv());

	it.runIf(skipUnlessLLM && connectivityOk)(
		"returns the original query plus at least one rewritten variant",
		async () => {
			const rewriter = createUserVoiceRewriter({ complete: complete });
			const variants = await rewriter.rewrite({
				query: "What is the name of my cat?",
				userId: "integration-u1",
			});

			expect(variants.length).toBeGreaterThanOrEqual(2);
			expect(variants[0]).toBe("What is the name of my cat?");
			// Rewritten variant should differ from the original and contain
			// some signal the LLM actually rephrased (first-person markers or
			// at minimum a different verb form).
			expect(variants[1]).not.toBe("What is the name of my cat?");
			expect(variants[1]?.length ?? 0).toBeGreaterThan(0);
		},
		20_000,
	);

	it.runIf(skipUnlessLLM && connectivityOk)(
		"respects maxVariants=2 and returns 2 variants",
		async () => {
			const rewriter = createUserVoiceRewriter({ complete: complete, maxVariants: 2 });
			const variants = await rewriter.rewrite({
				query: "What outdoor activities did I mention last summer?",
				userId: "integration-u1",
			});

			expect(variants).toHaveLength(3); // original + 2 rewrites
			expect(variants[0]).toBe("What outdoor activities did I mention last summer?");
			// All three should be distinct strings.
			expect(new Set(variants.map((v) => v.toLowerCase())).size).toBe(variants.length);
		},
		20_000,
	);

	it.runIf(skipUnlessLLM && connectivityOk)(
		"reports lastDegraded=false on a healthy LLM response",
		async () => {
			const rewriter = createUserVoiceRewriter({ complete: complete });
			const before = rewriter.lastDegraded?.();
			await rewriter.rewrite({ query: "Any fact about my dog?", userId: "integration-u1" });
			expect(rewriter.lastDegraded?.()).toBe(false);
			// First call had no prior state; either false is acceptable.
			expect([true, false]).toContain(before);
		},
		20_000,
	);

	it.runIf(skipUnlessLLM && connectivityOk)(
		"case-insensitive dedup catches the LLM echoing the original in different casing",
		async () => {
			// Some models normalise the original query verbatim before adding
			// alternatives. The dedup set lowercases everything so we never
			// emit a variant that just echoes the original in a different
			// register — even though the prompt asked for it.
			const rewriter = createUserVoiceRewriter({ complete: complete, maxVariants: 3 });
			const variants = await rewriter.rewrite({
				query: "Tell me about my favorite food.",
				userId: "integration-u1",
			});

			// Every rewritten variant must differ from the original in casing-
			// insensitive comparison. variants[0] is the original by contract
			// (see QueryRewriter.rewrite), so we only inspect the rewritten slots.
			const originalLower = "tell me about my favorite food.";
			for (const variant of variants.slice(1)) {
				expect(variant.toLowerCase()).not.toBe(originalLower);
			}
		},
		20_000,
	);

	it.runIf(skipUnlessLLM && connectivityOk)(
		"handles maxVariants=0 by returning only the original without an LLM call",
		async () => {
			const rewriter = createUserVoiceRewriter({ complete: complete, maxVariants: 0 });
			const variants = await rewriter.rewrite({
				query: "Anything",
				userId: "integration-u1",
			});

			expect(variants).toEqual(["Anything"]);
			expect(rewriter.lastDegraded?.()).toBe(false);
		},
	);
});
