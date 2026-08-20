/**
 * `opencontext search` — vitest cases.
 *
 * Two layers, mirroring `add.test.ts`:
 *
 *   1. parseSearchArgs — pure flag parsing & validation, no I/O.
 *
 *   2. runSearch — end-to-end via a mocked `@melandlabs/memory-store`. We
 *      assert:
 *        a. the `SearchInput` actually passed to `store.search` (esp. that
 *           `--mode` correctly drives `mergeStrategy` / `sources`, and
 *           that `synthesize: false` is always set so `--context-only`
 *           never spends an LLM call),
 *        b. what got written to `process.stdout` for each output mode
 *           (human / --json / --context-only / --explain),
 *        c. the returned exit code.
 *
 * `vi.clearAllMocks()` runs in `afterEach` so each test sees its own
 * `store.search` mock state cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchInput, SearchOutput } from "@melandlabs/memory-store";

import { parseSearchArgs, runSearch } from "./search";

// ── stdout capture plumbing ─────────────────────────────────────────────────

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stdoutChunks: string[];

beforeEach(() => {
	stdoutChunks = [];
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : (chunk as Uint8Array).toString());
		return true;
	}) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
	stdoutSpy.mockRestore();
	vi.clearAllMocks();
});

// ── 1. parseSearchArgs ──────────────────────────────────────────────────────

describe("parseSearchArgs", () => {
	it("returns defaults when only required flags are given", () => {
		expect(parseSearchArgs(["--user", "alice", "--query", "x"])).toEqual({
			userId: "alice",
			query: "x",
			mode: "auto",
			k: 10,
			botIds: [],
			kinds: [],
			contextOnly: false,
			json: false,
			explain: false,
		});
	});

	it("aliases --query to -q and --k to --limit", () => {
		expect(parseSearchArgs(["--user", "alice", "-q", "x", "--limit", "5"])).toEqual(
			expect.objectContaining({ query: "x", k: 5 }),
		);
	});

	it("populates every output / filter flag", () => {
		expect(
			parseSearchArgs([
				"--user",
				"alice",
				"--query",
				"x",
				"--mode",
				"lex",
				"--k",
				"20",
				"--threshold",
				"0.5",
				"--bot",
				"general",
				"--bot",
				"support",
				"--kind",
				"experience",
				"--since",
				"2026-01-01",
				"--until",
				"2026-12-31",
				"--context-only",
				"--json",
				"--explain",
			]),
		).toEqual({
			userId: "alice",
			query: "x",
			mode: "lex",
			k: 20,
			threshold: 0.5,
			botIds: ["general", "support"],
			kinds: ["experience"],
			since: "2026-01-01",
			until: "2026-12-31",
			contextOnly: true,
			json: true,
			explain: true,
		});
	});

	it("accepts all three documented modes", () => {
		for (const mode of ["auto", "lex", "sem"] as const) {
			expect(parseSearchArgs(["--user", "alice", "--query", "x", "--mode", mode]).mode).toBe(mode);
		}
	});

	it("throws on unknown --mode", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--mode", "bogus"])).toThrow(
			/--mode must be one of: auto, lex, sem/,
		);
	});

	it("throws when --k is not a positive integer", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--k", "0"])).toThrow(
			/--k must be a positive integer/,
		);
	});

	it("throws when --k is non-numeric", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--k", "abc"])).toThrow(
			/--k must be a positive integer/,
		);
	});

	it("throws when --threshold is out of [0, 1]", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--threshold", "1.5"])).toThrow(
			/--threshold must be in \[0, 1\]/,
		);
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--threshold", "-0.1"])).toThrow(
			/--threshold must be in \[0, 1\]/,
		);
	});

	it("throws when --since is not ISO-8601", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--since", "yesterday"])).toThrow(
			/--since\/--until expect ISO-8601/,
		);
	});

	it("throws when --until is not ISO-8601", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--until", "tomorrow"])).toThrow(
			/--since\/--until expect ISO-8601/,
		);
	});

	it("defaults userId to 'default' when --user is omitted", () => {
		expect(parseSearchArgs(["--query", "x"]).userId).toBe("default");
	});

	it("throws when --query is missing", () => {
		expect(() => parseSearchArgs(["--user", "alice"])).toThrow(/--query <text> is required/);
	});

	it("throws on unknown flag", () => {
		expect(() => parseSearchArgs(["--user", "alice", "--query", "x", "--wat"])).toThrow(/unknown flag/);
	});
});

// ── 2. runSearch (mocked SDK) ───────────────────────────────────────────────

vi.mock("@melandlabs/memory-store", () => {
	const search = vi.fn();
	const store = { search };
	return {
		createMemoryStore: vi.fn(async () => store),
		__mock: { search, store },
	};
});

async function getMockStore() {
	const mod = await import("@melandlabs/memory-store");
	return mod as unknown as {
		__mock: {
			search: ReturnType<typeof vi.fn>;
			store: unknown;
		};
	};
}

function makeOutput(overrides: Partial<SearchOutput> = {}): SearchOutput {
	return {
		query: "x",
		sources: ["memory", "insights", "knowledge"],
		count: 1,
		results: [
			{
				id: "r1",
				type: "memory",
				content: "discussed the roadmap with the team",
				similarity: 0.87,
				metadata: {},
			},
		],
		evidence: [
			{
				id: "r1",
				source: "memory",
				score: 0.87,
				snippet: "discussed the roadmap with the team",
				timestamp: Date.parse("2026-08-20T10:00:00Z"),
			},
		],
		reasoning: { strategy: "iterative", degraded: false, iterations: 2 },
		warnings: [],
		...overrides,
	};
}

describe("runSearch", () => {
	it("mode=auto maps to mergeStrategy='rrf' with no sources override", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x"]));
		const input = __mock.search.mock.calls[0]?.[0] as SearchInput;
		expect(input.mergeStrategy).toBe("rrf");
		expect(input.sources).toBeUndefined();
		// Critical invariant: never synthesize from the CLI.
		expect(input.synthesize).toBe(false);
	});

	it("mode=lex maps to mergeStrategy='similarity' with default sources", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x", "--mode", "lex"]));
		const input = __mock.search.mock.calls[0]?.[0] as SearchInput;
		expect(input.mergeStrategy).toBe("similarity");
		expect(input.sources).toBeUndefined();
		expect(input.synthesize).toBe(false);
	});

	it("mode=sem maps to mergeStrategy='similarity' + sources=['memory']", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x", "--mode", "sem"]));
		const input = __mock.search.mock.calls[0]?.[0] as SearchInput;
		expect(input.mergeStrategy).toBe("similarity");
		expect(input.sources).toEqual(["memory"]);
		expect(input.synthesize).toBe(false);
	});

	it("maps --bot and --kind to botIds and factTypes", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(
			parseSearchArgs([
				"--user",
				"alice",
				"--query",
				"x",
				"--bot",
				"general",
				"--bot",
				"support",
				"--kind",
				"experience",
				"--kind",
				"world",
			]),
		);
		const input = __mock.search.mock.calls[0]?.[0] as SearchInput;
		expect(input.botIds).toEqual(["general", "support"]);
		expect(input.factTypes).toEqual(["experience", "world"]);
	});

	it("omits botIds/factTypes when no --bot/--kind are given", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x"]));
		const input = __mock.search.mock.calls[0]?.[0] as SearchInput;
		expect(input.botIds).toBeUndefined();
		expect(input.factTypes).toBeUndefined();
	});

	it("passes --threshold, --since, --until through verbatim", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(
			parseSearchArgs([
				"--user",
				"alice",
				"--query",
				"x",
				"--threshold",
				"0.42",
				"--since",
				"2026-01-01",
				"--until",
				"2026-12-31",
			]),
		);
		const input = __mock.search.mock.calls[0]?.[0] as SearchInput;
		expect(input.threshold).toBeCloseTo(0.42);
		expect(input.dateFrom).toBe("2026-01-01");
		expect(input.dateTo).toBe("2026-12-31");
	});

	it("--context-only prints prompt context and returns exit 0", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		const exit = await runSearch(parseSearchArgs(["--user", "alice", "--query", "x", "--context-only"]));
		expect(exit).toBe(0);
		const out = stdoutChunks.join("");
		expect(out).toContain("# context-only — what would be sent to the LLM");
		expect(out).toContain('user=alice query="x"');
		expect(out).toContain("count=1");
		expect(out).toContain("[0.870] memory @ ");
		expect(out).toContain("id: r1");
		expect(out).toContain("discussed the roadmap");
	});

	it("--json prints the full SearchOutput envelope", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput({ count: 2 }));

		const exit = await runSearch(parseSearchArgs(["--user", "alice", "--query", "x", "--json"]));
		expect(exit).toBe(0);
		const parsed = JSON.parse(stdoutChunks.join("").trim()) as {
			ok: boolean;
			exit: number;
			query: string;
			count: number;
			results: unknown[];
			evidence: unknown[];
			reasoning: unknown;
			warnings: unknown[];
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.exit).toBe(0);
		expect(parsed.query).toBe("x");
		expect(parsed.count).toBe(2);
		expect(Array.isArray(parsed.results)).toBe(true);
		expect(Array.isArray(parsed.evidence)).toBe(true);
		expect(parsed.reasoning).toBeDefined();
		expect(Array.isArray(parsed.warnings)).toBe(true);
	});

	it("default human output prints per-hit lines with score", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput());

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x"]));
		const out = stdoutChunks.join("");
		expect(out).toContain("[0.870] memory:r1 — discussed the roadmap");
		expect(out).not.toContain("# reasoning");
	});

	it("prints '(no results …)' when count is zero", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(makeOutput({ count: 0, results: [] }));

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x"]));
		expect(stdoutChunks.join("")).toContain('(no results for query "x")');
	});

	it("--explain appends reasoning and warning lines to the human output", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockResolvedValueOnce(
			makeOutput({
				reasoning: { strategy: "iterative", degraded: true, iterations: 1 },
				warnings: [{ code: "vec_fallback", source: "memory", message: "vec index missing" }],
			}),
		);

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x", "--explain"]));
		const out = stdoutChunks.join("");
		expect(out).toContain("# reasoning: strategy=iterative (degraded) iterations=1");
		expect(out).toContain("# warnings:");
		expect(out).toContain("- [vec_fallback] memory: vec index missing");
	});

	it("returns exit=1 with an error envelope when store.search throws", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockRejectedValueOnce(new Error("backend down"));

		const exit = await runSearch(parseSearchArgs(["--user", "alice", "--query", "x"]));
		expect(exit).toBe(1);
		expect(stdoutChunks.join("")).toContain("error: backend down");
	});

	it("--json + backend failure emits a JSON error envelope", async () => {
		const { __mock } = await getMockStore();
		__mock.search.mockRejectedValueOnce(new Error("backend down"));

		await runSearch(parseSearchArgs(["--user", "alice", "--query", "x", "--json"]));
		const parsed = JSON.parse(stdoutChunks.join("").trim()) as {
			ok: boolean;
			exit: number;
			error: string;
		};
		expect(parsed.ok).toBe(false);
		expect(parsed.exit).toBe(1);
		expect(parsed.error).toBe("backend down");
	});
});
