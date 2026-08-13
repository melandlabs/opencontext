/**
 * Tests for `SQLiteRawMessageManager.lexicalSearchMessages` and the
 * `source_episode_id` round-trip. The BM25 score is exposed via the FTS5
 * `rank` column and normalised to a `[0, 1]` similarity downstream.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RawMessage } from "../../indexeddb/src/storage";
import { SQLiteRawMessageManager } from "./raw-message-manager";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "sqlite-lexical-"));
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

describe("SQLiteRawMessageManager.lexicalSearchMessages", () => {
	it("returns BM25-ranked hits for matching keywords", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.init();

		await manager.storeMessages([
			makeMessage({ messageId: "m-alpha", content: "the quick brown fox jumps over the lazy dog" }),
			makeMessage({ messageId: "m-beta", content: "beta is the second greek letter and rare in english" }),
			makeMessage({ messageId: "m-gamma", content: "gamma rays are high-energy photons" }),
		]);

		const hits = await manager.lexicalSearchMessages({
			userId: "u1",
			keywords: ["beta"],
		});

		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.id).toBe("m-beta");
		expect(hits[0]?.metadata.scoring).toBe("bm25");
		expect(hits[0]?.similarity).toBeGreaterThan(0);

		await manager.close();
	});

	it("returns an empty array for empty keywords without throwing", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.init();

		const hits = await manager.lexicalSearchMessages({ userId: "u1", keywords: [] });
		expect(hits).toEqual([]);

		const trimmedHits = await manager.lexicalSearchMessages({ userId: "u1", keywords: ["  ", ""] });
		expect(trimmedHits).toEqual([]);

		await manager.close();
	});

	it("round-trips sourceEpisodeId on insert → lexical query → storeMessage", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: join(scratchDir, "store.db") });
		await manager.init();

		await manager.storeMessage(
			makeMessage({
				messageId: "m-eps",
				content: "episode-bound message contains keyword quokka",
				sourceEpisodeId: "episode-42",
			}),
		);

		const all = await manager.queryMessages({ userId: "u1", includeArchived: true });
		expect(all[0]?.sourceEpisodeId).toBe("episode-42");

		const hits = await manager.lexicalSearchMessages({ userId: "u1", keywords: ["quokka"] });
		expect(hits[0]?.message.sourceEpisodeId).toBe("episode-42");

		await manager.close();
	});
});
