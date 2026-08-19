/**
 * Tests for the additive `Peer` contract.
 *
 * The Peer type coexists with the legacy `userId` / `botId` strings; no
 * existing test depends on `peerId` field names. The new helpers must
 * round-trip through their string form and lift loose strings without
 * throwing.
 */
import { describe, expect, it } from "vitest";
import { asPeer, asPeers, isPeer, isPeerKind, parsePeerKey, peerKey } from "./peer";

describe("peerKey / parsePeerKey", () => {
	it("round-trips a user peer", () => {
		const original = { kind: "user" as const, id: "42" };
		const key = peerKey(original);
		expect(key).toBe("user:42");
		expect(parsePeerKey(key)).toEqual(original);
	});

	it("round-trips an agent peer with a complex id", () => {
		const original = { kind: "agent" as const, id: "bot-7_alpha" };
		const key = peerKey(original);
		expect(key).toBe("agent:bot-7_alpha");
		expect(parsePeerKey(key)).toEqual(original);
	});

	it("returns undefined for malformed keys", () => {
		expect(parsePeerKey("")).toBeUndefined();
		expect(parsePeerKey(":42")).toBeUndefined();
		expect(parsePeerKey("user:")).toBeUndefined();
		expect(parsePeerKey("alien:42")).toBeUndefined();
		expect(parsePeerKey("user")).toBeUndefined();
	});

	it("returns undefined for non-string input", () => {
		expect(parsePeerKey(undefined as unknown as string)).toBeUndefined();
		expect(parsePeerKey(null as unknown as string)).toBeUndefined();
		expect(parsePeerKey(42 as unknown as string)).toBeUndefined();
	});
});

describe("isPeerKind / isPeer", () => {
	it("accepts only the two literal kinds", () => {
		expect(isPeerKind("user")).toBe(true);
		expect(isPeerKind("agent")).toBe(true);
		expect(isPeerKind("alien")).toBe(false);
		expect(isPeerKind("")).toBe(false);
		expect(isPeerKind(null)).toBe(false);
	});

	it("validates the structural Peer shape", () => {
		expect(isPeer({ kind: "user", id: "42" })).toBe(true);
		expect(isPeer({ kind: "agent", id: "bot-7" })).toBe(true);
		expect(isPeer({ kind: "alien", id: "42" })).toBe(false);
		expect(isPeer({ kind: "user" })).toBe(false);
		expect(isPeer({ id: "42" })).toBe(false);
		expect(isPeer(null)).toBe(false);
		expect(isPeer("user:42")).toBe(false);
	});
});

describe("asPeer / asPeers", () => {
	it("defaults kind to user when omitted", () => {
		expect(asPeer("42")).toEqual({ kind: "user", id: "42" });
	});

	it("honours an explicit kind", () => {
		expect(asPeer("bot-7", "agent")).toEqual({ kind: "agent", id: "bot-7" });
	});

	it("drops empty / whitespace entries in asPeers", () => {
		expect(asPeers(["42", "", "  ", "bot-7"], "agent")).toEqual([
			{ kind: "agent", id: "42" },
			{ kind: "agent", id: "bot-7" },
		]);
	});

	it("returns an empty array for an empty input", () => {
		expect(asPeers([])).toEqual([]);
	});

	it("filters non-string entries without throwing", () => {
		const result = asPeers(["a", null, undefined, 42, "b"] as unknown as string[]);
		expect(result).toEqual([
			{ kind: "user", id: "a" },
			{ kind: "user", id: "b" },
		]);
	});
});
