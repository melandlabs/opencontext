/**
 * `opencontext list` — vitest cases.
 *
 * Same two-layer split as the other CLI test files:
 *   1. parseListArgs — exhaustive flag parsing & validation, no I/O.
 *   2. runList — end-to-end via a mocked `@melandlabs/memory-store`,
 *      asserting (a) the `RawMessageQuery` actually passed to
 *      `manager.queryMessages`, (b) stdout bytes for human and `--json`,
 *      (c) the exit code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseListArgs, runList } from "./list";

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

// ── 1. parseListArgs ────────────────────────────────────────────────────────

describe("parseListArgs", () => {
	it("returns defaults when no flags are given", () => {
		expect(parseListArgs([])).toEqual({
			userId: "default",
			limit: 20,
			offset: 0,
			reverse: false,
			json: false,
		});
	});

	it("populates every filter and pagination flag", () => {
		expect(
			parseListArgs([
				"--user",
				"alice",
				"--platform",
				"cli",
				"--bot",
				"general",
				"--channel",
				"#eng",
				"--since",
				"2026-01-01",
				"--until",
				"2026-12-31",
				"--limit",
				"50",
				"--offset",
				"100",
				"--reverse",
				"--json",
			]),
		).toEqual({
			userId: "alice",
			platform: "cli",
			botId: "general",
			channel: "#eng",
			since: "2026-01-01",
			until: "2026-12-31",
			limit: 50,
			offset: 100,
			reverse: true,
			json: true,
		});
	});

	it("aliases --limit to -n", () => {
		expect(parseListArgs(["-n", "5"]).limit).toBe(5);
	});

	it("throws when --limit is not a positive integer", () => {
		expect(() => parseListArgs(["--limit", "0"])).toThrow(/--limit must be a positive integer/);
	});

	it("throws when --offset is negative", () => {
		expect(() => parseListArgs(["--offset", "-1"])).toThrow(/--offset must be >= 0/);
	});

	it("throws when --since is not ISO-8601", () => {
		expect(() => parseListArgs(["--since", "yesterday"])).toThrow(/--since\/--until expect ISO-8601/);
	});

	it("throws when --until is not ISO-8601", () => {
		expect(() => parseListArgs(["--until", "tomorrow"])).toThrow(/--since\/--until expect ISO-8601/);
	});

	it("throws on unknown flag", () => {
		expect(() => parseListArgs(["--wat"])).toThrow(/unknown flag/);
	});
});

// ── 2. runList (mocked SDK) ──────────────────────────────────────────────────

vi.mock("@melandlabs/memory-store", () => {
	const queryMessages = vi.fn();
	const manager = { queryMessages };
	return {
		getRawMessageManager: vi.fn(async () => manager),
		__mock: { queryMessages, manager },
	};
});

async function getMockStore() {
	const mod = await import("@melandlabs/memory-store");
	return mod as unknown as {
		__mock: {
			queryMessages: ReturnType<typeof vi.fn>;
			manager: unknown;
		};
	};
}

function makeRow(
	overrides: Partial<{
		id: number;
		messageId: string;
		timestamp: number;
		content: string;
		channel: string | undefined;
	}> = {},
) {
	return {
		id: 1,
		messageId: "uuid-1",
		platform: "cli",
		botId: "default",
		userId: "default",
		channel: undefined as string | undefined,
		person: undefined as string | undefined,
		timestamp: Date.parse("2026-08-20T10:00:00Z"),
		content: "hello world",
		createdAt: Date.parse("2026-08-20T10:00:00Z"),
		...overrides,
	};
}

describe("runList", () => {
	it("maps CLI flags to a RawMessageQuery verbatim", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([]);

		await runList(
			parseListArgs([
				"--user",
				"alice",
				"--platform",
				"slack",
				"--bot",
				"general",
				"--channel",
				"#eng",
				"--since",
				"2026-01-01",
				"--until",
				"2026-12-31",
				"--limit",
				"50",
				"--offset",
				"10",
				"--reverse",
			]),
		);
		const query = __mock.queryMessages.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(query).toEqual({
			userId: "alice",
			platform: "slack",
			botId: "general",
			channel: "#eng",
			startTime: Date.parse("2026-01-01"),
			endTime: Date.parse("2026-12-31"),
			limit: 50,
			offset: 10,
			reverse: true,
		});
	});

	it("uses 'default' as userId when --user is omitted", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([]);

		await runList(parseListArgs([]));
		const query = __mock.queryMessages.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(query.userId).toBe("default");
	});

	it("omits startTime/endTime when --since/--until are absent", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([]);

		await runList(parseListArgs([]));
		const query = __mock.queryMessages.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(query.startTime).toBeUndefined();
		expect(query.endTime).toBeUndefined();
	});

	it("renders human lines with timestamp, platform/bot/user, and content preview", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([
			makeRow({ id: 42, messageId: "uuid-aaa", content: "Discussed Q4 roadmap" }),
		]);

		const exit = await runList(parseListArgs([]));
		expect(exit).toBe(0);
		const out = stdoutChunks.join("");
		expect(out).toContain("# 1 message for user=default");
		expect(out).toContain("[2026-08-20T10:00:00.000Z] #42 cli/default@default — Discussed Q4 roadmap");
		expect(out).toContain("messageId: uuid-aaa");
	});

	it("includes the channel in the human line when set", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([makeRow({ channel: "#eng" })]);

		await runList(parseListArgs([]));
		const out = stdoutChunks.join("");
		expect(out).toContain("cli/default/#eng@default");
	});

	it("truncates long content with an ellipsis", async () => {
		const { __mock } = await getMockStore();
		const long = "x".repeat(400);
		__mock.queryMessages.mockResolvedValueOnce([makeRow({ content: long })]);

		await runList(parseListArgs([]));
		const out = stdoutChunks.join("");
		expect(out).toContain("…");
		expect(out).not.toContain("x".repeat(200)); // would mean no truncation
	});

	it("prints '(no messages …)' when the result set is empty", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([]);

		await runList(parseListArgs([]));
		expect(stdoutChunks.join("")).toContain("(no messages for user=default)");
	});

	it("emits a JSON envelope on --json", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockResolvedValueOnce([makeRow()]);

		const exit = await runList(parseListArgs(["--json"]));
		expect(exit).toBe(0);
		const parsed = JSON.parse(stdoutChunks.join("").trim()) as {
			ok: boolean;
			exit: number;
			count: number;
			results: Array<{ messageId: string }>;
			query: Record<string, unknown>;
		};
		expect(parsed.ok).toBe(true);
		expect(parsed.exit).toBe(0);
		expect(parsed.count).toBe(1);
		expect(parsed.results[0]?.messageId).toBe("uuid-1");
		expect(parsed.query.userId).toBe("default");
	});

	it("returns exit=1 with error envelope when queryMessages throws", async () => {
		const { __mock } = await getMockStore();
		__mock.queryMessages.mockRejectedValueOnce(new Error("db locked"));

		const exit = await runList(parseListArgs([]));
		expect(exit).toBe(1);
		expect(stdoutChunks.join("")).toContain("error: db locked");
	});
});
