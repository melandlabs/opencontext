import { describe, expect, it, vi } from "vitest";

import { type SearchRuntimeContext, resolveSearchRuntimeContext } from "./applicability";
import { createUnifiedSearch } from "./unified-search";

describe("resolveSearchRuntimeContext", () => {
	it("preserves legacy behaviour when no runtime context is supplied", () => {
		const now = vi.fn(() => 1_700_000_000_000);

		expect(resolveSearchRuntimeContext({ asOf: "not-a-timestamp" }, undefined, now)).toBeUndefined();
		expect(now).not.toHaveBeenCalled();
	});

	it("distinguishes an explicit empty context list and captures time once", () => {
		const contexts = [] as const;
		const now = vi.fn(() => 1_700_000_000_000);

		const resolved = resolveSearchRuntimeContext(
			{ asOf: undefined },
			{ applicabilityContexts: contexts },
			now,
		);

		expect(resolved).toEqual({ applicabilityContexts: [], applicabilityAt: 1_700_000_000_000 });
		expect(resolved?.applicabilityContexts).toBe(contexts);
		expect(now).toHaveBeenCalledTimes(1);
	});

	it("parses asOf once and preserves the supplied contexts by reference", () => {
		const contexts = [{ scope: "project" as const, key: "project-a" }] as const;
		const now = vi.fn(() => 1_800_000_000_000);
		const asOf = "2026-01-15T00:00:00.000Z";

		const resolved = resolveSearchRuntimeContext({ asOf }, { applicabilityContexts: contexts }, now);

		expect(resolved?.applicabilityContexts).toBe(contexts);
		expect(resolved?.applicabilityAt).toBe(Date.parse(asOf));
		expect(now).not.toHaveBeenCalled();
	});

	it.each([{ scope: "project" }, { scope: "project", key: "" }, { scope: "project", key: "   " }])(
		"rejects a keyless non-global context %#",
		(context) => {
			expect(() =>
				resolveSearchRuntimeContext({}, { applicabilityContexts: [context] } as Parameters<
					typeof resolveSearchRuntimeContext
				>[1]),
			).toThrow(/key must be non-empty/);
		},
	);

	it("allows a global context without a key", () => {
		expect(
			resolveSearchRuntimeContext({}, { applicabilityContexts: [{ scope: "global" }] }, () => 123),
		).toEqual({ applicabilityContexts: [{ scope: "global" }], applicabilityAt: 123 });
	});

	it.each([
		[{ scope: "workspace", key: "w1" }],
		[{ scope: "project", key: 42 }],
		[{ scope: "project", key: "project-a", validFrom: Number.NaN }],
		[{ scope: "project", key: "project-a", validUntil: Number.POSITIVE_INFINITY }],
	])("rejects malformed applicability contexts %#", (applicabilityContexts) => {
		expect(() =>
			resolveSearchRuntimeContext({}, { applicabilityContexts } as unknown as Parameters<
				typeof resolveSearchRuntimeContext
			>[1]),
		).toThrow(/memory-store search runtime context/);
	});

	it("rejects a missing applicabilityContexts array", () => {
		expect(() =>
			resolveSearchRuntimeContext({}, {} as Parameters<typeof resolveSearchRuntimeContext>[1]),
		).toThrow(/applicabilityContexts must be an array/);
	});

	it("rejects an unparseable asOf only when runtime scoping is enabled", () => {
		expect(() =>
			resolveSearchRuntimeContext(
				{ asOf: "not-a-timestamp" },
				{ applicabilityContexts: [{ scope: "project", key: "project-a" }] },
			),
		).toThrow(/asOf must be a parseable timestamp/);

		expect(resolveSearchRuntimeContext({ asOf: "not-a-timestamp" }, undefined)).toBeUndefined();
	});
});

describe("search runtime boundary", () => {
	it("rejects invalid trusted contexts before invoking a search provider", async () => {
		const searchRawMessagesLexical = vi.fn(async () => []);
		const search = createUnifiedSearch({ searchRawMessagesLexical });
		const invalidRuntime = {
			applicabilityContexts: [{ scope: "project" }],
		} as unknown as SearchRuntimeContext;

		await expect(search.search({ userId: "u1", query: "anything" }, invalidRuntime)).rejects.toThrow(
			/key must be non-empty/,
		);
		expect(searchRawMessagesLexical).not.toHaveBeenCalled();
	});
});
