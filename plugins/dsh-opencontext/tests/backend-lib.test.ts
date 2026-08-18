import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @melandlabs/opencontext *before* importing the lib backend. The
// mocks must be declared with `vi.hoisted` so they're available when
// `vi.mock` is hoisted to the top of the file by vitest.
const mocks = vi.hoisted(() => ({
	storeMessages: vi.fn(async (msgs: unknown[]) => msgs.map(() => Math.random().toString(36).slice(2, 10))),
	queryMessages: vi.fn(async () => []),
	getMessageById: vi.fn(async (id: string) => ({
		messageId: id,
		content: "ok",
		timestamp: 1,
	})),
	deprecateMessages: vi.fn(async () => 1),
	getStats: vi.fn(async () => ({ totalMessages: 0 })),
	search: vi.fn(async () => ({ results: [], warnings: [], evidence: [] })),
	isRawMessageStorageAvailable: vi.fn(() => true),
	getRawMessageManager: vi.fn(async () => ({})),
	createUnifiedSearch: vi.fn(() => ({})),
	closeRawMessageStore: vi.fn(async () => undefined),
}));

vi.mock("@melandlabs/opencontext", () => ({
	isRawMessageStorageAvailable: mocks.isRawMessageStorageAvailable,
	getRawMessageManager: mocks.getRawMessageManager,
	createUnifiedSearch: mocks.createUnifiedSearch,
	closeRawMessageStore: mocks.closeRawMessageStore,
}));

import { createLibBackend } from "../src/backend-lib.js";
import { makeConfig, makeSearchHit } from "./_helpers.js";

const {
	storeMessages,
	queryMessages,
	getMessageById,
	deprecateMessages,
	getStats,
	search,
	isRawMessageStorageAvailable,
	getRawMessageManager,
	createUnifiedSearch,
} = mocks;

let dbDir = "";

beforeEach(() => {
	dbDir = mkdtempSync(join(tmpdir(), "oc-test-"));
	process.env.MEMORY_STORE_DB_PATH = join(dbDir, "store.db");
	storeMessages.mockClear();
	queryMessages.mockClear();
	getMessageById.mockClear();
	deprecateMessages.mockClear();
	search.mockClear();
	getRawMessageManager.mockClear();
	createUnifiedSearch.mockClear();
	// Wire the manager-shaped object to the live mocks so the backend can use it.
	getRawMessageManager.mockResolvedValue({
		storeMessages,
		queryMessages,
		getMessageById,
		deprecateMessages,
		getStats,
	});
	createUnifiedSearch.mockImplementation(() => ({ search }));
});

afterEach(() => {
	rmSync(dbDir, { recursive: true, force: true });
	delete process.env.MEMORY_STORE_DB_PATH;
});

describe("createLibBackend", () => {
	it("search maps to store.search with userId, limit, threshold", async () => {
		search.mockResolvedValueOnce({
			results: [
				{
					id: "h1",
					content: "x",
					similarity: 0.91,
					metadata: { timestamp: 42 },
				},
			],
			warnings: [],
		} as never);
		const backend = createLibBackend(makeConfig({ scopeId: "user:1" }));
		const hits = await backend.search({
			query: "hello world",
			limit: 3,
			threshold: 0.4,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.id).toBe("h1");
		expect(hits[0]?.score).toBeCloseTo(0.91);
		expect(hits[0]?.timestamp).toBe(42);
		expect(search).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "hello world",
				limit: 3,
				threshold: 0.4,
				userId: "user:1",
			}),
		);
	});

	it("search falls back to lexical queryMessages when unified search throws", async () => {
		search.mockRejectedValueOnce(new Error("no embed provider"));
		queryMessages.mockResolvedValueOnce([
			{
				messageId: "h1",
				content: "alpha",
				timestamp: 1,
				metadata: { origin: "dsh" },
			},
		] as never);
		const backend = createLibBackend(makeConfig());
		const hits = await backend.search({ query: "alpha" });
		expect(hits).toHaveLength(1);
		expect(queryMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "test:scope",
				platform: "dsh",
				keywords: ["alpha"],
			}),
		);
	});

	it("remember calls storeMessages with a single RawMessage", async () => {
		const backend = createLibBackend(makeConfig({ scopeId: "user:2" }));
		await backend.remember({
			content: "hello",
			metadata: { kind: "agent-note" },
		});
		expect(storeMessages).toHaveBeenCalledTimes(1);
		const arg = storeMessages.mock.calls[0]?.[0] as Array<{
			messageId: string;
			platform: string;
			botId: string;
			userId: string;
			content: string;
		}>;
		expect(arg).toHaveLength(1);
		expect(arg?.[0]?.platform).toBe("dsh");
		expect(arg?.[0]?.botId).toBe("dsh");
		expect(arg?.[0]?.userId).toBe("user:2");
		expect(arg?.[0]?.content).toBe("hello");
	});

	it("list calls queryMessages with reverse=true and limit", async () => {
		const backend = createLibBackend(makeConfig());
		await backend.list({ limit: 5 });
		expect(queryMessages).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 5, reverse: true, platform: "dsh" }),
		);
	});

	it("get calls getMessageById for each id and returns memory items", async () => {
		getMessageById.mockImplementation(async (id: string) => ({
			messageId: id,
			content: `content-${id}`,
			timestamp: 7,
		}));
		const backend = createLibBackend(makeConfig());
		const items = await backend.get({ ids: ["a", "b"] });
		expect(items).toHaveLength(2);
		expect(items[0]?.id).toBe("a");
		expect(items[1]?.id).toBe("b");
	});

	it("revise deprecates the old id and stores the new content", async () => {
		const backend = createLibBackend(makeConfig());
		const result = await backend.revise({
			id: "old",
			content: "new",
			reason: "fix",
		});
		expect(deprecateMessages).toHaveBeenCalledWith(["old"], expect.objectContaining({ reason: "fix" }));
		expect(storeMessages).toHaveBeenCalledTimes(1);
		expect(result.deprecatedId).toBe("old");
		expect(typeof result.newId).toBe("string");
	});

	it("retire soft-deprecates the id and returns ok", async () => {
		const backend = createLibBackend(makeConfig());
		const result = await backend.retire({ id: "x", reason: "stale" });
		expect(deprecateMessages).toHaveBeenCalledWith(["x"], expect.objectContaining({ reason: "stale" }));
		expect(result.ok).toBe(true);
	});

	it("captureSource returns a non-empty id", async () => {
		const backend = createLibBackend(makeConfig({ scopeId: "user:3" }));
		const r = await backend.captureSource({ content: "y" });
		expect(typeof r.id).toBe("string");
		expect(r.id.length).toBeGreaterThan(0);
	});

	it("health reports ok when unified search succeeds", async () => {
		const backend = createLibBackend(makeConfig());
		const h = await backend.health();
		expect(h.mode).toBe("lib");
		expect(h.ok).toBe(true);
		expect(h.details).toContain("db=");
	});

	it("health reports failure when isRawMessageStorageAvailable is false", async () => {
		isRawMessageStorageAvailable.mockReturnValueOnce(false);
		const backend = createLibBackend(makeConfig());
		const h = await backend.health();
		expect(h.ok).toBe(false);
		expect(h.details).toContain("not initialised");
	});

	it("seeded hits round-trip through formatPreparedContext", async () => {
		search.mockResolvedValueOnce({
			results: [
				{
					id: "h1",
					content: "alpha",
					similarity: 0.9,
					metadata: { timestamp: 1 },
				},
				{
					id: "h2",
					content: "beta",
					similarity: 0.8,
					metadata: { timestamp: 2 },
				},
			],
			warnings: [],
			evidence: [],
		} as never);
		const backend = createLibBackend(makeConfig());
		const hits = await backend.search({ query: "alpha" });
		expect(hits).toHaveLength(2);
		expect(hits[0]?.id).toBe("h1");
	});
});

void makeSearchHit;
