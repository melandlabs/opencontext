/**
 * Tests for `PostgresWorkspaceStore` — the serverless backend.
 *
 * The suite is gated on `WORKSPACE_POSTGRES_URL`: without it there is no
 * database to talk to, and the package's unit tests must stay runnable
 * on a bare checkout.
 *
 * Every run gets its own Postgres **schema** (`search_path`), so the
 * tables the store creates never touch the host database's `public`
 * schema and the run leaves nothing behind: the schema is dropped in
 * `afterAll`.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresWorkspaceStore } from "../src/postgres";
import type { PostgresWorkspaceStore } from "../src/postgres";
import type { OkfFolderResource } from "../src/types";

const POSTGRES_URL = process.env.WORKSPACE_POSTGRES_URL;
const SCHEMA = `workspace_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * The direct (unpooled) connection string.
 *
 * A pooled gateway (Neon's, for one) multiplexes client connections onto
 * shared backend sessions: a session-level `search_path` set with `SET`
 * leaks between them, and the pooled endpoint rejects `search_path` as a
 * startup parameter outright. The unpooled endpoint gives every connection
 * its own session, which is what the per-run schema below needs.
 */
function directUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.hostname.includes("-pooler.")) {
		parsed.hostname = parsed.hostname.replace("-pooler.", ".");
	}
	return parsed.toString();
}

const PG_URL = POSTGRES_URL ? directUrl(POSTGRES_URL) : "";

let store: PostgresWorkspaceStore;

/**
 * Run a statement against the run's schema with a client of our own — the
 * store's pool is private, and the drift test needs to write a row the
 * store did not write.
 */
async function withSchemaClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
	const client = new Client({
		connectionString: PG_URL,
		options: `-c search_path=${SCHEMA},public`,
	});
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

function makeResource(
	overrides: Partial<OkfFolderResource> & Pick<OkfFolderResource, "canonical_key" | "body">,
): OkfFolderResource {
	return {
		absolute_path: `/fake/${overrides.canonical_key}`,
		title: overrides.canonical_key,
		resource_type: "note",
		size_bytes: overrides.body.length,
		...overrides,
	};
}

describe.skipIf(!POSTGRES_URL)("PostgresWorkspaceStore", () => {
	beforeAll(async () => {
		const bootstrap = new Client({ connectionString: PG_URL });
		await bootstrap.connect();
		await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
		await bootstrap.end();
		store = await createPostgresWorkspaceStore({
			connectionString: PG_URL,
			poolOptions: { options: `-c search_path=${SCHEMA},public` },
		});
	});

	afterAll(async () => {
		await store?.close();
		const bootstrap = new Client({ connectionString: PG_URL });
		await bootstrap.connect();
		await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
		await bootstrap.end();
	});

	it("creates the schema and reports the postgres backend", async () => {
		expect(store.backend).toBe("postgres");
		const tables = await store.listResources({ workspace_id: "w1", limit: 1, offset: 0 });
		expect(tables.total).toBe(0);
	});

	it("indexes a resource, versions it, and dedups on re-index", async () => {
		const resource = makeResource({
			canonical_key: "docs/intro.md",
			body: "Hello world. This is the first document for the project.",
		});
		const created = await store.indexResource({
			workspace_id: "w1",
			user_id: "u1",
			resource,
		});
		expect(created.change_kind).toBe("created");

		const unchanged = await store.indexResource({
			workspace_id: "w1",
			user_id: "u1",
			resource,
		});
		expect(unchanged.change_kind).toBe("unchanged");
		expect(unchanged.version_id).toBe(created.version_id);

		const modified = await store.indexResource({
			workspace_id: "w1",
			user_id: "u1",
			resource: { ...resource, body: "Hello world. This is the second revision." },
		});
		expect(modified.change_kind).toBe("modified");
		expect(modified.version_id).not.toBe(created.version_id);
		expect(modified.resource_id).toBe(created.resource_id);
	});

	it("finds an indexed document with a lexical query", async () => {
		const hits = await store.searchLexical({
			workspace_id: "w1",
			user_id: "u1",
			query: "revision",
			limit: 10,
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.canonical_key).toBe("docs/intro.md");
		expect(hits[0]?.citation).toBeDefined();
	});

	it("matches a Chinese query through the bigram token chain", async () => {
		await store.indexResource({
			workspace_id: "w1",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "docs/pricing.md",
				body: "定价方案需要在季度末完成评审。",
			}),
		});
		const hits = await store.searchLexical({
			workspace_id: "w1",
			user_id: "u1",
			query: "定价",
			limit: 10,
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.canonical_key).toBe("docs/pricing.md");
	});

	it("scopes lexical hits to the requesting user", async () => {
		const hits = await store.searchLexical({
			workspace_id: "w1",
			user_id: "another-user",
			query: "revision",
			limit: 10,
		});
		expect(hits).toEqual([]);
	});

	it("resolves a citation and reports drift once the chunk changes", async () => {
		const hits = await store.searchLexical({
			workspace_id: "w1",
			user_id: "u1",
			query: "revision",
			limit: 1,
		});
		const citation = hits[0]?.citation;
		expect(citation).toBeDefined();

		const resolved = await store.resolveCitation({
			workspace_id: "w1",
			user_id: "u1",
			citation,
		});
		expect(resolved.status).toBe("resolved");

		await withSchemaClient((client) =>
			client.query("UPDATE workspace_chunks SET content = $1, content_hash = $2 WHERE chunk_id = $3", [
				"amended content",
				"drifted-hash",
				citation.chunk_id,
			]),
		);

		const drifted = await store.resolveCitation({
			workspace_id: "w1",
			user_id: "u1",
			citation,
		});
		expect(drifted.status).toBe("drifted");
		if (drifted.status === "drifted") {
			expect(drifted.expected_hash).toBe(citation.content_hash);
		}
	});

	it("hides soft-deleted resources from the listing and from search", async () => {
		await store.indexResource({
			workspace_id: "w2",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "docs/doomed.md",
				body: "this document will be removed again",
			}),
		});
		const before = await store.listResources({ workspace_id: "w2", limit: 10, offset: 0 });
		expect(before.total).toBe(1);

		const deleted = await store.softDeleteResource({
			workspace_id: "w2",
			canonical_key: "docs/doomed.md",
		});
		expect(deleted.deleted).toBe(true);

		const after = await store.listResources({ workspace_id: "w2", limit: 10, offset: 0 });
		expect(after.total).toBe(0);
		const hits = await store.searchLexical({
			workspace_id: "w2",
			user_id: "u1",
			query: "removed",
			limit: 10,
		});
		expect(hits).toEqual([]);
	});

	it("walks cites edges when expanding neighbours", async () => {
		const contract = await store.indexResource({
			workspace_id: "w3",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "Reference/contract.md",
				body: "limitation of liability clause",
			}),
		});
		const law = await store.indexResource({
			workspace_id: "w3",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "Reference/law.md",
				body: "civil code article 123",
			}),
		});
		await store.upsertReferenceEdges({
			workspace_id: "w3",
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

		const seeds = await store.searchLexical({
			workspace_id: "w3",
			user_id: "u1",
			query: "limitation",
			limit: 5,
		});
		expect(seeds.length).toBeGreaterThan(0);

		const expanded = await store.expandNeighbors({
			workspace_id: "w3",
			user_id: "u1",
			hits: seeds,
			hops: 1,
			limit: 10,
		});
		const neighbour = expanded.find((hit) => hit.resource_id === law.resource_id);
		expect(neighbour).toBeDefined();
		expect(neighbour?.signals.edge_boost).toBeGreaterThan(0);
	});

	it("tracks jobs and links promoted facts to a resource version", async () => {
		const job = await store.createJob({ workspace_id: "w4", kind: "index", total: 3 });
		expect(job.total).toBe(3);
		expect(job.status).toBe("pending");
		await store.updateJobTotal(job.id, 5);
		await store.completeJob(job.id, 5);
		const dlq = await store.getDlqJobs("w4");
		expect(dlq).toEqual([]);

		const indexed = await store.indexResource({
			workspace_id: "w4",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "promoted.md",
				body: "a page promoted from memory facts",
			}),
		});
		const linked = await store.linkPromotedFacts({
			workspace_id: "w4",
			resource_id: indexed.resource_id,
			version_id: indexed.version_id,
			fact_ids: ["fact-a", "fact-b"],
		});
		expect(linked.inserted).toBe(2);
	});

	it("reads a resource body back for distillation", async () => {
		const indexed = await store.indexResource({
			workspace_id: "w5",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "body.md",
				body: "the body of the resource",
			}),
		});
		const body = await store.readResourceBody({
			workspace_id: "w5",
			resource_id: indexed.resource_id,
		});
		expect(body?.canonical_key).toBe("body.md");
		expect(body?.body).toContain("the body of the resource");

		const missing = await store.readResourceBody({
			workspace_id: "w5",
			resource_id: 999_999,
		});
		expect(missing).toBeNull();
	});

	it("stores embeddings and finds them through the vector table", async () => {
		const indexed = await store.indexResource({
			workspace_id: "w6",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "vector.md",
				body: "semantic search over pgvector",
			}),
		});
		const chunks = await store.fetchPendingChunks(indexed.version_id, 10);
		expect(chunks.length).toBeGreaterThan(0);
		await store.ensureChildVectorTable(3);
		await store.writeChunkEmbeddings(
			chunks.map((chunk) => ({ chunkId: chunk.chunk_id, embedding: [1, 0, 0] })),
			"test-model",
			3,
		);

		const hits = await store.searchSemantic({
			workspace_id: "w6",
			user_id: "u1",
			queryEmbedding: [1, 0, 0],
			limit: 5,
			threshold: 0.5,
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.canonical_key).toBe("vector.md");
	});

	it("keeps one user's listing out of another user's hands", async () => {
		await store.indexResource({
			workspace_id: "w7",
			user_id: "u1",
			resource: makeResource({
				canonical_key: "docs/mine.md",
				body: "the first user's document",
			}),
		});
		await store.indexResource({
			workspace_id: "w7",
			user_id: "u2",
			resource: makeResource({
				canonical_key: "docs/theirs.md",
				body: "the second user's document",
			}),
		});

		// A workspace id is not a user boundary: the listing has to be
		// scoped by the owner, or a shared database hands one user
		// another user's resources.
		const mine = await store.listResources({
			workspace_id: "w7",
			user_id: "u1",
			limit: 10,
			offset: 0,
		});
		expect(mine.total).toBe(1);
		expect(mine.resources.map((resource) => resource.canonical_key)).toEqual(["docs/mine.md"]);

		const theirs = await store.listResources({
			workspace_id: "w7",
			user_id: "u2",
			limit: 10,
			offset: 0,
		});
		expect(theirs.total).toBe(1);
		expect(theirs.resources.map((resource) => resource.canonical_key)).toEqual(["docs/theirs.md"]);

		expect(
			await store.findResourceByCanonicalKey({
				workspace_id: "w7",
				canonical_key: "docs/theirs.md",
				user_id: "u1",
			}),
		).toBeNull();

		// The search path was already user-scoped; the listing is the one
		// that had to catch up.
		const hits = await store.searchLexical({
			workspace_id: "w7",
			user_id: "u1",
			query: "second",
			limit: 10,
		});
		expect(hits).toEqual([]);
	});
});
