import { describe, expect, it } from "vitest";

import { createLoCoMoSample } from "./dataset";

describe("LoCoMo dataset validation", () => {
	it("accepts V2 questions without evidence and skips rows without answers", () => {
		const sample = createLoCoMoSample({
			sample_id: "conv-26",
			conversation: { session_1: [] },
			qa: [
				{ question: "Where did they go?", answer: "Paris", category: 4 },
				{ question: "Unsupported premise?", category: 5 },
			],
		});

		expect(sample.qa_pairs).toEqual([
			{ question: "Where did they go?", answer: "Paris", category: 4, evidence: [] },
		]);
	});

	it("rejects malformed evidence instead of silently fabricating attribution", () => {
		expect(() =>
			createLoCoMoSample({
				sample_id: "conv-26",
				conversation: { session_1: [] },
				qa: [
					{
						question: "Where did they go?",
						answer: "Paris",
						category: 4,
						evidence: ["D1:3", 7] as unknown as string[],
					},
				],
			}),
		).toThrow("invalid evidence");
	});
});
