import type { Message } from "@melandlabs/integrations-channels";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
import { describe, expect, it } from "vitest";
import { opencontextMessageToTgText, tgMessageToopencontextMessage, withTimeout } from "./adapter";

describe("opencontextMessageToTgText", () => {
	it("returns a plain string as-is", () => {
		expect(opencontextMessageToTgText("hello")).toBe("hello");
	});

	it("extracts text from a message node", () => {
		expect(opencontextMessageToTgText({ text: "hello" } as Message)).toBe("hello");
	});

	it("formats an @ mention node", () => {
		expect(opencontextMessageToTgText({ target: "username" } as Message)).toBe("@username");
	});

	it("joins nested nodes recursively", () => {
		const message = {
			nodes: ["Hello ", { target: "user" }, ", how are you?"],
		} as unknown as Message;
		expect(opencontextMessageToTgText(message)).toBe("Hello @user, how are you?");
	});

	it("handles deeply nested nodes", () => {
		const message = {
			nodes: [
				{
					nodes: ["nested ", { text: "text" }],
				},
			],
		} as unknown as Message;
		expect(opencontextMessageToTgText(message)).toBe("nested text");
	});

	it("returns empty string for unsupported shapes", () => {
		expect(opencontextMessageToTgText({ url: "https://x.com" } as Message)).toBe("");
	});
});

describe("tgMessageToopencontextMessage", () => {
	function makeMessage(overrides: Partial<Api.Message> = {}): Api.Message {
		return new Api.Message({
			id: 1,
			peerId: new Api.PeerUser({ userId: bigInt(123) }),
			date: 0,
			message: "hello",
			...overrides,
		});
	}

	it("returns the message text", () => {
		const message = makeMessage({ message: "hello world" });
		expect(tgMessageToopencontextMessage(message)).toEqual(["hello world"]);
	});

	it("returns media placeholder when no text but media is present", () => {
		const message = makeMessage({
			message: "",
			media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(1) }) }),
		});
		expect(tgMessageToopencontextMessage(message)).toEqual(["[Media content]"]);
	});

	it("returns empty array when message has no text and no media", () => {
		const message = makeMessage({ message: "" });
		expect(tgMessageToopencontextMessage(message)).toEqual([]);
	});

	it("extracts @ mentions as At nodes", () => {
		const message = makeMessage({
			message: "hello @world",
			entities: [new Api.MessageEntityMention({ offset: 6, length: 6 })],
		});
		expect(tgMessageToopencontextMessage(message)).toEqual(["hello @world", { target: "world" }]);
	});

	it("ignores non-mention entities", () => {
		const message = makeMessage({
			message: "bold text",
			entities: [new Api.MessageEntityBold({ offset: 0, length: 4 })],
		});
		expect(tgMessageToopencontextMessage(message)).toEqual(["bold text"]);
	});

	it("extracts multiple mentions", () => {
		const message = makeMessage({
			message: "@alice and @bob",
			entities: [
				new Api.MessageEntityMention({ offset: 0, length: 6 }),
				new Api.MessageEntityMention({ offset: 11, length: 4 }),
			],
		});
		expect(tgMessageToopencontextMessage(message)).toEqual([
			"@alice and @bob",
			{ target: "alice" },
			{ target: "bob" },
		]);
	});
});

describe("withTimeout", () => {
	it("resolves when the promise resolves before the timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
		expect(result).toBe("ok");
	});

	it("rejects with the original error when the promise rejects", async () => {
		await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "test")).rejects.toThrow("boom");
	});

	it("rejects with a timeout error when the promise does not resolve in time", async () => {
		const slow = new Promise((resolve) => setTimeout(resolve, 1000));
		await expect(withTimeout(slow, 10, "slow-op")).rejects.toThrow("slow-op timed out after 10ms");
	});
});
