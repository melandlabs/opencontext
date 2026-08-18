import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailConversationStore } from "./conversation-store";

describe("GmailConversationStore", () => {
	let tempDir: string;
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "gmail-store-test-"));
		consoleSpy = vi.spyOn(console, "log").mockReturnValue(undefined);
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function todayFilePath(memoryDir: string): string {
		const today = new Date().toISOString().slice(0, 10);
		return join(memoryDir, "channels", "gmail", "gmail", `${today}.json`);
	}

	it("uses the provided memory directory", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		expect(store).toBeInstanceOf(GmailConversationStore);
	});

	it("returns an empty conversation history before any messages are added", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		expect(store.getConversationHistory("user-1", "account-1")).toEqual([]);
	});

	it("adds messages and returns them without timestamps", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		store.addMessage("user-1", "account-1", "user", "Hello");
		store.addMessage("user-1", "account-1", "assistant", "Hi there");

		const history = store.getConversationHistory("user-1", "account-1");
		expect(history).toEqual([
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		]);
	});

	it("persists messages to a temp directory and reloads them in a new instance", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		store.addMessage("user-1", "account-1", "user", "First");
		store.addMessage("user-1", "account-1", "assistant", "Second");

		const filePath = todayFilePath(tempDir);
		expect(existsSync(filePath)).toBe(true);

		const persisted = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(persisted["gmail:user-1"]["account-1"]).toHaveLength(2);
		expect(persisted["gmail:user-1"]["account-1"][0]).toMatchObject({
			role: "user",
			content: "First",
		});

		const reloaded = new GmailConversationStore("user-1", tempDir);
		expect(reloaded.getConversationHistory("user-1", "account-1")).toEqual([
			{ role: "user", content: "First" },
			{ role: "assistant", content: "Second" },
		]);
	});

	it("isolates conversations by user and account", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		store.addMessage("user-1", "account-1", "user", "A1");
		store.addMessage("user-1", "account-2", "user", "A2");
		store.addMessage("user-2", "account-1", "user", "U2");

		expect(store.getConversationHistory("user-1", "account-1")).toEqual([{ role: "user", content: "A1" }]);
		expect(store.getConversationHistory("user-1", "account-2")).toEqual([{ role: "user", content: "A2" }]);
		expect(store.getConversationHistory("user-2", "account-1")).toEqual([{ role: "user", content: "U2" }]);
	});

	it("clears a single conversation", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		store.addMessage("user-1", "account-1", "user", "Hello");
		store.addMessage("user-1", "account-2", "user", "Other");

		store.clearConversation("user-1", "account-1");

		expect(store.getConversationHistory("user-1", "account-1")).toEqual([]);
		expect(store.getConversationHistory("user-1", "account-2")).toEqual([{ role: "user", content: "Other" }]);

		const filePath = todayFilePath(tempDir);
		const persisted = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(persisted["gmail:user-1"]["account-1"]).toBeUndefined();
		expect(persisted["gmail:user-1"]["account-2"]).toHaveLength(1);
	});

	it("clears all conversations for a user", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		store.addMessage("user-1", "account-1", "user", "A1");
		store.addMessage("user-1", "account-2", "user", "A2");
		store.addMessage("user-2", "account-1", "user", "U2");

		store.clearAllConversations("user-1");

		expect(store.getConversationHistory("user-1", "account-1")).toEqual([]);
		expect(store.getConversationHistory("user-1", "account-2")).toEqual([]);
		expect(store.getConversationHistory("user-2", "account-1")).toEqual([{ role: "user", content: "U2" }]);
	});

	it("logs operations to the console", () => {
		const store = new GmailConversationStore("user-1", tempDir);
		store.addMessage("user-1", "account-1", "user", "Hello");
		store.clearConversation("user-1", "account-1");
		store.clearAllConversations("user-1");

		expect(consoleSpy).toHaveBeenCalledTimes(3);
		expect(consoleSpy.mock.calls[0][0]).toContain("Added user message");
		expect(consoleSpy.mock.calls[1][0]).toContain("Cleared conversation");
		expect(consoleSpy.mock.calls[2][0]).toContain("Cleared all conversations");
	});
});
