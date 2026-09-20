/**
 * @melandlabs/opencontext — context-compaction facade integration tests.
 *
 * Pairs with `memory-reasoning.integration.test.ts`: skip when
 * `OPENCONTEXT_LLM_API_KEY` is unset, otherwise feed a synthetic 4-message
 * conversation into `createCompactor({}).compact(...)` and assert the
 * summary is non-empty and both token counts come back positive.
 *
 * Run with:
 *   pnpm --filter @melandlabs/opencontext test:integration
 */

import { beforeAll, describe, expect, it } from "vitest";
import { hasLLMEnv, loadRepoEnv, pingLLMConnectivity, requireLLMEnv } from "./_integration-env";

import { createCompactor } from "./context-compaction";

const skipUnlessLLM = await hasLLMEnv();
const connectivityOk = skipUnlessLLM ? await pingLLMConnectivity() : false;

beforeAll(async () => {
	await loadRepoEnv();
});

describe.runIf(skipUnlessLLM && connectivityOk)("createCompactor facade (integration)", () => {
	it("summarizes a synthetic 4-message conversation end-to-end", async () => {
		const compactor = createCompactor(requireLLMEnv());

		const result = await compactor.compact({
			messages: [
				{ role: "user", content: "I adopted a black cat named Luna in March 2023." },
				{ role: "assistant", content: "Congratulations on adopting Luna! How old is she?" },
				{ role: "user", content: "She was a stray, so the vet estimated about 2 years old." },
				{ role: "assistant", content: "Got it — Luna is roughly 2, adopted March 2023." },
			],
			level: "soft",
		});

		expect(typeof result.summary).toBe("string");
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.messageCount).toBe(4);
		expect(result.level).toBe("soft");
		expect(result.originalTokens).toBeGreaterThan(0);
		expect(result.summaryTokens).toBeGreaterThan(0);
	}, 60_000);
});
