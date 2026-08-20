/**
 * `opencontext add` — vitest cases.
 *
 * Splits cleanly in two:
 *
 *   1. parseAddArgs — exhaustive flag parsing & validation, no I/O.
 *      Mirrors how `doctor.test.ts` covers `parseDoctorArgs`.
 *
 *   2. runAdd — end-to-end via a mocked `@melandlabs/memory-store` so the
 *      test never touches real storage. We assert three things per case:
 *        a. what got passed to `manager.storeMessages` (the SDK contract),
 *        b. what got written to `process.stdout` (the CLI contract),
 *        c. the returned exit code.
 *
 * `process.stdout.write` is spied via `vi.spyOn` and restored in a shared
 * `afterEach` so we can read the bytes the CLI would have emitted. That
 * mirrors how the rest of the opencontext CLI tests handle I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RawMessage } from "@melandlabs/memory-store";

import { parseAddArgs, runAdd } from "./add";

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

// ── 1. parseAddArgs ────────────────────────────────────────────────────────

describe("parseAddArgs", () => {
	it("returns defaults when only required flags are given", () => {
		expect(parseAddArgs(["--user", "alice", "--text", "hi"])).toEqual({
			userId: "alice",
			botId: "default",
			text: "hi",
			tags: {},
		});
	});

	it("populates identity, provenance and override fields", () => {
		const opts = parseAddArgs([
			"--user",
			"alice",
			"--bot",
			"general",
			"--text",
			"discussed roadmap",
			"--source",
			"meeting://2026-08-20",
			"--kind",
			"experience",
			"--platform",
			"slack",
			"--at",
			"2026-08-20T10:00:00Z",
			"--channel",
			"#eng",
			"--person",
			"u_42",
			"--json",
		]);
		expect(opts).toEqual({
			userId: "alice",
			botId: "general",
			text: "discussed roadmap",
			tags: {},
			source: "meeting://2026-08-20",
			kind: "experience",
			platform: "slack",
			at: "2026-08-20T10:00:00Z",
			channel: "#eng",
			person: "u_42",
			json: true,
		});
	});

	it("parses --tag k=v with space separator", () => {
		expect(parseAddArgs(["--user", "alice", "--text", "x", "--tag", "topic=roadmap"]).tags).toEqual({
			topic: "roadmap",
		});
	});

	it("parses --tag=k=v with equals separator", () => {
		expect(parseAddArgs(["--user", "alice", "--text", "x", "--tag=team=eng"]).tags).toEqual({ team: "eng" });
	});

	it("accumulates multiple --tag flags across both forms", () => {
		const opts = parseAddArgs(["--user", "alice", "--text", "x", "--tag", "a=1", "--tag=b=2", "--tag=c=3"]);
		expect(opts.tags).toEqual({ a: "1", b: "2", c: "3" });
	});

	it("rejects --tag without '=' in space form", () => {
		expect(() => parseAddArgs(["--user", "alice", "--text", "x", "--tag", "no-equals"])).toThrow(
			/--tag expects key=value/,
		);
	});

	it("rejects --tag= without '=' (empty key)", () => {
		expect(() => parseAddArgs(["--user", "alice", "--text", "x", "--tag==value"])).toThrow(
			/--tag expects key=value/,
		);
	});

	it("defaults userId to 'default' when --user is omitted", () => {
		expect(parseAddArgs(["--text", "x"]).userId).toBe("default");
	});

	it("throws when --text is missing", () => {
		expect(() => parseAddArgs(["--user", "alice"])).toThrow(/--text <text> is required/);
	});

	it("throws on unknown flag", () => {
		expect(() => parseAddArgs(["--user", "alice", "--text", "x", "--wat"])).toThrow(/unknown flag/);
	});

	it("throws on --at that is not ISO-8601", () => {
		expect(() => parseAddArgs(["--user", "alice", "--text", "x", "--at", "yesterday"])).toThrow(
			/--at expects an ISO-8601/,
		);
	});
});

// ── 2. runAdd (mocked SDK) ─────────────────────────────────────────────────

vi.mock("@melandlabs/memory-store", () => {
	const storeMessages = vi.fn();
	const manager = { storeMessages };
	return {
		getRawMessageManager: vi.fn(async () => manager),
		__mock: { storeMessages, manager },
	};
});

async function getMockStore() {
	const mod = await import("@melandlabs/memory-store");
	// The mocked module exports `__mock` (see vi.mock factory above) for test
	// inspection. The real `getRawMessageManager` is replaced at module level.
	return mod as unknown as {
		__mock: {
			storeMessages: ReturnType<typeof vi.fn>;
			manager: unknown;
		};
	};
}

describe("runAdd", () => {
	it("calls manager.storeMessages with a fully-populated RawMessage", async () => {
		const { __mock } = await getMockStore();
		__mock.storeMessages.mockResolvedValueOnce([7]);

		const exit = await runAdd(
			parseAddArgs([
				"--user",
				"alice",
				"--bot",
				"general",
				"--text",
				"hi",
				"--source",
				"meeting://2026-08-20",
				"--kind",
				"experience",
				"--channel",
				"#eng",
				"--person",
				"u_42",
				"--tag",
				"topic=roadmap",
				"--tag=team=eng",
			]),
		);
		expect(exit).toBe(0);

		expect(__mock.storeMessages).toHaveBeenCalledTimes(1);
		const messages = __mock.storeMessages.mock.calls[0]?.[0] as RawMessage[];
		expect(messages).toHaveLength(1);
		const msg = messages[0];
		if (!msg) throw new Error("expected first message to be present");
		expect(msg.userId).toBe("alice");
		expect(msg.botId).toBe("general");
		expect(msg.platform).toBe("cli"); // default
		expect(msg.content).toBe("hi");
		expect(msg.channel).toBe("#eng");
		expect(msg.person).toBe("u_42");
		expect(msg.metadata).toEqual({
			source: "meeting://2026-08-20",
			kind: "experience",
			topic: "roadmap",
			team: "eng",
		});
		// Auto-filled fields
		expect(msg.messageId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(typeof msg.createdAt).toBe("number");
		expect(typeof msg.timestamp).toBe("number");
	});

	it("parses --at into a numeric timestamp", async () => {
		const { __mock } = await getMockStore();
		__mock.storeMessages.mockResolvedValueOnce([1]);
		await runAdd(parseAddArgs(["--user", "alice", "--text", "x", "--at", "2026-08-20T10:00:00Z"]));
		const messages = __mock.storeMessages.mock.calls[0]?.[0] as RawMessage[];
		expect(messages[0]?.timestamp).toBe(Date.parse("2026-08-20T10:00:00Z"));
	});

	it("omits metadata when no source/kind/tags are provided", async () => {
		const { __mock } = await getMockStore();
		__mock.storeMessages.mockResolvedValueOnce([1]);
		await runAdd(parseAddArgs(["--user", "alice", "--text", "hi"]));
		const messages = __mock.storeMessages.mock.calls[0]?.[0] as RawMessage[];
		expect(messages[0]?.metadata).toBeUndefined();
	});

	it("writes a human-friendly line on the default path", async () => {
		const { __mock } = await getMockStore();
		__mock.storeMessages.mockResolvedValueOnce([42]);
		const exit = await runAdd(parseAddArgs(["--user", "alice", "--text", "hi"]));
		expect(exit).toBe(0);
		const stdout = stdoutChunks.join("");
		expect(stdout).toBe("wrote 1 message: 42\n");
	});

	it("writes a JSON envelope when --json is set", async () => {
		const { __mock } = await getMockStore();
		__mock.storeMessages.mockResolvedValueOnce([7, 8]);
		const exit = await runAdd(parseAddArgs(["--user", "alice", "--text", "hi", "--json"]));
		expect(exit).toBe(0);
		const stdout = stdoutChunks.join("");
		const parsed = JSON.parse(stdout.trim()) as {
			ok: boolean;
			exit: number;
			count: number;
			ids: number[];
			platform: string;
		};
		expect(parsed).toEqual({
			ok: true,
			exit: 0,
			count: 2,
			ids: [7, 8],
			platform: "cli",
		});
	});

	it("honors custom --platform in the JSON envelope", async () => {
		const { __mock } = await getMockStore();
		__mock.storeMessages.mockResolvedValueOnce([1]);
		await runAdd(parseAddArgs(["--user", "alice", "--text", "hi", "--platform", "slack", "--json"]));
		const parsed = JSON.parse(stdoutChunks.join("").trim()) as { platform: string };
		expect(parsed.platform).toBe("slack");
	});

	it("returns exit=1 with an error envelope when the manager lacks storeMessages", async () => {
		// Swap the global mock for this test only: a manager that has no
		// storeMessages function at all. We do this by re-mocking the module
		// and clearing the prior calls.
		vi.resetModules();
		vi.doMock("@melandlabs/memory-store", () => ({
			getRawMessageManager: vi.fn(async () => ({
				/* no storeMessages */
			})),
		}));
		const { runAdd: runAddFresh, parseAddArgs: parseAddArgsFresh } = await import("./add");
		const exit = await runAddFresh(parseAddArgsFresh(["--user", "alice", "--text", "hi"]));
		expect(exit).toBe(1);
		const stdout = stdoutChunks.join("");
		expect(stdout).toMatch(/error: active raw-message manager exposes no storeMessages/);
		vi.doUnmock("@melandlabs/memory-store");
	});
});
