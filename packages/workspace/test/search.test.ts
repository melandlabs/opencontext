/**
 * Tests for the lexical / semantic / hybrid / cross-file search pipeline.
 * Embeddings are mocked with deterministic 1536-dim vectors so we never hit
 * OpenRouter and the distance ordering is reproducible.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { searchWorkspaceContext } from "../src/api";
import { searchLexical } from "../src/search/lexical";
import { searchSemantic } from "../src/search/semantic";
import { fuseHybridHits } from "../src/search/hybrid";
import { searchCrossFile } from "../src/search/cross-file";
import { SqliteWorkspaceStore } from "../src/sqlite";
import type { OkfFolderResource, WorkspaceSearchHit } from "../src/types";

let scratchDir: string;

beforeEach(() => {
	scratchDir = mkdtempSync(join(tmpdir(), "workspace-search-"));
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

function makeResource(overrides: Partial<OkfFolderResource> & Pick<OkfFolderResource, "canonical_key" | "body">): OkfFolderResource {
	return {
		absolute_path: `/fake/${overrides.canonical_key}`,
		title: overrides.canonical_key,
		resource_type: overrides.canonical_key.endsWith(".md") ? "note" : "document",
		size_bytes: overrides.body.length,
		...overrides,
	};
}

const DIMS = 1536;

function makeDeterministicVector(seed: number): number[] {
	// Push the vector onto a unit sphere so cosine distance is
	// reproducible. Two resources whose `seed` shares any high bits get
	// similar vectors, which mirrors "documents on the same topic".
	const vec = new Array<number>(DIMS).fill(0);
	let state = seed;
	for (let i = 0; i < DIMS; i += 1) {
		state = (state * 1103515245 + 12345) >>> 0;
		vec[i] = (state / 0xffffffff) * 2 - 1;
	}
	let norm = 0;
	for (const v of vec) norm += v * v;
	norm = Math.sqrt(norm) || 1;
	return vec.map((v) => v / norm);
}

async function indexThreeDocuments(store: SqliteWorkspaceStore): Promise<void> {
	await store.indexResource({
		workspace_id: "p1",
		user_id: "u1",
		resource: makeResource({ canonical_key: "Reference/contract.md", body: "limitation of liability clauses must conform to applicable law".trim() }),
	});
	await store.indexResource({
		workspace_id: "p1",
		user_id: "u1",
		resource: makeResource({ canonical_key: "Reference/law.md", body: "civil code article 123: parties may limit liability unless the law forbids it".trim() }),
	});
	await store.indexResource({
		workspace_id: "p1",
		user_id: "u1",
		resource: makeResource({ canonical_key: "Reference/cookie-policy.md", body: "this document describes cookie usage on the marketing site".trim() }),
	});
}

describe("search pipeline", () => {
	it("returns BM25-ranked lexical hits for matching keywords", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		await indexThreeDocuments(store);
		const hits = searchLexical(store, {
			workspace_id: "p1",
			user_id: "u1",
			query: "limitation liability",
			limit: 5,
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.resource_title).toContain("contract.md");
		expect(hits[0]?.signals.lexical).toBeGreaterThan(0);
		await store.close();
	});

	it("returns no semantic hits when embeddings haven't been written", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		await indexThreeDocuments(store);
		const hits = searchSemantic(store, {
			workspace_id: "p1",
			user_id: "u1",
			queryEmbedding: makeDeterministicVector(1),
			limit: 5,
			threshold: 0.0,
		});
		expect(hits).toEqual([]);
		await store.close();
	});

	it("fuses lexical + semantic candidates via RRF (k=60)", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		await indexThreeDocuments(store);
		const lexical = searchLexical(store, {
			workspace_id: "p1",
			user_id: "u1",
			query: "limitation",
			limit: 5,
		});
		// Fabricate semantic hits with monotonically decreasing scores so
		// the RRF fusion ranks the top one highest.
		const semantic: WorkspaceSearchHit[] = lexical.map((hit, index) => ({
			...hit,
			score: 0.9 - index * 0.1,
			signals: { semantic: 0.9 - index * 0.1 },
		}));
		const fused = fuseHybridHits({ lexical, semantic, limit: 3 });
		expect(fused.length).toBeGreaterThan(0);
		expect(fused[0]?.score).toBeGreaterThanOrEqual(fused[1]?.score ?? 0);
		await store.close();
	});

	it("expands hits via cites edges for cross-file search", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		const contract = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "Reference/contract.md", body: "limitation clause text" }),
		});
		const law = await store.indexResource({
			workspace_id: "p1",
			user_id: "u1",
			resource: makeResource({ canonical_key: "Reference/law.md", body: "civil code article 123" }),
		});
		store.upsertReferenceEdges({
			workspace_id: "p1",
			edges: [
				{
					source_resource_id: contract.resource_id,
					source_version_id: contract.version_id,
					target_resource_id: law.resource_id,
					target_version_id: law.version_id,
					edge_type: "cites",
				},
			],
		});
		const hits = await searchCrossFile(store, {
			workspace_id: "p1",
			user_id: "u1",
			query: "limitation",
			limit: 5,
			lexicalSearch: (params) => searchLexical(store, params),
			semanticSearch: (params) => searchSemantic(store, params),
		});
		expect(hits.length).toBeGreaterThan(0);
		const lawHit = hits.find((hit) => hit.resource_id === law.resource_id);
		expect(lawHit).toBeDefined();
		expect(lawHit?.signals.edge_boost).toBeGreaterThan(0);
		await store.close();
	});

	it("falls back to lexical-only when embeddings fail during hybrid search", async () => {
		const store = new SqliteWorkspaceStore({ dbPath: join(scratchDir, "store.db") });
		await store.init();
		await indexThreeDocuments(store);
		const result = await searchWorkspaceContext(
			{ user_id: "u1", request_id: "req-1" },
			store,
			{ workspace_id: "p1", query: "limitation", strategy: "hybrid" },
			{
				embed: async () => {
					throw new Error("simulated embedding failure");
				},
			},
		);
		expect(result.total).toBeGreaterThan(0);
		expect(result.strategy).toBe("hybrid");
		await store.close();
	});
});
