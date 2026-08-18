import { describe, expect, it } from "vitest";
import { isTelegramContactMeta } from "./contacts.js";

describe("isTelegramContactMeta", () => {
	it("returns true for valid telegram user meta", () => {
		expect(
			isTelegramContactMeta({
				platform: "telegram",
				peerId: "12345",
				peerType: "user",
			}),
		).toBe(true);
	});

	it("returns true for valid telegram channel meta", () => {
		expect(
			isTelegramContactMeta({
				platform: "telegram",
				peerId: "-100123",
				peerType: "channel",
				accessHash: "abc",
				username: "news",
			}),
		).toBe(true);
	});

	it("returns false for null", () => {
		expect(isTelegramContactMeta(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isTelegramContactMeta(undefined)).toBe(false);
	});

	it("returns false when platform is not telegram", () => {
		expect(
			isTelegramContactMeta({
				platform: "whatsapp",
				peerId: "12345",
				peerType: "user",
			}),
		).toBe(false);
	});

	it("returns false when peerId is missing", () => {
		expect(
			isTelegramContactMeta({ platform: "telegram", peerType: "user" } as unknown as Record<string, unknown>),
		).toBe(false);
	});

	it("returns false when peerType is missing", () => {
		expect(
			isTelegramContactMeta({ platform: "telegram", peerId: "12345" } as unknown as Record<string, unknown>),
		).toBe(false);
	});
});
