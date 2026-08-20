/**
 * `opencontext stats` — vitest cases.
 *
 * Pattern matches `add.test.ts` / `search.test.ts`:
 *   1. parseStatsArgs — pure flag parsing.
 *   2. runStats — end-to-end via a mocked `@melandlabs/memory-store`,
 *      asserting (a) the call to `manager.getStats()`, (b) the stdout
 *      bytes for both human and `--json` paths, (c) the exit code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseStatsArgs, runStats } from "./stats";

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

// ── 1. parseStatsArgs ───────────────────────────────────────────────────────

describe("parseStatsArgs", () => {
	it("returns defaults when no flags are given", () => {
		expect(parseStatsArgs([])).toEqual({ json: false });
	});

	it("sets json=true on --json", () => {
		expect(parseStatsArgs(["--json"])).toEqual({ json: true });
	});

	it("throws on unknown flag", () => {
		expect(() => parseStatsArgs(["--user", "alice"])).toThrow(/unknown flag/);
	});
});

// ── 2. runStats (mocked SDK) ─────────────────────────────────────────────────

vi.mock("@melandlabs/memory-store", () => {
	const getStats = vi.fn();
	const manager = { getStats };
	return {
		getRawMessageManager: vi.fn(async () => manager),
		__mock: { getStats, manager },
	};
});

async function getMockStore() {
	const mod = await import("@melandlabs/memory-store");
	return mod as unknown as {
		__mock: {
			getStats: ReturnType<typeof vi.fn>;
			manager: unknown;
		};
	};
}

describe("runStats", () => {
	it("calls manager.getStats()", async () => {
		const { __mock } = await getMockStore();
		__mock.getStats.mockResolvedValueOnce({
			totalMessages: 0,
			messagesByPlatform: {},
			messagesByBot: {},
		});

		await runStats(parseStatsArgs([]));
		expect(__mock.getStats).toHaveBeenCalledTimes(1);
	});

	it("renders a multi-line human report by default", async () => {
		const { __mock } = await getMockStore();
		__mock.getStats.mockResolvedValueOnce({
			totalMessages: 42,
			messagesByPlatform: { cli: 30, slack: 12 },
			messagesByBot: { default: 25, support: 17 },
			oldestMessage: Date.parse("2026-01-01T00:00:00Z"),
			newestMessage: Date.parse("2026-08-20T00:00:00Z"),
		});

		const exit = await runStats(parseStatsArgs([]));
		expect(exit).toBe(0);
		const out = stdoutChunks.join("");
		expect(out).toContain("total messages: 42");
		expect(out).toContain("oldest:         2026-01-01T00:00:00.000Z");
		expect(out).toContain("newest:         2026-08-20T00:00:00.000Z");
		expect(out).toContain("by platform:");
		expect(out).toContain("cli              30");
		expect(out).toContain("slack            12");
		expect(out).toContain("by bot:");
		expect(out).toContain("default          25");
		expect(out).toContain("support          17");
	});

	it("omits platform/bot sections when the maps are empty", async () => {
		const { __mock } = await getMockStore();
		__mock.getStats.mockResolvedValueOnce({
			totalMessages: 0,
			messagesByPlatform: {},
			messagesByBot: {},
		});

		await runStats(parseStatsArgs([]));
		const out = stdoutChunks.join("");
		expect(out).not.toContain("by platform:");
		expect(out).not.toContain("by bot:");
		expect(out).not.toContain("oldest:");
		expect(out).not.toContain("newest:");
	});

	it("emits a JSON envelope on --json", async () => {
		const { __mock } = await getMockStore();
		__mock.getStats.mockResolvedValueOnce({
			totalMessages: 7,
			messagesByPlatform: { cli: 7 },
			messagesByBot: { default: 7 },
		});

		const exit = await runStats(parseStatsArgs(["--json"]));
		expect(exit).toBe(0);
		const parsed = JSON.parse(stdoutChunks.join("").trim()) as {
			ok: boolean;
			exit: number;
			stats: { totalMessages: number };
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.exit).toBe(0);
		expect(parsed.stats.totalMessages).toBe(7);
	});

	it("returns exit=1 with error envelope when getStats throws", async () => {
		const { __mock } = await getMockStore();
		__mock.getStats.mockRejectedValueOnce(new Error("backend down"));

		const exit = await runStats(parseStatsArgs([]));
		expect(exit).toBe(1);
		expect(stdoutChunks.join("")).toContain("error: backend down");
	});

	it("--json + backend failure emits a JSON error envelope", async () => {
		const { __mock } = await getMockStore();
		__mock.getStats.mockRejectedValueOnce(new Error("backend down"));

		await runStats(parseStatsArgs(["--json"]));
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
