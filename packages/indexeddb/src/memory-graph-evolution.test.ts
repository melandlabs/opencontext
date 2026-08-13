/**
 * Tests for the `asOf` time-travel extension on `MemoryGraphSnapshotQuery`.
 *
 * The filter honours `query.asOf` only when explicitly set. Without it the
 * snapshot is returned exactly as the ledger holds it — backward-compatible.
 */
import { describe, expect, it } from "vitest";

import type { OwnerScope } from "../../ai/memory-consolidation/src/graph-contracts";
import type {
	MemoryGraphSnapshot,
	MemoryGraphSnapshotQuery,
} from "../../ai/memory-consolidation/src/graph-contracts";
import { createRawMessageMemoryGraphStore, memoryGraphLedgerMessageId } from "./memory-graph-evolution";
import type { RawMessage } from "./storage";

const SCOPE: OwnerScope = { userId: "u1" };

function buildLedgerSnapshot(): MemoryGraphSnapshot {
	return {
		ownerScope: { ...SCOPE },
		nodes: [
			{
				id: "n-old",
				ownerScope: { ...SCOPE },
				type: "raw",
				createdAt: 1_700_000_000_000,
				visibility: "default",
				applicability: {
					scope: "global",
					validFrom: 1_600_000_000_000,
					validUntil: 1_700_000_000_000,
				},
			},
			{
				id: "n-mid",
				ownerScope: { ...SCOPE },
				type: "raw",
				createdAt: 1_700_000_000_000,
				visibility: "default",
				applicability: {
					scope: "global",
					validFrom: 1_600_000_000_000,
					validUntil: 1_800_000_000_000,
				},
			},
			{
				id: "n-future",
				ownerScope: { ...SCOPE },
				type: "raw",
				createdAt: 1_700_000_000_000,
				visibility: "default",
				applicability: {
					scope: "global",
					validFrom: 1_900_000_000_000,
					validUntil: 2_000_000_000_000,
				},
			},
			{
				id: "n-no-window",
				ownerScope: { ...SCOPE },
				type: "raw",
				createdAt: 1_700_000_000_000,
				visibility: "default",
			},
		],
		edges: [],
		clusters: [
			{
				clusterId: "c-mid",
				ownerScope: { ...SCOPE },
				nodeIds: ["n-mid"],
				lifecycleStatus: "active",
				updatedAt: 1_700_000_000_000,
				reasonCodes: [],
				applicability: {
					scope: "global",
					validFrom: 1_600_000_000_000,
					validUntil: 1_800_000_000_000,
				},
			},
		],
		capturedAt: 1_700_000_000_000,
	};
}

function buildStorage(): {
	getMessageById: (id: string) => Promise<RawMessage | null>;
	queryMessages: (q: unknown) => Promise<RawMessage[]>;
	storeMessage: (m: RawMessage) => Promise<number>;
	storeMessages: (ms: RawMessage[]) => Promise<number[]>;
	compareAndSwapGraphLedger?: (
		m: RawMessage,
		i: { expectedVersion: string; metadataKey: string },
	) => Promise<boolean>;
} {
	const store = new Map<string, RawMessage>();
	const ledgerId = memoryGraphLedgerMessageId(SCOPE);
	const ledger: RawMessage = {
		messageId: ledgerId,
		platform: "opencontext-internal",
		botId: "memory-graph",
		userId: SCOPE.userId,
		timestamp: 1_700_000_000_000,
		content: "ledger",
		createdAt: 1_700_000_000_000,
		metadata: {
			memoryGraphLedger: {
				schemaVersion: 1,
				ownerScope: { ...SCOPE },
				snapshot: buildLedgerSnapshot(),
				appliedOperations: [],
			},
		},
	};
	store.set(ledgerId, ledger);

	return {
		async getMessageById(id: string): Promise<RawMessage | null> {
			return store.get(id) ?? null;
		},
		async queryMessages(): Promise<RawMessage[]> {
			return [];
		},
		async storeMessage(message: RawMessage): Promise<number> {
			store.set(message.messageId, message);
			return 0;
		},
		async storeMessages(messages: RawMessage[]): Promise<number[]> {
			for (const m of messages) store.set(m.messageId, m);
			return messages.map(() => 0);
		},
	};
}

describe("filterSnapshot asOf behavior", () => {
	const baseQuery: MemoryGraphSnapshotQuery = { ownerScope: SCOPE };

	it("returns every node when asOf is omitted (legacy behavior)", async () => {
		const store = createRawMessageMemoryGraphStore({
			storage: buildStorage(),
			ownerScope: SCOPE,
		});
		const snap = await store.readSnapshot(baseQuery);
		expect(snap.nodes.map((n) => n.id).sort()).toEqual(["n-future", "n-mid", "n-no-window", "n-old"]);
	});

	it("filters out nodes whose applicability window is closed at asOf", async () => {
		const store = createRawMessageMemoryGraphStore({
			storage: buildStorage(),
			ownerScope: SCOPE,
		});
		const snap = await store.readSnapshot({ ...baseQuery, asOf: "2023-11-14T22:13:20.001Z" });
		// 1_700_000_000_000 ms == 2023-11-14T22:13:20.000Z
		// n-old: validUntil == 1_700_000_000_000 — excluded (asOf > validUntil)
		// n-mid: window covers — included
		// n-future: validFrom > asOf — excluded
		// n-no-window: always included
		expect(snap.nodes.map((n) => n.id).sort()).toEqual(["n-mid", "n-no-window"]);
		expect(snap.clusters.map((c) => c.clusterId)).toEqual(["c-mid"]);
	});

	it("treats invalid ISO strings as if asOf was omitted (legacy wins)", async () => {
		const store = createRawMessageMemoryGraphStore({
			storage: buildStorage(),
			ownerScope: SCOPE,
		});
		const snap = await store.readSnapshot({ ...baseQuery, asOf: "not-an-iso-string" });
		expect(snap.nodes.map((n) => n.id).sort()).toEqual(["n-future", "n-mid", "n-no-window", "n-old"]);
	});
});
