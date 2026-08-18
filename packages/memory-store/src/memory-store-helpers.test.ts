/**
 * Memory-store derived peer-helper tests.
 *
 * Exercises `listKnownPeersFromStore` and `listPeerMentionsFromStore`
 * against an in-memory mock `MemoryStore` so we don't depend on a
 * live SQLite / IndexedDB backend. The mock's `queryMessages` honours
 * `userId`, `startTime`, `endTime`, `limit`, and `includeArchived` so
 * the helpers exercise the same contract surface they would in
 * production.
 */

import type { Peer } from "@melandlabs/contracts/peer";
import { describe, expect, it } from "vitest";

import type { MemoryStore } from "./index";
import { listKnownPeersFromStore, listPeerMentionsFromStore } from "./memory-store-helpers";
import type { RawMessageStorageManagerWithSearch } from "./storage/raw-message-store";

interface RawMessageMock {
	messageId: string;
	peer?: Peer;
	person?: string;
	userId?: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
	archivedAt?: number;
	deprecatedAt?: number;
}

const NOW = Date.parse("2026-08-18T12:00:00Z");

function buildMockStore(messages: RawMessageMock[]): MemoryStore {
	const manager: RawMessageStorageManagerWithSearch = {
		async queryMessages(query: {
			userId?: string;
			startTime?: number;
			endTime?: number;
			includeArchived?: boolean;
			limit?: number;
		}) {
			const startTime = typeof query.startTime === "number" ? query.startTime : Number.NEGATIVE_INFINITY;
			const endTime = typeof query.endTime === "number" ? query.endTime : Number.POSITIVE_INFINITY;
			const includeArchived = Boolean(query.includeArchived);
			const limit = typeof query.limit === "number" ? query.limit : messages.length;
			const filtered = messages.filter((m) => {
				if (query.userId && m.userId !== query.userId) return false;
				if (m.timestamp < startTime || m.timestamp > endTime) return false;
				if (!includeArchived && (m.archivedAt || m.deprecatedAt)) return false;
				return true;
			});
			return filtered.slice(0, limit);
		},
	} as unknown as RawMessageStorageManagerWithSearch;

	return {
		raw: {
			getManager: async () => manager,
			getBackend: () => "sqlite",
			isAvailable: () => true,
			close: async () => {},
		},
		// Other MemoryStore fields are not exercised by these tests.
	} as unknown as MemoryStore;
}

describe("listKnownPeersFromStore", () => {
	it("deduplicates authors by peerKey across channels and bots", async () => {
		const store = buildMockStore([
			{
				messageId: "m1",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW,
				metadata: { channel: "eng" },
			},
			{
				messageId: "m2",
				person: "alice",
				userId: "workspace-1",
				timestamp: NOW,
				metadata: { channel: "books" },
			},
			{
				messageId: "m3",
				peer: { kind: "user", id: "bob" },
				userId: "workspace-1",
				timestamp: NOW,
			},
		]);
		const peers = await listKnownPeersFromStore(store, { userId: "workspace-1" });
		expect(peers.map((p) => p.id).sort()).toEqual(["alice", "bob"]);
	});

	it("respects the time-range filter", async () => {
		const store = buildMockStore([
			{
				messageId: "old",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW - 1000 * 60 * 60 * 24 * 30,
			},
			{
				messageId: "new",
				peer: { kind: "user", id: "bob" },
				userId: "workspace-1",
				timestamp: NOW - 1000 * 60 * 60 * 24,
			},
		]);
		const peers = await listKnownPeersFromStore(store, {
			userId: "workspace-1",
			startTime: NOW - 1000 * 60 * 60 * 24 * 7,
		});
		expect(peers.map((p) => p.id)).toEqual(["bob"]);
	});

	it("excludes archived messages by default and includes them when asked", async () => {
		const store = buildMockStore([
			{
				messageId: "live",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW,
			},
			{
				messageId: "archived",
				peer: { kind: "user", id: "bob" },
				userId: "workspace-1",
				timestamp: NOW,
				archivedAt: NOW,
			},
		]);
		const def = await listKnownPeersFromStore(store, { userId: "workspace-1" });
		expect(def.map((p) => p.id)).toEqual(["alice"]);

		const all = await listKnownPeersFromStore(store, {
			userId: "workspace-1",
			includeArchived: true,
		});
		expect(all.map((p) => p.id).sort()).toEqual(["alice", "bob"]);
	});

	it("returns an empty list when no messages exist for the user", async () => {
		const store = buildMockStore([]);
		const peers = await listKnownPeersFromStore(store, { userId: "workspace-1" });
		expect(peers).toEqual([]);
	});
});

describe("listPeerMentionsFromStore", () => {
	it("projects messages onto PeerPosting shape with mentions extracted from metadata", async () => {
		const store = buildMockStore([
			{
				messageId: "m1",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW,
				metadata: { mentions: ["bob", "carol"] },
			},
			{
				messageId: "m2",
				person: "bob",
				userId: "workspace-1",
				timestamp: NOW,
				metadata: { mentions: ["alice"] },
			},
		]);
		const postings = await listPeerMentionsFromStore(store, { userId: "workspace-1" });
		expect(postings).toEqual([
			{ id: "m1", authorId: "alice", mentionedIds: ["bob", "carol"] },
			{ id: "m2", authorId: "bob", mentionedIds: ["alice"] },
		]);
	});

	it("omits mentionedIds when the metadata entry is absent or empty", async () => {
		const store = buildMockStore([
			{
				messageId: "m1",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW,
			},
			{
				messageId: "m2",
				peer: { kind: "user", id: "bob" },
				userId: "workspace-1",
				timestamp: NOW,
				metadata: { mentions: [] },
			},
		]);
		const postings = await listPeerMentionsFromStore(store, { userId: "workspace-1" });
		expect(postings).toEqual([
			{ id: "m1", authorId: "alice" },
			{ id: "m2", authorId: "bob" },
		]);
	});

	it("throws when userId is missing", async () => {
		const store = buildMockStore([]);
		await expect(
			// @ts-expect-error — userId required
			listPeerMentionsFromStore(store, {}),
		).rejects.toThrow(/userId is required/);
	});

	it("applies startTime / endTime filters", async () => {
		const store = buildMockStore([
			{
				messageId: "old",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW - 1000 * 60 * 60 * 24 * 30,
				metadata: { mentions: ["bob"] },
			},
			{
				messageId: "new",
				peer: { kind: "user", id: "alice" },
				userId: "workspace-1",
				timestamp: NOW - 1000 * 60 * 60 * 24,
				metadata: { mentions: ["carol"] },
			},
		]);
		const postings = await listPeerMentionsFromStore(store, {
			userId: "workspace-1",
			startTime: NOW - 1000 * 60 * 60 * 24 * 7,
		});
		expect(postings).toEqual([{ id: "new", authorId: "alice", mentionedIds: ["carol"] }]);
	});
});
