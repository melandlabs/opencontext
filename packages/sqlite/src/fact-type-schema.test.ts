/**
 * Tests for v4 schema additions: the `fact_type` column on `raw_messages` and
 * the round-trip via `SQLiteRawMessageManager.storeMessages` /
 * `queryMessages`. The v3→v4 migration is idempotent and runs on every
 * `init()`, so calling `init()` twice on the same connection should not
 * error or duplicate the column.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RawMessage } from "../../indexeddb/src/storage";
import { SQLiteRawMessageManager } from "./raw-message-manager";
import { RAW_MESSAGES_SCHEMA_VERSION } from "./schema";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "sqlite-facttype-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

function makeMessage(overrides: Partial<RawMessage> & { messageId: string; content: string }): RawMessage {
	const now = Math.floor(Date.now() / 1000);
	return {
		platform: "test",
		botId: "bot-1",
		userId: "u1",
		timestamp: now,
		createdAt: now,
		...overrides,
	};
}

describe("RAW_MESSAGES_SCHEMA_VERSION", () => {
	it("is bumped to 4 (v3 → v4 added fact_type)", () => {
		expect(RAW_MESSAGES_SCHEMA_VERSION).toBe(4);
	});
});

describe("SQLiteRawMessageManager — fact_type round-trip", () => {
	it("persists and returns factType on the row", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.init();

		await manager.storeMessages([
			makeMessage({ messageId: "m1", content: "water boils at 100C", factType: "world" }),
			makeMessage({ messageId: "m2", content: "I went hiking", factType: "experience" }),
			makeMessage({ messageId: "m3", content: "plain fact", factType: undefined }),
		]);

		const all = await manager.queryMessages({ userId: "u1", limit: 10 });
		expect(all).toHaveLength(3);
		const byId = new Map(all.map((m) => [m.messageId, m]));
		expect(byId.get("m1")?.factType).toBe("world");
		expect(byId.get("m2")?.factType).toBe("experience");
		expect(byId.get("m3")?.factType).toBeUndefined();

		await manager.close();
	});

	it("filters by query.factTypes — missing factType is excluded when filter is non-empty", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.init();

		await manager.storeMessages([
			makeMessage({ messageId: "m1", content: "objective fact", factType: "world" }),
			makeMessage({ messageId: "m2", content: "first person", factType: "experience" }),
			makeMessage({ messageId: "m3", content: "untagged" }),
		]);

		const onlyWorld = await manager.queryMessages({ userId: "u1", factTypes: ["world"] });
		expect(onlyWorld.map((m) => m.messageId)).toEqual(["m1"]);

		const worldAndExperience = await manager.queryMessages({
			userId: "u1",
			factTypes: ["world", "experience"],
		});
		expect(worldAndExperience.map((m) => m.messageId).sort()).toEqual(["m1", "m2"]);

		await manager.close();
	});

	it("init() is idempotent — running twice on the same db does not duplicate the column", async () => {
		const dbPath = join(scratchDir, "store.db");
		const first = new SQLiteRawMessageManager({ dbPath });
		await first.init();
		await first.storeMessages([makeMessage({ messageId: "m1", content: "x", factType: "world" })]);
		await first.close();

		const second = new SQLiteRawMessageManager({ dbPath });
		await second.init();
		const rows = await second.queryMessages({ userId: "u1", factTypes: ["world"] });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.factType).toBe("world");
		await second.close();
	});
});
