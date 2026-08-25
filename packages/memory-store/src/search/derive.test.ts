/**
 * Tests for the `derive` primitive. Covers:
 *   - not-configured → empty facts + warning
 *   - configured deriver + candidateTexts passthrough → returns facts
 *   - no candidateTexts → SDK uses lexical fallback to pull candidates
 *   - deriver throws → empty + `derive_deriver_failed`
 *   - invalid shape → empty + `derive_deriver_returned_invalid_shape`
 *   - persist throws → facts still returned with `derive_persist_failed`
 */
import { describe, expect, it, vi } from "vitest";

import type { DerivedFact } from "@melandlabs/contracts/derived-fact";
import { deriveFacts } from "./derive";

const sampleFacts: DerivedFact[] = [
	{
		text: "User has mentioned cats 5 times this month",
		kind: "frequency",
		sources: ["m1", "m2", "m3"],
		window: { from: 1704067200000, to: 1706745600000 },
		confidence: 0.8,
		derivedAt: 12345,
	},
	{
		text: "User prefers tuna over salmon for their cat",
		kind: "summary",
		sources: ["m4"],
		confidence: 0.6,
		derivedAt: 12345,
	},
];

describe("deriveFacts", () => {
	it("returns empty facts + not-configured warning when no deriver is wired", async () => {
		const out = await deriveFacts({}, { userId: "u1", candidateTexts: ["x", "y"] });
		expect(out.facts).toEqual([]);
		expect(out.warnings).toEqual([
			{
				code: "derive_deriver_not_configured",
				message: expect.stringContaining("No `deriver`"),
			},
		]);
	});

	it("passes candidateTexts through to the deriver and returns facts", async () => {
		const deriver = vi.fn(async () => sampleFacts);
		const persist = vi.fn(async (_edges: unknown) => undefined);

		const out = await deriveFacts(
			{ deriver },
			{
				userId: "u1",
				botIds: ["bot-a"],
				dateFrom: "2024-01-01",
				dateTo: "2024-01-31",
				window: { from: 1704067200000, to: 1706745600000 },
				candidateTexts: ["mention 1", "mention 2", "mention 3"],
				persist,
			},
		);

		expect(deriver).toHaveBeenCalledTimes(1);
		expect(deriver).toHaveBeenCalledWith({
			userId: "u1",
			userScope: {
				userId: "u1",
				botIds: ["bot-a"],
				dateFrom: "2024-01-01",
				dateTo: "2024-01-31",
			},
			recentFactTexts: ["mention 1", "mention 2", "mention 3"],
			window: { from: 1704067200000, to: 1706745600000 },
		});
		expect(persist).toHaveBeenCalledTimes(1);
		expect((persist.mock.calls[0] as unknown[][] | undefined)?.[0]).toHaveLength(2);
		expect(out.facts).toEqual(sampleFacts);
		expect(out.warnings).toEqual([]);
	});

	it("uses the lexical fallback to pull candidates when none are passed", async () => {
		const deriver = vi.fn(async (_input: unknown) => sampleFacts);
		const searchRawMessagesLexical = vi.fn(async (_input: unknown) => [
			{
				id: "m1",
				content: "candidate text 1",
				similarity: 0.5,
				metadata: {},
			},
			{
				id: "m2",
				content: "candidate text 2",
				similarity: 0.4,
				metadata: {},
			},
		]);

		const out = await deriveFacts(
			{ deriver, searchRawMessagesLexical },
			{ userId: "u1", query: "cat preferences", botIds: ["bot-a"] },
		);

		expect(searchRawMessagesLexical).toHaveBeenCalledTimes(1);
		const lexicalCall = searchRawMessagesLexical.mock.calls[0]?.[0] as { keywords: string[] } | undefined;
		// Caller-supplied query drives the keyword derivation — not userId/botIds.
		expect(lexicalCall?.keywords).toEqual(["cat", "preferences"]);
		expect(deriver).toHaveBeenCalledTimes(1);
		const call = deriver.mock.calls[0]?.[0] as { recentFactTexts: string[] } | undefined;
		expect(call?.recentFactTexts).toEqual(["candidate text 1", "candidate text 2"]);
		expect(out.facts).toEqual(sampleFacts);
		expect(out.warnings).toEqual([]);
	});

	it("falls back to userId+botIds for keyword derivation when no query is passed", async () => {
		const deriver = vi.fn(async (_input: unknown) => sampleFacts);
		const searchRawMessagesLexical = vi.fn(async (_input: unknown) => [
			{
				id: "m1",
				content: "candidate text 1",
				similarity: 0.5,
				metadata: {},
			},
		]);

		const out = await deriveFacts({ deriver, searchRawMessagesLexical }, { userId: "u1", botIds: ["bot-a"] });

		expect(searchRawMessagesLexical).toHaveBeenCalledTimes(1);
		const lexicalCall = searchRawMessagesLexical.mock.calls[0]?.[0] as { keywords: string[] } | undefined;
		// Best-effort fallback: tokens come from userId + botIds joined.
		expect(lexicalCall?.keywords).toEqual(["u1", "bot"]);
		expect(out.facts).toEqual(sampleFacts);
	});

	it("returns empty facts + deriver-failed warning when the deriver throws", async () => {
		const deriver = vi.fn(async () => {
			throw new Error("llm down");
		});
		const out = await deriveFacts({ deriver }, { userId: "u1", candidateTexts: ["x"] });
		expect(out.facts).toEqual([]);
		expect(out.warnings).toEqual([
			{
				code: "derive_deriver_failed",
				message: "llm down",
			},
		]);
	});

	it("returns empty facts + invalid-shape warning when the deriver returns non-array", async () => {
		const deriver = vi.fn(async () => null as unknown as DerivedFact[]);
		const out = await deriveFacts({ deriver }, { userId: "u1", candidateTexts: ["x"] });
		expect(out.facts).toEqual([]);
		expect(out.warnings[0]?.code).toBe("derive_deriver_returned_invalid_shape");
	});

	it("surfaces a persist-failed warning and still returns the facts when persist throws", async () => {
		const deriver = vi.fn(async () => sampleFacts);
		const persist = vi.fn(async () => {
			throw new Error("db locked");
		});
		const out = await deriveFacts({ deriver }, { userId: "u1", candidateTexts: ["x"], persist });
		expect(out.facts).toEqual(sampleFacts);
		expect(out.warnings).toEqual([
			{
				code: "derive_persist_failed",
				message: "db locked",
			},
		]);
	});

	it("emits derive_no_candidates (plus a fallback-query noise warning) when no candidates can be loaded", async () => {
		const deriver = vi.fn(async () => sampleFacts);
		const out = await deriveFacts({ deriver }, { userId: "u1" });
		expect(deriver).not.toHaveBeenCalled();
		expect(out.facts).toEqual([]);
		expect(out.warnings).toEqual([
			{
				code: "derive_fallback_query_noise",
				message: expect.any(String),
			},
			{
				code: "derive_no_candidates",
				message: expect.any(String),
			},
		]);
	});

	it("drops malformed facts but keeps well-formed ones", async () => {
		const facts = [
			{
				text: "ok",
				kind: "summary",
				sources: ["m1"],
				derivedAt: 1,
			},
			// Missing text
			{ kind: "summary", sources: ["m1"], derivedAt: 1 },
			// Empty text
			{ text: "", kind: "summary", sources: ["m1"], derivedAt: 1 },
			// Wrong sources shape
			{ text: "bad", kind: "summary", sources: "m1", derivedAt: 1 },
			// Unknown DerivedKind value (closed enum) — must be dropped silently
			{
				text: "weird",
				kind: "made_up_kind",
				sources: ["m1"],
				derivedAt: 1,
			},
		] as unknown as DerivedFact[];
		const deriver = vi.fn(async () => facts);
		const out = await deriveFacts({ deriver }, { userId: "u1", candidateTexts: ["x"] });
		expect(out.facts).toHaveLength(1);
		expect(out.facts[0]?.text).toBe("ok");
	});
});
