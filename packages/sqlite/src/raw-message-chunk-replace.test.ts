import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { expect, it } from "vitest";
import type { RawMessage } from "../../indexeddb/src/storage";
import { SQLiteRawMessageManager } from "./raw-message-manager";

it("keeps child vectors consistent through replacement, model dimensions, and lexical-only updates", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "child-vector-replace-"));
	const dbPath = join(scratch, "store.sqlite");
	const manager = new SQLiteRawMessageManager({ dbPath });
	let observer: Database.Database | undefined;
	const message: RawMessage = {
		messageId: "parent",
		userId: "alice",
		botId: "bot",
		platform: "chat",
		content: "original",
		createdAt: 1,
		embedding: [1, 2],
		embeddingModel: "fixture-2",
	};
	try {
		await manager.storeMessage(message);
		await manager.storeMessage({ ...message, messageId: "unrelated" });
		observer = new Database(dbPath);
		sqliteVec.load(observer);
		const count = (dimensions: number) =>
			(
				observer?.prepare(`SELECT count(*) AS n FROM raw_message_chunks_vec_d${dimensions}`).get() as {
					n: number;
				}
			).n;
		expect(count(2)).toBe(2);
		await manager.storeMessage(message);
		expect(count(2)).toBe(2);
		await manager.storeMessage({
			...message,
			content: "replaced",
			embedding: [1, 2, 3],
			embeddingModel: "fixture-3",
		});
		expect(count(2)).toBe(1);
		expect(count(3)).toBe(1);
		expect(
			observer
				.prepare(
					"SELECT count(*) AS n FROM raw_message_chunks_vec_d3 WHERE chunk_id NOT IN (SELECT chunk_id FROM raw_message_chunks)",
				)
				.get(),
		).toEqual({ n: 0 });
		await manager.storeMessage({
			...message,
			content: "lexical only",
			embedding: undefined,
			embeddingModel: undefined,
		});
		expect(count(2)).toBe(1);
		expect(count(3)).toBe(0);
		expect(await manager.getMessageById("parent")).toMatchObject({
			messageSequence: 1,
			content: "lexical only",
		});
		// Direct catalog deletes use the same primary-key triggers.
		observer.prepare("DELETE FROM raw_message_chunks WHERE message_id = ?").run("unrelated");
		expect(count(2)).toBe(0);
	} finally {
		observer?.close();
		await manager.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});
