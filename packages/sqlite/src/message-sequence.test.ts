import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { RawMessage } from "../../indexeddb/src/storage";
import { SQLiteRawMessageManager } from "./raw-message-manager";
import { initializeRawMessageSchema } from "./schema";

const message = (messageId: string, userId = "alice", extra: Partial<RawMessage> = {}): RawMessage => ({
	messageId,
	userId,
	platform: "test",
	botId: "test",
	content: `memory ${messageId}`,
	createdAt: 1,
	...extra,
});

describe("per-user message order", () => {
	it("numbers across batches and sessions, preserves retries, ignores caller numbering and leaves timestamps absent", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: ":memory:" });
		try {
			await manager.storeMessages([
				message("a", "alice", { messageSequence: 999 }),
				message("b", "bob"),
				message("c"),
			]);
			await manager.storeMessages([
				message("a", "alice", { messageSequence: 900 }),
				message("d", "alice", { botId: "other", timestamp: 123 }),
			]);
			expect((await manager.getMessageById("a"))?.messageSequence).toBe(1);
			expect((await manager.getMessageById("b"))?.messageSequence).toBe(1);
			expect((await manager.getMessageById("c"))?.messageSequence).toBe(2);
			expect(await manager.getMessageById("d")).toMatchObject({ messageSequence: 3, timestamp: 123 });
			expect((await manager.getMessageById("a"))?.timestamp).toBeUndefined();
			const hits = await manager.lexicalSearchMessages({ userId: "alice", keywords: ["memory"] });
			expect(hits.find((hit) => hit.id === "a")?.metadata).toMatchObject({ messageSequence: 1 });
			expect(hits.find((hit) => hit.id === "a")?.metadata.timestamp).toBeUndefined();
			expect((await manager.queryMessages({ userId: "alice" })).length).toBe(3);
			await manager.deleteOldMessages(2, "alice");
			await manager.storeMessage(message("after-delete"));
			expect((await manager.getMessageById("after-delete"))?.messageSequence).toBe(4);
		} finally {
			await manager.close();
		}
	});

	it("rolls back the counter when the batch fails", async () => {
		const manager = new SQLiteRawMessageManager({ dbPath: ":memory:" });
		try {
			await manager.storeMessage(message("owned", "bob"));
			await expect(manager.storeMessages([message("rolled-back"), message("owned")])).rejects.toThrow(
				"raw_message_scope_conflict",
			);
			await manager.storeMessage(message("next"));
			expect((await manager.getMessageById("next"))?.messageSequence).toBe(1);
			expect(await manager.getMessageById("rolled-back")).toBeNull();
		} finally {
			await manager.close();
		}
	});

	it("upgrades a required timestamp without losing parents, children, FTS or existing insertion order", () => {
		const db = new Database(":memory:");
		try {
			initializeRawMessageSchema(db);
			// Rebuild an empty fixture into the previous timestamp constraint.
			db.pragma("foreign_keys = OFF");
			const definition = (
				db.prepare("SELECT sql FROM sqlite_master WHERE name='raw_messages'").get() as { sql: string }
			).sql.replace(/,\s*message_sequence INTEGER/, "");
			const objects = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE tbl_name='raw_messages' AND type IN ('trigger','index') AND sql IS NOT NULL",
				)
				.all() as { sql: string }[];
			db.exec("DROP TABLE raw_messages");
			db.exec(definition.replace("timestamp INTEGER", "timestamp INTEGER NOT NULL"));
			for (const object of objects) {
				if (!object.sql.includes("idx_raw_messages_user_sequence")) db.exec(object.sql);
			}
			db.exec("DROP TABLE raw_message_sequences");
			db.pragma("foreign_keys = ON");
			db.exec(`INSERT INTO raw_messages(message_id, platform, bot_id, user_id, timestamp, content, created_at) VALUES
        ('old-a','test','test','alice',200,'old alpha',1), ('old-b','test','test','alice',100,'old beta',2);
        INSERT INTO raw_message_chunks(chunk_id,message_id,user_id,chunk_index,chunk_count,start_position,end_position,content,content_hash)
        VALUES ('child','old-a','alice',0,1,0,9,'old alpha','hash');`);
			initializeRawMessageSchema(db);
			initializeRawMessageSchema(db);
			expect(db.prepare("SELECT message_sequence, timestamp FROM raw_messages ORDER BY id").all()).toEqual([
				{ message_sequence: 1, timestamp: 200 },
				{ message_sequence: 2, timestamp: 100 },
			]);
			expect(db.prepare("SELECT COUNT(*) AS n FROM raw_message_chunks").get()).toEqual({ n: 1 });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM raw_messages_fts WHERE raw_messages_fts MATCH 'alpha'").get(),
			).toEqual({ n: 1 });
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			db.exec("UPDATE raw_messages SET timestamp = NULL WHERE message_id = 'old-a'");
			db.exec("UPDATE raw_messages SET content = 'updated' WHERE message_id = 'old-a'");
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM raw_messages_fts WHERE raw_messages_fts MATCH 'updated'").get(),
			).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	});
});
