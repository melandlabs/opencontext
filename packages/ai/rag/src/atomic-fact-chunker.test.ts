import { describe, expect, it } from "vitest";

import type { AtomicFactProvider } from "./atomic-fact-chunker";
import { chunkAtomicFacts } from "./atomic-fact-chunker";

function provider(
	facts: Array<{ fact: string; confidence: number; sourceText?: string; factType?: unknown }>,
): AtomicFactProvider {
	return {
		decompose: async () => facts as never,
	};
}

describe("chunkAtomicFacts — factType handling", () => {
	it("passes through a valid factType from the provider", async () => {
		const chunks = await chunkAtomicFacts("Some text.", {
			provider: provider([{ fact: "Water boils at 100°C", confidence: 0.9, factType: "world" }]),
		});
		expect(chunks).toHaveLength(1);
		expect(chunks[0].factType).toBe("world");
	});

	it("drops facts with an invalid factType", async () => {
		const chunks = await chunkAtomicFacts("Some text.", {
			provider: provider([
				{ fact: "Bad classification", confidence: 0.9, factType: "preference" },
				{ fact: "I went hiking", confidence: 0.9, factType: "experience" },
			]),
		});
		expect(chunks.map((c) => c.factType)).toEqual(["experience"]);
	});

	it("leaves factType undefined when the provider omits it", async () => {
		const chunks = await chunkAtomicFacts("Some text.", {
			provider: provider([{ fact: "Just a plain fact", confidence: 0.9 }]),
		});
		expect(chunks).toHaveLength(1);
		expect(chunks[0].factType).toBeUndefined();
	});

	it("accepts mental_model classification", async () => {
		const chunks = await chunkAtomicFacts("Some text.", {
			provider: provider([{ fact: "I prefer trail running", confidence: 0.9, factType: "mental_model" }]),
		});
		expect(chunks[0].factType).toBe("mental_model");
	});
});
