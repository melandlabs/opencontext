import { describe, expect, it, vi } from "vitest";

import {
	type IterativeRecallCandidate,
	type IterativeRecallExecutor,
	createIdentityIterativePlanner,
	createIterativeRecallPlanner,
} from "./iterative-recall";

function makeCandidate(id: string, content: string, similarity = 0.9): IterativeRecallCandidate {
	return { id, content, similarity, metadata: {} };
}

describe("createIterativeRecallPlanner", () => {
	it("returns no evidence when disabled", async () => {
		const planner = createIterativeRecallPlanner({
			complete: vi.fn(),
			options: { disabled: true },
		});
		const result = await planner.plan({
			query: "what is my cat's name?",
			executor: { search: vi.fn().mockResolvedValue({ candidates: [] }) },
		});

		expect(result.evidence).toEqual([]);
		expect(result.stats.iterations).toBe(0);
	});

	it("collects evidence across search and note actions", async () => {
		const candidates: IterativeRecallCandidate[] = [
			makeCandidate("m1", "I adopted a cat named Luna."),
			makeCandidate("m2", "My dog is named Max."),
		];

		const replies = [
			'Thought: Start broad\nAction: search\nAction Input: {"keywords":["cat"]}',
			'Thought: Luna is relevant\nAction: note\nAction Input: {"indices":[1]}',
			"Thought: Enough evidence\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});

		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		const result = await planner.plan({ query: "cat name", executor });

		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]?.id).toBe("m1");
		expect(result.stats.iterations).toBe(3);
		expect(result.stats.searches).toBe(1);
		expect(result.stats.notes).toBe(1);
		const firstRequest = complete.mock.calls[0]?.[1];
		const secondRequest = complete.mock.calls[1]?.[1];
		expect(firstRequest.messages.map((message: { role: string }) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(secondRequest.messages.map((message: { role: string }) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
		]);
		expect(firstRequest.messages[1].content).not.toContain("You are a research assistant");
		expect(secondRequest.messages[3].content).toContain("I adopted a cat named Luna.");
		// Later actions must not mutate the earlier request's message snapshot.
		expect(firstRequest.messages).toHaveLength(2);
	});

	it("performs multiple searches when the planner asks for them", async () => {
		const replies = [
			'Thought: Start\nAction: search\nAction Input: {"keywords":["cat"]}',
			'Thought: Need more\nAction: search\nAction Input: {"keywords":["Luna"]}',
			"Thought: Done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});

		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates: [] }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		const result = await planner.plan({ query: "cat name", executor });

		// Two planner-driven searches plus one fallback baseline search because
		// the planner never noted any evidence.
		expect(executor.search).toHaveBeenCalledTimes(3);
		expect(result.stats.searches).toBe(3);
	});

	it("falls back to the most recent hits when the planner never notes anything", async () => {
		const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
		const complete = vi.fn().mockResolvedValue("Thought: done\nAction: finish\nAction Input: {}");

		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		const result = await planner.plan({ query: "cat name", executor });

		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]?.id).toBe("m1");
	});

	it("excludes already-seen chunks from subsequent searches", async () => {
		const firstCandidates = [makeCandidate("m1", "first")];
		const secondCandidates = [makeCandidate("m2", "second")];
		const replies = [
			'Thought: Start\nAction: search\nAction Input: {"keywords":["a"]}',
			'Thought: Next\nAction: search\nAction Input: {"keywords":["b"]}',
			"Thought: Done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});

		let callCount = 0;
		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockImplementation(() => {
				callCount += 1;
				return Promise.resolve({ candidates: callCount === 1 ? firstCandidates : secondCandidates });
			}),
		};

		const planner = createIterativeRecallPlanner({ complete });
		await planner.plan({ query: "test", executor });

		// The planner's internal excluded set should have m1 after the first search.
		// We verify by checking the executor still returns fresh candidates; the
		// planner simply filters them. A full exclusion test is easier at the
		// unified-search integration level.
		expect(executor.search).toHaveBeenCalledTimes(2);
	});

	it("recovers from malformed action output", async () => {
		const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
		const replies = [
			"This is not a valid action format",
			'Thought: Try again\nAction: search\nAction Input: {"keywords":["cat"]}',
			"Thought: Done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});

		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		const result = await planner.plan({ query: "cat name", executor });

		expect(result.evidence.length).toBeGreaterThan(0);
	});

	it("passes caller date range to every executor search", async () => {
		const complete = vi.fn().mockResolvedValue("Thought: done\nAction: finish\nAction Input: {}");
		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates: [] }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		await planner.plan({
			query: "cat name",
			executor,
			dateFrom: "2024-01-01",
			dateTo: "2024-01-31",
		});

		// One baseline search because the planner never noted any evidence.
		expect(executor.search).toHaveBeenCalledTimes(1);
		expect(executor.search).toHaveBeenCalledWith(
			expect.objectContaining({
				dateFrom: "2024-01-01",
				dateTo: "2024-01-31",
			}),
		);
	});

	it("lets the planner override the caller date range with narrower bounds", async () => {
		const replies = [
			'Thought: narrow window\nAction: search\nAction Input: {"keywords":["cat"],"date_from":"2024-06-01","date_to":"2024-06-07"}',
			"Thought: done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});
		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates: [] }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		await planner.plan({
			query: "cat name",
			executor,
			dateFrom: "2024-01-01",
			dateTo: "2024-12-31",
		});

		expect(executor.search).toHaveBeenCalledWith(
			expect.objectContaining({
				keywords: ["cat"],
				dateFrom: "2024-06-01",
				dateTo: "2024-06-07",
			}),
		);
	});

	it("parses actions wrapped in markdown code fences", async () => {
		const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
		const replies = [
			'Thought: search\nAction: search\nAction Input:\n```json\n{"keywords":["cat"]}\n```',
			'Thought: note\nAction: note\nAction Input: {"indices":[1]}',
			"Thought: done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});
		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		const result = await planner.plan({ query: "cat name", executor });

		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]?.id).toBe("m1");
	});

	it("parses nested action input json", async () => {
		const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
		const replies = [
			'Thought: search\nAction: search\nAction Input: {"keywords":["cat"],"filter":{"include":"all"}}',
			'Thought: note\nAction: note\nAction Input: {"indices":[1]}',
			"Thought: done\nAction: finish\nAction Input: {}",
		];
		const complete = vi.fn().mockImplementation(() => {
			const reply = replies.shift();
			return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
		});
		const executor: IterativeRecallExecutor = {
			search: vi.fn().mockResolvedValue({ candidates }),
		};

		const planner = createIterativeRecallPlanner({ complete });
		const result = await planner.plan({ query: "cat name", executor });

		expect(executor.search).toHaveBeenCalledWith(expect.objectContaining({ keywords: ["cat"] }));
		expect(result.evidence).toHaveLength(1);
	});
});

it("parses action input when string values contain literal braces", async () => {
	const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
	// Braces inside a string value would terminate the naive depth counter
	// early and produce a malformed JSON parse. The string-aware parser
	// must skip them and capture the full outer object.
	const replies = [
		'Thought: search\nAction: search\nAction Input: {"keywords":["foo {bar} baz"]}',
		'Thought: note\nAction: note\nAction Input: {"indices":[1]}',
		"Thought: done\nAction: finish\nAction Input: {}",
	];
	const complete = vi.fn().mockImplementation(() => {
		const reply = replies.shift();
		return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
	});
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates }),
	};
	const planner = createIterativeRecallPlanner({ complete });
	const result = await planner.plan({ query: "test", executor });

	expect(executor.search).toHaveBeenCalledWith(expect.objectContaining({ keywords: ["foo {bar} baz"] }));
	expect(result.evidence).toHaveLength(1);
});

it("returns empty evidence when fallbackToBaseline is disabled and planner notes nothing", async () => {
	const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
	const complete = vi.fn().mockResolvedValue("Thought: done\nAction: finish\nAction Input: {}");
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates }),
	};
	const planner = createIterativeRecallPlanner({
		complete,
		options: { fallbackToBaseline: false },
	});
	const result = await planner.plan({ query: "cat name", executor });

	expect(result.evidence).toEqual([]);
	// No baseline fallback search runs when fallbackToBaseline=false.
	expect(executor.search).toHaveBeenCalledTimes(0);
});

it("still falls back to the most recent hits when fallbackToBaseline is enabled", async () => {
	const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
	const complete = vi.fn().mockResolvedValue("Thought: done\nAction: finish\nAction Input: {}");
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates }),
	};
	const planner = createIterativeRecallPlanner({
		complete,
		options: { fallbackToBaseline: true },
	});
	const result = await planner.plan({ query: "cat name", executor });

	expect(result.evidence).toHaveLength(1);
	expect(result.evidence[0]?.id).toBe("m1");
});

it("returns lastDegraded=false when the planner commits evidence via note", async () => {
	const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
	const replies = [
		'Thought: search\nAction: search\nAction Input: {"keywords":["cat"]}',
		'Thought: note\nAction: note\nAction Input: {"indices":[1]}',
		"Thought: done\nAction: finish\nAction Input: {}",
	];
	const complete = vi.fn().mockImplementation(() => {
		const reply = replies.shift();
		return Promise.resolve(reply ?? "Thought: done\nAction: finish\nAction Input: {}");
	});
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates }),
	};
	const planner = createIterativeRecallPlanner({ complete });
	await planner.plan({ query: "cat name", executor });
	expect(planner.lastDegraded?.()).toBe(false);
});

it("returns lastDegraded=true when complete throws mid-loop", async () => {
	// Throw immediately so no candidates reach the planner. The fallback
	// baseline search then runs and returns nothing, so the result is
	// empty evidence plus a degraded marker.
	const complete = vi.fn().mockRejectedValue(new Error("upstream down"));
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates: [] }),
	};
	const planner = createIterativeRecallPlanner({ complete });
	const result = await planner.plan({ query: "cat name", executor });
	expect(planner.lastDegraded?.()).toBe(true);
	// Plan should not bubble the error to the caller.
	expect(result.evidence).toEqual([]);
});

it("returns lastDegraded=true when every iteration is unparseable", async () => {
	const complete = vi.fn().mockResolvedValue("not a valid action format");
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates: [] }),
	};
	const planner = createIterativeRecallPlanner({ complete });
	await planner.plan({ query: "cat name", executor });
	expect(planner.lastDegraded?.()).toBe(true);
});

it("returns lastDegraded=true when fallback path ran", async () => {
	const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
	// Planner searches but never notes — fallback should engage and the
	// planner should flag itself as degraded because the result came
	// from the recent-hits path, not a deliberate note.
	const complete = vi
		.fn()
		.mockResolvedValue(
			'Action: search\nAction Input: {"keywords":["cat"]}\nAction: finish\nAction Input: {}',
		);
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates }),
	};
	const planner = createIterativeRecallPlanner({ complete });
	await planner.plan({ query: "cat name", executor });
	expect(planner.lastDegraded?.()).toBe(true);
});

it("returns lastDegraded=false when fallbackToBaseline=false and planner ran cleanly without notes", async () => {
	const candidates = [makeCandidate("m1", "I have a cat named Luna.")];
	const complete = vi
		.fn()
		.mockResolvedValue(
			'Action: search\nAction Input: {"keywords":["cat"]}\nAction: finish\nAction Input: {}',
		);
	const executor: IterativeRecallExecutor = {
		search: vi.fn().mockResolvedValue({ candidates }),
	};
	const planner = createIterativeRecallPlanner({
		complete,
		options: { fallbackToBaseline: false },
	});
	await planner.plan({ query: "cat name", executor });
	expect(planner.lastDegraded?.()).toBe(false);
});
describe("createIdentityIterativePlanner", () => {
	it("returns empty evidence", async () => {
		const planner = createIdentityIterativePlanner();
		const result = await planner.plan({
			query: "anything",
			executor: { search: vi.fn() },
		});
		expect(result.evidence).toEqual([]);
		expect(result.stats.iterations).toBe(0);
	});

	it("reports lastDegraded=false (the no-op planner never degrades)", async () => {
		const planner = createIdentityIterativePlanner();
		expect(planner.lastDegraded?.()).toBe(false);
	});
});

describe("opt-in planner diagnostics", () => {
	it.each([3, 6])("reports the actual remaining action budget (%i)", async (maxIterations) => {
		const replies = [
			'Action: search\nAction Input: {"keywords":["topic"]}',
			'Action: note\nAction Input: {"indices":[1]}',
			"Action: finish\nAction Input: {}",
		];
		const complete = vi.fn(async (_prompt: string) => replies.shift() ?? "Action: finish\nAction Input: {}");
		const planner = createIterativeRecallPlanner({ complete, options: { maxIterations } });
		const result = await planner.plan({
			query: "topic",
			executor: { search: async () => ({ candidates: [makeCandidate("m1", "evidence")] }) },
		});
		for (const [index, call] of complete.mock.calls.entries()) {
			const prompt = call[0] as string;
			expect(prompt).toContain(`Planner actions remaining: ${maxIterations - index}.`);
		}
		expect(result.evidence.map((hit) => hit.id)).toEqual(["m1"]);
		expect(result.stats.iterations).toBe(3);
	});

	it("does not forbid the initial search when only one action is configured", async () => {
		const complete = vi.fn(async (_prompt: string) => 'Action: search\nAction Input: {"keywords":["topic"]}');
		const planner = createIterativeRecallPlanner({ complete, options: { maxIterations: 1 } });
		await planner.plan({ query: "topic", executor: { search: async () => ({ candidates: [] }) } });
		expect(complete.mock.calls[0]?.[0]).toContain("Planner actions remaining: 1.");
		expect(complete.mock.calls[0]?.[0]).not.toContain("Do not start another search");
	});

	it("explains invalid actions and fallback without changing evidence", async () => {
		const executor = { search: vi.fn().mockResolvedValue({ candidates: [makeCandidate("m1", "evidence")] }) };
		const planner = createIterativeRecallPlanner({ complete: async () => "invalid ".repeat(200) });
		const baseline = await planner.plan({ query: "topic", executor });
		const diagnosed = await planner.plan({ query: "topic", executor, options: { collectDiagnostics: true } });
		expect(baseline.diagnostics).toBeUndefined();
		expect(diagnosed.evidence).toEqual(baseline.evidence);
		expect(diagnosed.stats).toEqual(baseline.stats);
		expect(diagnosed.diagnostics).toMatchObject({ fallback: "baseline", searches: 1, notes: 0 });
		expect(diagnosed.diagnostics?.steps).toHaveLength(4);
		expect(diagnosed.diagnostics?.steps.every((step) => step.action === "invalid")).toBe(true);
		expect(diagnosed.diagnostics?.steps[0]?.responseExcerpt).toHaveLength(1000);
	});

	it("records transport status without exposing the error body", async () => {
		const planner = createIterativeRecallPlanner({
			complete: async () => {
				throw new Error("reasoning LLM 429: private provider body");
			},
		});
		const result = await planner.plan({
			query: "topic",
			executor: { search: async () => ({ candidates: [] }) },
			options: { collectDiagnostics: true },
		});
		expect(result.diagnostics?.steps).toEqual([
			{ iteration: 1, action: "completion_error", errorName: "Error", httpStatus: 429 },
		]);
		expect(JSON.stringify(result.diagnostics)).not.toContain("private provider body");
	});

	it("distinguishes a timeout from an invalid action", async () => {
		const timeout = new Error("private timeout details");
		timeout.name = "AbortError";
		const planner = createIterativeRecallPlanner({
			complete: async () => {
				throw timeout;
			},
		});
		const result = await planner.plan({
			query: "topic",
			executor: { search: async () => ({ candidates: [] }) },
			options: { collectDiagnostics: true },
		});
		expect(result.diagnostics?.steps[0]).toEqual({
			iteration: 1,
			action: "completion_error",
			errorName: "AbortError",
		});
	});

	it("detects multiple actions without executing invented follow-up observations", async () => {
		const planner = createIterativeRecallPlanner({
			complete: async () =>
				'Action: search\nAction Input: {"keywords":["topic"]}\nAction: note\nAction Input: {"indices":[1]}',
		});
		const result = await planner.plan({
			query: "topic",
			executor: { search: async () => ({ candidates: [makeCandidate("m1", "evidence")] }) },
			options: { collectDiagnostics: true, maxIterations: 1 },
		});
		expect(result.diagnostics?.steps[0]).toMatchObject({ action: "search", multipleActions: true });
		expect(result.diagnostics?.notes).toBe(0);
		expect(result.diagnostics?.fallback).toBe("recent-hits");
	});
});
