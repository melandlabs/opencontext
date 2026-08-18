/**
 * Contract-level tests for the `factType` column on `RawMessage` and the
 * `factTypes` filter on `RawMessageQuery` introduced in IndexedDB v4.
 *
 * These tests exercise the structural contract end-to-end without spinning
 * up a real IndexedDB instance: the `mergeStoredChatMemoryEvidence` helper
 * is the boundary where `factType` is preserved across upsert, and the
 * query shape is validated by mirroring the same filter rules used in
 * `IndexedDBManager.queryMessages`.
 */
import { describe, expect, it } from "vitest";

import {
	CHAT_MEMORY_EVIDENCE_ID_PREFIX,
	type RawMessage,
	type RawMessageQuery,
	mergeStoredChatMemoryEvidence,
} from "./storage";

function makeMessage(overrides: Partial<RawMessage> & { messageId: string }): RawMessage {
	const now = Math.floor(Date.now() / 1000);
	return {
		platform: "test",
		botId: "bot-1",
		userId: "u1",
		timestamp: now,
		content: "x",
		createdAt: now,
		...overrides,
	};
}

// Chat-memory messages must carry the chat prefix; mergeStoredChatMemoryEvidence
// returns the incoming record unchanged when the prefix is absent.
function chatId(suffix: string): string {
	return `${CHAT_MEMORY_EVIDENCE_ID_PREFIX}${suffix}`;
}

// Mirror of the filter logic added to IndexedDBManager.queryMessages. Keeping
// the rule here, isolated from the live cursor implementation, makes the
// rule testable without a fake-indexeddb dependency.
function passesFactTypesFilter(message: RawMessage, query: RawMessageQuery): boolean {
	if (!query.factTypes || query.factTypes.length === 0) return true;
	if (!message.factType) return false;
	return query.factTypes.includes(message.factType);
}

describe("RawMessage — factType passthrough", () => {
	it("mergeStoredChatMemoryEvidence preserves an existing factType", () => {
		const existing = makeMessage({ messageId: chatId("m1"), factType: "world" });
		const incoming = makeMessage({ messageId: chatId("m1"), content: "new content" });
		const merged = mergeStoredChatMemoryEvidence(existing, incoming);
		expect(merged.factType).toBe("world");
	});

	it("mergeStoredChatMemoryEvidence accepts an incoming factType on first insert", () => {
		const existing = makeMessage({ messageId: chatId("m1") });
		const incoming = makeMessage({ messageId: chatId("m1"), factType: "experience" });
		const merged = mergeStoredChatMemoryEvidence(existing, incoming);
		expect(merged.factType).toBe("experience");
	});
});

describe("RawMessageQuery.factTypes filter rules", () => {
	const taggedWorld = makeMessage({ messageId: "m1", factType: "world" });
	const taggedExperience = makeMessage({ messageId: "m2", factType: "experience" });
	const taggedMentalModel = makeMessage({ messageId: "m3", factType: "mental_model" });
	const untagged = makeMessage({ messageId: "m4" });

	it("returns everything when factTypes is missing", () => {
		expect(passesFactTypesFilter(taggedWorld, {})).toBe(true);
		expect(passesFactTypesFilter(untagged, {})).toBe(true);
	});

	it("returns everything when factTypes is empty", () => {
		expect(passesFactTypesFilter(taggedWorld, { factTypes: [] })).toBe(true);
		expect(passesFactTypesFilter(untagged, { factTypes: [] })).toBe(true);
	});

	it("excludes untagged rows when filter is non-empty", () => {
		expect(passesFactTypesFilter(untagged, { factTypes: ["world"] })).toBe(false);
	});

	it("includes only matching tagged rows", () => {
		expect(passesFactTypesFilter(taggedWorld, { factTypes: ["world"] })).toBe(true);
		expect(passesFactTypesFilter(taggedExperience, { factTypes: ["world"] })).toBe(false);
		expect(passesFactTypesFilter(taggedMentalModel, { factTypes: ["world"] })).toBe(false);
	});

	it("accepts multiple types", () => {
		const query: RawMessageQuery = { factTypes: ["world", "experience"] };
		expect(passesFactTypesFilter(taggedWorld, query)).toBe(true);
		expect(passesFactTypesFilter(taggedExperience, query)).toBe(true);
		expect(passesFactTypesFilter(taggedMentalModel, query)).toBe(false);
		expect(passesFactTypesFilter(untagged, query)).toBe(false);
	});
});
