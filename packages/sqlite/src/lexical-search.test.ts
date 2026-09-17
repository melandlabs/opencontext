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

	it("preserves parent metadata in semantic and lexical child hits", async () => {
		const manager = new SQLiteRawMessageManager({
			dbPath: join(scratchDir, "store.db"),
			enableVectorSearch: false,
		});
		await manager.init();

		await manager.storeMessage(
			makeMessage({
				messageId: "message-with-provenance",
				content: "Berlin provenance marker",
				embedding: [1, 0, 0],
				embeddingModel: "fixture",
				metadata: {
					conversationId: "conversation-1",
					sequence: 7,
					sourceId: "upstream-41",
				},
			}),
		);

		const semanticHits = await manager.searchMessagesSemantically({
			userId: "u1",
			queryEmbedding: [1, 0, 0],
			threshold: 0.9,
		});
		const lexicalHits = await manager.lexicalSearchMessages({ userId: "u1", keywords: ["Berlin"] });

		for (const hit of [...semanticHits, ...lexicalHits]) {
			expect(hit.metadata.conversationId).toBe("conversation-1");
			expect(hit.metadata.sequence).toBe(7);
			expect(hit.metadata.sourceId).toBe("upstream-41");
		}

		await manager.close();
	});

	describe("asOf time-travel filter", () => {
		// The user's bug report:
		//   - "deploy on Mondays" (created 2024-01, deprecated 2024-06)
		//   - "deploy on Thursdays" (created 2024-06, deprecated 2025-03)
		//   - "deploy on Wednesdays" (created 2025-03, never deprecated)
		//
		// Current-truth (no asOf, no includeDeprecated) must yield Wednesdays.
		// asOf="2025-01-15T00:00:00Z" must yield Thursdays — that revision was
		// current at the snapshot and was not yet deprecated.
		// asOf="2024-03-01T00:00:00Z" must yield Mondays.
		// includeDeprecated + asOf="2024-12-01T00:00:00Z" must yield Mondays
		// + Thursdays, NOT all three revisions.
		function makeRevision(
			overrides: Partial<RawMessage> & { messageId: string; content: string },
		): RawMessage {
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

		async function seedThreeRevisions(manager: SQLiteRawMessageManager): Promise<void> {
			const mondaysSeconds = Math.floor(Date.parse("2024-01-15T00:00:00Z") / 1000);
			const thursdaysSeconds = Math.floor(Date.parse("2024-06-01T00:00:00Z") / 1000);
			const wednesdaysSeconds = Math.floor(Date.parse("2025-03-01T00:00:00Z") / 1000);
			const mondaysDeprecatedMs = Date.parse("2024-06-01T00:00:00Z");
			const thursdaysDeprecatedMs = Date.parse("2025-03-01T00:00:00Z");
			await manager.storeMessages([
				makeRevision({ messageId: "rev-mondays", content: "deploy on Mondays", createdAt: mondaysSeconds }),
				makeRevision({
					messageId: "rev-thursdays",
					content: "deploy on Thursdays",
					createdAt: thursdaysSeconds,
				}),
				makeRevision({
					messageId: "rev-wednesdays",
					content: "deploy on Wednesdays",
					createdAt: wednesdaysSeconds,
				}),
			]);
			// `deprecateMessages` writes a single timestamp per call, so deprecate
			// each revision separately with its own timestamp. The Wednesday
			// revision is intentionally left active.
			await manager.deprecateMessages(["rev-mondays"], { deprecatedAt: mondaysDeprecatedMs });
			await manager.deprecateMessages(["rev-thursdays"], { deprecatedAt: thursdaysDeprecatedMs });
		}

		it("current-truth returns the latest revision (no asOf)", async () => {
			const manager = new SQLiteRawMessageManager({
				dbPath: join(scratchDir, "store.db"),
				enableVectorSearch: false,
			});
			await manager.init();
			await seedThreeRevisions(manager);

			const hits = await manager.lexicalSearchMessages({ userId: "u1", keywords: ["deploy"] });
			expect(hits.map((hit) => hit.id)).toEqual(["rev-wednesdays"]);

			await manager.close();
		});

		it("asOf selects the revision that was current at that instant", async () => {
			const manager = new SQLiteRawMessageManager({
				dbPath: join(scratchDir, "store.db"),
				enableVectorSearch: false,
			});
			await manager.init();
			await seedThreeRevisions(manager);

			// 2024-03-01: only Mondays existed; it was not yet deprecated.
			const hitsBeforeThursday = await manager.lexicalSearchMessages({
				userId: "u1",
				keywords: ["deploy"],
				asOf: "2024-03-01T00:00:00Z",
			});
			expect(hitsBeforeThursday.map((hit) => hit.id)).toEqual(["rev-mondays"]);

			// 2025-01-15: Thursdays existed and was not yet deprecated
			// (deprecated 2025-03-01). Wednesdays didn't exist yet.
			const hitsDuringThursday = await manager.lexicalSearchMessages({
				userId: "u1",
				keywords: ["deploy"],
				asOf: "2025-01-15T00:00:00Z",
			});
			expect(hitsDuringThursday.map((hit) => hit.id)).toEqual(["rev-thursdays"]);

			await manager.close();
		});

		it("asOf + includeDeprecated returns every revision that existed at the snapshot", async () => {
			const manager = new SQLiteRawMessageManager({
				dbPath: join(scratchDir, "store.db"),
				enableVectorSearch: false,
			});
			await manager.init();
			await seedThreeRevisions(manager);

			// 2024-12-01: Mondays + Thursdays both existed. Mondays was
			// deprecated 2024-06-01, so with includeDeprecated=true the
			// audit-style query surfaces the full supersession chain. The
			// pre-fix behaviour was to return all three revisions regardless
			// of asOf; the fix applies the asOf upper bound to creation time.
			const hits = await manager.lexicalSearchMessages({
				userId: "u1",
				keywords: ["deploy"],
				asOf: "2024-12-01T00:00:00Z",
				includeDeprecated: true,
			});
			const ids = hits.map((hit) => hit.id).sort();
			expect(ids).toEqual(["rev-mondays", "rev-thursdays"]);
			expect(ids).not.toContain("rev-wednesdays");

			await manager.close();
		});

		it("asOf ignores records created strictly after the snapshot", async () => {
			const manager = new SQLiteRawMessageManager({
				dbPath: join(scratchDir, "store.db"),
				enableVectorSearch: false,
			});
			await manager.init();
			await seedThreeRevisions(manager);

			// Before any revision exists, nothing is visible — even with
			// includeDeprecated=true (because created_at > asOf in every row).
			const hits = await manager.lexicalSearchMessages({
				userId: "u1",
				keywords: ["deploy"],
				asOf: "1999-01-01T00:00:00Z",
				includeDeprecated: true,
			});
			expect(hits).toEqual([]);

			await manager.close();
		});
	});
});
