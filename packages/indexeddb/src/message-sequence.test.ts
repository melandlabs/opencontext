import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexedDBManager } from "./manager";
import type { RawMessage } from "./storage";

const managers: IndexedDBManager[] = [];
async function reset() {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase("opencontext_messages_db");
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}
beforeEach(reset);
afterEach(reset);
function manager() {
	const instance = new IndexedDBManager();
	managers.push(instance);
	return instance;
}
const message = (messageId: string, userId = "alice", extra: Partial<RawMessage> = {}): RawMessage => ({
	messageId,
	userId,
	platform: "test",
	botId: "test",
	content: `memory ${messageId}`,
	createdAt: 1,
	...extra,
});

describe("IndexedDB message sequence", () => {
	it("allocates atomically across connections, persists across reopen, and keeps retries unchanged", async () => {
		const first = manager();
		const second = manager();
		await Promise.all([first.init(), second.init()]);
		await Promise.all([first.storeMessage(message("a")), second.storeMessage(message("b"))]);
		const sequences = [
			(await first.getMessageById("a"))?.messageSequence,
			(await second.getMessageById("b"))?.messageSequence,
		];
		expect(sequences.sort()).toEqual([1, 2]);
		await first.storeMessage(message("a", "alice", { messageSequence: 999 }));
		expect((await first.getMessageById("a"))?.messageSequence).toBe(1);
		await first.close();
		await second.close();
		const reopened = manager();
		await reopened.storeMessages([message("c"), message("bob", "bob", { timestamp: 123 })]);
		expect((await reopened.getMessageById("c"))?.messageSequence).toBe(3);
		expect(await reopened.getMessageById("bob")).toMatchObject({ messageSequence: 1, timestamp: 123 });
		expect((await reopened.getMessageById("c"))?.timestamp).toBeUndefined();
		expect(await reopened.queryMessages({ userId: "alice" })).toHaveLength(3);
	});

	it("migrates existing records by stored insertion order, not timestamps", async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("opencontext_messages_db", 4);
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore("raw_messages", {
					keyPath: "id",
					autoIncrement: true,
				});
				store.add(message("old-a", "alice", { timestamp: 200 }));
				store.add(message("old-b", "alice", { timestamp: 100 }));
			};
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => reject(request.error);
		});
		const upgraded = manager();
		await upgraded.storeMessage(message("new"));
		expect(await upgraded.getMessageById("old-a")).toMatchObject({ messageSequence: 1, timestamp: 200 });
		expect(await upgraded.getMessageById("old-b")).toMatchObject({ messageSequence: 2, timestamp: 100 });
		expect((await upgraded.getMessageById("new"))?.messageSequence).toBe(3);
	});
});
