/**
 * Iterative recall planner integration tests — exercise
 * `createIterativeRecallPlanner` against a real OpenAI-compatible LLM
 * using credentials from the repo-root `.env`. Skipped automatically
 * when `OPENCONTEXT_LLM_API_KEY` is not set.
 *
 * Run with:
 *   pnpm --filter @melandlabs/memory-store test:integration
 *
 * Smoke-level only. They guard against regressions in the prompt format
 * and JSON parser that the unit tests with hand-rolled replies can't
 * catch (e.g. real LLMs occasionally emit code-fenced JSON, extra
 * prose, or markdown bullet markers).
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
	createOpenAICompatibleComplete,
	hasLLMEnv,
	loadRepoEnv,
	pingLLMConnectivity,
	requireLLMEnv,
} from "./_integration-env";
import {
	type IterativeRecallCandidate,
	type IterativeRecallExecutor,
	createIterativeRecallPlanner,
} from "./iterative-recall";

const skipUnlessLLM = await hasLLMEnv();
// Connectivity probe: the env vars may be present but the endpoint may
// still be unreachable (DNS, firewall, rate-limit). Either condition
// should skip the suite cleanly rather than fail assertions.
const connectivityOk = skipUnlessLLM ? await pingLLMConnectivity() : false;

beforeAll(async () => {
	await loadRepoEnv();
});

function makeCandidate(id: string, content: string, similarity = 0.9): IterativeRecallCandidate {
	return { id, content, similarity, metadata: {} };
}

describe.runIf(skipUnlessLLM && connectivityOk)("createIterativeRecallPlanner (integration)", () => {
	const complete = createOpenAICompatibleComplete(requireLLMEnv());

	it.runIf(skipUnlessLLM && connectivityOk)(
		"runs the planner loop with a real executor and returns a valid result",
		async () => {
			const candidates: IterativeRecallCandidate[] = [
				makeCandidate("m1", "I told you I adopted a black cat named Luna in March 2023."),
				makeCandidate("m2", "My dog Mochi likes to eat salmon."),
			];
			const executor: IterativeRecallExecutor = {
				search: async () => ({ candidates }),
			};
			const planner = createIterativeRecallPlanner({
				complete: complete,
				options: { maxIterations: 4 },
			});
			const result = await planner.plan({
				query: "When did I adopt Luna the cat?",
				executor,
			});

			// The smoke check: the planner loop ran, didn't blow up on real
			// LLM output (code fences, prose around JSON, etc.), and the
			// stats match the budget. Evidence is allowed to be empty —
			// the planner may finish without committing.
			expect(Array.isArray(result.evidence)).toBe(true);
			expect(result.stats.iterations).toBeGreaterThan(0);
			expect(result.stats.iterations).toBeLessThanOrEqual(4);
			expect(result.stats.searches).toBeGreaterThanOrEqual(0);
			expect(result.stats.notes).toBeGreaterThanOrEqual(0);
		},
		60_000,
	);

	it.runIf(skipUnlessLLM && connectivityOk)(
		"reports lastDegraded=false on a clean run",
		async () => {
			const executor: IterativeRecallExecutor = {
				search: async () => ({
					candidates: [makeCandidate("m1", "I went hiking on Mount Tamalpais last weekend.")],
				}),
			};
			const planner = createIterativeRecallPlanner({ complete: complete });
			await planner.plan({ query: "What outdoor activities did I do recently?", executor });
			// Degraded=false iff the planner either noted evidence or
			// finished without invoking fallback. Both are clean runs.
			expect(planner.lastDegraded?.()).toBe(false);
		},
		60_000,
	);

	it.runIf(skipUnlessLLM && connectivityOk)(
		"respects maxIterations cap and does not loop forever",
		async () => {
			const executor: IterativeRecallExecutor = {
				search: async () => ({
					candidates: [makeCandidate("m1", "Some memory content here.")],
				}),
			};
			const planner = createIterativeRecallPlanner({
				complete: complete,
				options: { maxIterations: 2 },
			});
			const result = await planner.plan({ query: "Tell me about anything.", executor });

			expect(result.stats.iterations).toBeLessThanOrEqual(2);
		},
		60_000,
	);
});
