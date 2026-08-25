/**
 * Tests for the `distill` primitive (entity extraction). Covers:
 *   - not-configured → empty edges + warning
 *   - configured extractor → returns edges + invokes persist
 *   - extractor throws → empty + `distill_extractor_failed`
 *   - invalid shape → empty + `distill_extractor_returned_invalid_shape`
 *   - persist throws → edges still returned, with `distill_persist_failed`
 */
import { describe, expect, it, vi } from "vitest";

import type { EntityEdge } from "@melandlabs/contracts/entity-edge";
import { distillRawMessage } from "./distill";

describe("distillRawMessage", () => {
	it("returns empty edges + not-configured warning when no extractor is wired", async () => {
		const out = await distillRawMessage(
			{},
			{
				userId: "u1",
				messageId: "m1",
				content: "I adopted a cat named Luna yesterday.",
			},
		);
		expect(out.edges).toEqual([]);
		expect(out.warnings).toEqual([
			{
				code: "distill_extractor_not_configured",
				message: expect.stringContaining("No `entityExtractor`"),
			},
		]);
	});

	it("invokes the extractor and persists the normalized edges", async () => {
		const edges: EntityEdge[] = [
			{
				label: "Luna",
				kind: "person",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 12345,
				confidence: 0.9,
			},
			{
				label: "  ACME Corp  ",
				kind: "org",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 12345,
			},
		];
		const extractor = vi.fn(async (_input: unknown) => edges);
		const persist = vi.fn(async (_edges: unknown) => undefined);

		const out = await distillRawMessage(
			{ entityExtractor: extractor },
			{
				userId: "u1",
				messageId: "m1",
				content: "I work at ACME Corp and my cat Luna rules.",
				persist,
			},
		);

		expect(extractor).toHaveBeenCalledTimes(1);
		expect(extractor).toHaveBeenCalledWith({
			userId: "u1",
			messageId: "m1",
			content: "I work at ACME Corp and my cat Luna rules.",
		});
		expect(persist).toHaveBeenCalledTimes(1);
		expect((persist.mock.calls[0] as unknown[][] | undefined)?.[0]).toHaveLength(2);
		expect(out.edges).toEqual([
			{
				label: "luna",
				kind: "person",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 12345,
				confidence: 0.9,
			},
			{
				label: "acme corp",
				kind: "org",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 12345,
			},
		]);
		expect(out.warnings).toEqual([]);
	});

	it("returns empty edges + extractor-failed warning when the extractor throws", async () => {
		const extractor = vi.fn(async () => {
			throw new Error("upstream down");
		});
		const persist = vi.fn(async () => undefined);

		const out = await distillRawMessage(
			{ entityExtractor: extractor },
			{
				userId: "u1",
				messageId: "m1",
				content: "anything",
				persist,
			},
		);

		expect(out.edges).toEqual([]);
		expect(persist).not.toHaveBeenCalled();
		expect(out.warnings).toEqual([
			{
				code: "distill_extractor_failed",
				message: "upstream down",
			},
		]);
	});

	it("returns empty edges + invalid-shape warning when the extractor returns non-array", async () => {
		const extractor = vi.fn(async () => null as unknown as EntityEdge[]);
		const out = await distillRawMessage(
			{ entityExtractor: extractor },
			{ userId: "u1", messageId: "m1", content: "x" },
		);
		expect(out.edges).toEqual([]);
		expect(out.warnings[0]?.code).toBe("distill_extractor_returned_invalid_shape");
	});

	it("drops malformed edges but keeps the well-formed ones", async () => {
		const edges = [
			{
				label: "ok",
				kind: "concept",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 1,
			},
			// Missing label
			{ kind: "person", relation: "mentions", sourceMessageId: "m1", extractedAt: 1 },
			// Empty label
			{ label: "", kind: "person", relation: "mentions", sourceMessageId: "m1", extractedAt: 1 },
			// Wrong relation type
			{
				label: "wrong",
				kind: "person",
				relation: 42 as unknown as string,
				sourceMessageId: "m1",
				extractedAt: 1,
			},
			// Unknown EntityKind value (closed enum) — must be dropped silently
			{
				label: "spaceship",
				kind: "spaceship",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 1,
			},
		] as unknown as EntityEdge[];
		const extractor = vi.fn(async () => edges);
		const out = await distillRawMessage(
			{ entityExtractor: extractor },
			{ userId: "u1", messageId: "m1", content: "x" },
		);
		expect(out.edges).toHaveLength(1);
		expect(out.edges[0]?.label).toBe("ok");
		expect(out.warnings).toEqual([]);
	});

	it("surfaces a persist-failed warning and still returns the edges when persist throws", async () => {
		const edges: EntityEdge[] = [
			{
				label: "Luna",
				kind: "person",
				relation: "mentions",
				sourceMessageId: "m1",
				extractedAt: 1,
			},
		];
		const extractor = vi.fn(async () => edges);
		const persist = vi.fn(async () => {
			throw new Error("db locked");
		});

		const out = await distillRawMessage(
			{ entityExtractor: extractor },
			{ userId: "u1", messageId: "m1", content: "x", persist },
		);

		expect(out.edges).toHaveLength(1);
		expect(out.warnings).toEqual([
			{
				code: "distill_persist_failed",
				message: "db locked",
			},
		]);
	});

	it("does not call persist when the extractor returns an empty list", async () => {
		const extractor = vi.fn(async () => []);
		const persist = vi.fn(async () => undefined);
		const out = await distillRawMessage(
			{ entityExtractor: extractor },
			{ userId: "u1", messageId: "m1", content: "x", persist },
		);
		expect(out.edges).toEqual([]);
		expect(persist).not.toHaveBeenCalled();
		expect(out.warnings).toEqual([]);
	});
});
