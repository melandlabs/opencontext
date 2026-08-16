/**
 * Tests for the lib-mode knowledge store.
 *
 * These exercise SQLite + sqlite-vec storage with a fake embedding provider
 * so the tests do not need to download ONNX weights.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibKnowledgeStore, KnowledgeUnavailableError } from "../src/knowledge-store.js";

function makeFakeProvider(dim = 384) {
	// Identical unit vectors make every query match every chunk with score 1.
	const vec = makeUnitVector(dim, 0);
	return {
		getDimensions: () => dim,
		embedDocuments: async (texts: string[]) => texts.map(() => vec),
		embedQuery: async () => vec,
	};
}

function makeUnitVector(dim: number, seed: number): number[] {
	const vec = Array.from({ length: dim }, () => 0);
	vec[seed % dim] = 1;
	return vec;
}

describe("LibKnowledgeStore", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "dsh-knowledge-"));
		dbPath = join(tmpDir, "knowledge.db");
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("uploads a document and returns chunks", async () => {
		const store = new LibKnowledgeStore({ dbPath, provider: makeFakeProvider() });

		const result = await store.uploadDocument({
			content: "This is a test document. It has multiple sentences for chunking.",
			filename: "test.txt",
			mimeType: "text/plain",
			scopeId: "scope-1",
			userId: "user-1",
		});

		expect(result.documentId).toMatch(/^doc-/);
		expect(result.chunks).toBeGreaterThan(0);
	});

	it("lists uploaded documents", async () => {
		const store = new LibKnowledgeStore({ dbPath, provider: makeFakeProvider() });

		await store.uploadDocument({
			content: "Document one",
			filename: "one.txt",
			mimeType: "text/plain",
			scopeId: "scope-1",
			userId: "user-1",
		});

		const { documents } = await store.listDocuments({ limit: 10, scopeId: "scope-1", userId: "user-1" });

		expect(documents).toHaveLength(1);
		expect(documents[0]!.filename).toBe("one.txt");
		expect(documents[0]!.chunks).toBeGreaterThan(0);
	});

	it("searches knowledge by query", async () => {
		const store = new LibKnowledgeStore({ dbPath, provider: makeFakeProvider() });

		await store.uploadDocument({
			content: "The quick brown fox jumps over the lazy dog. Foxes are clever animals.",
			filename: "animals.txt",
			mimeType: "text/plain",
			scopeId: "scope-1",
			userId: "user-1",
		});

		const { chunks } = await store.searchKnowledge({
			query: "fox",
			limit: 5,
			threshold: 0,
			scopeId: "scope-1",
			userId: "user-1",
		});

		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]!.content.toLowerCase()).toContain("fox");
	});

	it("isolates documents by scope/user", async () => {
		const store = new LibKnowledgeStore({ dbPath, provider: makeFakeProvider() });

		await store.uploadDocument({
			content: "Private note",
			filename: "private.txt",
			mimeType: "text/plain",
			scopeId: "scope-a",
			userId: "user-a",
		});

		const other = await store.listDocuments({ limit: 10, scopeId: "scope-b", userId: "user-b" });
		expect(other.documents).toHaveLength(0);

		const mine = await store.listDocuments({ limit: 10, scopeId: "scope-a", userId: "user-a" });
		expect(mine.documents).toHaveLength(1);
	});

	it("throws KnowledgeUnavailableError when provider is missing", async () => {
		const store = new LibKnowledgeStore({ dbPath, provider: null });

		await expect(
			store.uploadDocument({
				content: "test",
				filename: "test.txt",
				mimeType: "text/plain",
				scopeId: "scope-1",
				userId: "user-1",
			}),
		).rejects.toThrow(KnowledgeUnavailableError);
	});
});
