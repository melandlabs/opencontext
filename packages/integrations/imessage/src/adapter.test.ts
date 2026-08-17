import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type IMessageContactMeta,
	formatIMessageChatId,
	isIMessageAvailable,
	isIMessageContactMeta,
	parseIMessageChatId,
} from "./adapter";

describe("isIMessageAvailable", () => {
	let platformSpy: ReturnType<typeof vi.spyOn> | undefined;

	afterEach(() => {
		platformSpy?.mockRestore();
	});

	it("returns true on macOS", () => {
		platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		expect(isIMessageAvailable()).toBe(true);
	});

	it("returns false on Linux", () => {
		platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		expect(isIMessageAvailable()).toBe(false);
	});

	it("returns false on Windows", () => {
		platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		expect(isIMessageAvailable()).toBe(false);
	});
});

describe("parseIMessageChatId", () => {
	it("parses a phone number from standard iMessage 1-on-1 format", () => {
		expect(parseIMessageChatId("iMessage;-;+1234567890")).toEqual({
			phoneNumber: "+1234567890",
		});
	});

	it("parses an email from standard iMessage 1-on-1 format", () => {
		expect(parseIMessageChatId("iMessage;-;Alice@Example.com")).toEqual({
			email: "alice@example.com",
		});
	});

	it("parses a direct phone number without iMessage prefix", () => {
		expect(parseIMessageChatId("+8615928069834")).toEqual({
			phoneNumber: "+8615928069834",
		});
	});

	it("strips whitespace from phone numbers", () => {
		expect(parseIMessageChatId("iMessage;-;+1 234 567 8901")).toEqual({
			phoneNumber: "+12345678901",
		});
	});

	it("returns empty object for group chat identifiers", () => {
		expect(parseIMessageChatId("iMessage;+;chat123456789")).toEqual({});
	});

	it("returns empty object for empty input", () => {
		expect(parseIMessageChatId("")).toEqual({});
	});

	it("returns empty object for identifiers that are neither phone nor email", () => {
		expect(parseIMessageChatId("iMessage;-;not-a-contact")).toEqual({});
	});
});

describe("formatIMessageChatId", () => {
	it("returns already-complete 1-on-1 identifiers unchanged", () => {
		expect(formatIMessageChatId("iMessage;-;+8615928069834")).toBe("iMessage;-;+8615928069834");
	});

	it("returns already-complete group identifiers unchanged", () => {
		expect(formatIMessageChatId("iMessage;+;chat123456")).toBe("iMessage;+;chat123456");
	});

	it("normalizes lowercase iMessage prefix", () => {
		expect(formatIMessageChatId("imessage;-;+8615928069834")).toBe("iMessage;-;+8615928069834");
	});

	it("converts SMS prefix to iMessage 1-on-1 format", () => {
		expect(formatIMessageChatId("SMS;+8615928069834")).toBe("iMessage;-;+8615928069834");
	});

	it("adds country code and iMessage prefix to a plain phone number", () => {
		expect(formatIMessageChatId("8615928069834")).toBe("iMessage;-;+8615928069834");
	});

	it("adds iMessage prefix to a phone number that already has a plus", () => {
		expect(formatIMessageChatId("+8615928069834")).toBe("iMessage;-;+8615928069834");
	});

	it("lowercases and prefixes an email", () => {
		expect(formatIMessageChatId("Alice@Example.com")).toBe("iMessage;-;alice@example.com");
	});

	it("strips whitespace before formatting", () => {
		expect(formatIMessageChatId("+1 234 567 8901")).toBe("iMessage;-;+12345678901");
	});

	it("recovers malformed iMessage identifiers", () => {
		expect(formatIMessageChatId("iMessage;alice@example.com")).toBe("iMessage;-;alice@example.com");
	});

	it("prefixes unknown identifiers as 1-on-1", () => {
		expect(formatIMessageChatId("unknown-group-id")).toBe("iMessage;-;unknown-group-id");
	});

	it("returns empty string for empty input", () => {
		expect(formatIMessageChatId("")).toBe("");
	});
});

describe("isIMessageContactMeta", () => {
	it("returns true for iMessage contact metadata", () => {
		const meta: IMessageContactMeta = {
			platform: "imessage",
			phoneNumber: "+1234567890",
		};
		expect(isIMessageContactMeta(meta)).toBe(true);
	});

	it("returns false for other platform metadata", () => {
		expect(isIMessageContactMeta({ platform: "whatsapp" })).toBe(false);
	});

	it("returns false for null or undefined", () => {
		expect(isIMessageContactMeta(null)).toBe(false);
		expect(isIMessageContactMeta(undefined)).toBe(false);
	});
});
