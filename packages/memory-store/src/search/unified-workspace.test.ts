import { createSqliteWorkspaceStore, searchWorkspaceContext } from "@melandlabs/workspace";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createUnifiedSearch } from "./unified-search";

it("fuses file evidence with other sources while retaining citation identity and trusted scope", async () => {
	const database = new Database(":memory:");
	const store = await createSqliteWorkspaceStore({ db: database });
	try {
		await store.indexResource({
			workspace_id: "personal:alice",
			user_id: "alice",
			resource: {
				canonical_key: "notes.md",
				absolute_path: "/notes.md",
				title: "Notes",
				resource_type: "note",
				body: "项目代码属于 Ava。",
				size_bytes: 30,
			},
		});
		const search = createUnifiedSearch({
			searchWorkspace: async (input) => {
				expect(input.applicabilityContexts).toEqual([{ scope: "global" }]);
				const found = await searchWorkspaceContext({ user_id: input.userId, request_id: "test" }, store, {
					workspace_id: "personal:alice",
					query: input.query,
					strategy: "lexical",
					options: { limit: input.limit },
				});
				return {
					status: "complete",
					hits: found.hits.map((hit) => ({
						id: hit.chunk_id,
						content: hit.snippet,
						similarity: hit.score,
						metadata: { citation: hit.citation, scope: "user", origin: "personal_memory" },
						provenance: {
							citation: hit.citation,
							origin: "personal_memory",
							businessReference: "notes.md",
							version: hit.citation.version_id,
							contentHash: hit.citation.content_hash,
							scope: [{ scope: "global" as const }],
							derivedFrom: [],
							confirmation: "confirmed" as const,
						},
					})),
				};
			},
			searchInsights: async () => [
				{ id: "insight-1", content: "代码讨论摘要", similarity: 0.8, metadata: { derivedFrom: "notes.md" } },
			],
		});
		const result = await search.search(
			{ userId: "alice", query: "代码", sources: ["workspace", "insights"] },
			{
				applicabilityContexts: [{ scope: "global" }],
			},
		);
		expect(result.results.map((hit) => hit.type).sort()).toEqual(["insight", "workspace"]);
		expect(result.evidence.find((hit) => hit.source === "workspace")?.metadata).toMatchObject({
			origin: "personal_memory",
			citation: { canonical_key: "notes.md", content_hash: expect.any(String) },
		});
		expect(result.evidence.find((hit) => hit.source === "workspace")?.provenance).toMatchObject({
			citation: { canonical_key: "notes.md" },
			origin: "personal_memory",
			businessReference: "notes.md",
			version: expect.any(Number),
			contentHash: expect.any(String),
			scope: [{ scope: "global" }],
			derivedFrom: [],
			confirmation: "confirmed",
			freshness: null,
		});
		expect(result.sourceStates).toEqual(
			expect.arrayContaining([
				{ source: "workspace", status: "complete", count: 1 },
				{ source: "insights", status: "complete", count: 1 },
			]),
		);
	} finally {
		await store.close();
		database.close();
	}
});

it("rejects an empty or unknown explicit source selection without querying a broader scope", async () => {
	let queried = false;
	const search = createUnifiedSearch({
		searchInsights: async () => {
			queried = true;
			return [];
		},
	});
	await expect(search.search({ userId: "alice", query: "代码", sources: [] })).rejects.toThrow(/source/i);
	await expect(
		search.search({ userId: "alice", query: "代码", sources: ["invalid" as never] }),
	).rejects.toThrow(/source/i);
	await expect(
		search.search({ userId: "alice", query: "代码", sources: ["insights", "invalid" as never] }),
	).rejects.toThrow(/source/i);
	expect(queried).toBe(false);
});

it("distinguishes unavailable sources from a completed search with no hits", async () => {
	const missing = await createUnifiedSearch().search({
		userId: "alice",
		query: "代码",
		sources: ["workspace", "insights", "knowledge"],
	});
	expect(missing.sourceStates).toEqual(
		expect.arrayContaining([
			{ source: "workspace", status: "not_configured", count: 0 },
			{ source: "insights", status: "not_configured", count: 0 },
			{ source: "knowledge", status: "not_configured", count: 0 },
		]),
	);
	const search = createUnifiedSearch({
		searchWorkspace: async () => ({ status: "not_ready", hits: [], message: "Index pending" }),
		searchKnowledge: async () => {
			throw new Error("Database unavailable");
		},
		searchInsights: async () => [],
	});
	const result = await search.search({
		userId: "alice",
		query: "代码",
		sources: ["workspace", "insights", "knowledge"],
	});
	expect(result.sourceStates).toEqual(
		expect.arrayContaining([
			{ source: "workspace", status: "not_ready", count: 0, message: "Index pending" },
			{ source: "knowledge", status: "failed", count: 0, message: "Database unavailable" },
			{ source: "insights", status: "complete", count: 0 },
		]),
	);
});

it("keeps available evidence when an optional source exceeds its waiting budget", async () => {
	const search = createUnifiedSearch({
		sourceTimeoutMs: 10,
		searchWorkspace: () => new Promise(() => {}),
		searchInsights: async () => [{ id: "i1", content: "可用资料", similarity: 0.9, metadata: {} }],
	});
	const result = await search.search({ userId: "alice", query: "资料", sources: ["workspace", "insights"] });
	expect(result.results.map((hit) => hit.id)).toEqual(["i1"]);
	expect(result.sourceStates).toEqual(
		expect.arrayContaining([expect.objectContaining({ source: "workspace", status: "failed" })]),
	);
}, 1000);

it("keeps lexical evidence when the optional query embedding never responds", async () => {
	const search = createUnifiedSearch({
		sourceTimeoutMs: 10,
		embedQuery: () => new Promise(() => {}),
		searchRawMessagesAnn: async () => [],
		searchRawMessagesLexical: async () => [
			{ id: "m1", content: "review notes", similarity: 0.9, metadata: {} },
		],
	});
	const result = await search.search({ userId: "alice", query: "review", sources: ["memory"] });
	expect(result.results.map((hit) => hit.id)).toEqual(["m1"]);
	expect(result.sourceStates).toEqual(
		expect.arrayContaining([expect.objectContaining({ source: "memory", status: "partial" })]),
	);
}, 1000);

it("falls back from native hybrid search when query embedding never responds", async () => {
	const search = createUnifiedSearch({
		sourceTimeoutMs: 10,
		embedQuery: () => new Promise(() => {}),
		searchRawMessagesHybrid: async () => [],
		searchRawMessagesLexical: async () => [
			{ id: "m1", content: "review notes", similarity: 0.9, metadata: {} },
		],
	});
	const result = await search.search({ userId: "alice", query: "review", sources: ["memory"] });
	expect(result.results.map((hit) => hit.id)).toEqual(["m1"]);
	expect(result.sourceStates[0]?.status).toBe("partial");
}, 1000);

it("explicitly reports unknown provenance instead of implying evidence is complete", async () => {
	const search = createUnifiedSearch({
		searchWorkspace: async () => ({
			status: "complete",
			hits: [{ id: "f1", content: "资料", similarity: 0.9, metadata: {} }],
		}),
	});
	const result = await search.search({ userId: "alice", query: "资料", sources: ["workspace"] });
	expect(result.evidence[0]?.provenance).toMatchObject({
		citation: null,
		origin: null,
		businessReference: null,
		version: null,
		contentHash: null,
		scope: null,
		derivedFrom: null,
		confirmation: null,
		freshness: null,
	});
});

it("includes Workspace evidence and its provenance in optional synthesis", async () => {
	let prompt = "";
	const search = createUnifiedSearch({
		searchWorkspace: async () => ({
			status: "complete",
			hits: [
				{
					id: "f1",
					content: "项目代码属于 Ava。",
					similarity: 0.9,
					metadata: {},
					provenance: { origin: "personal_memory", version: 2, contentHash: "hash-v2" },
				},
			],
		}),
		reasoning: {
			complete: async (value) => {
				prompt = value;
				return "Ava";
			},
		},
	});
	const result = await search.search({
		userId: "alice",
		query: "代码属于谁",
		sources: ["workspace"],
		synthesize: true,
	});
	expect(result.answer).toBe("Ava");
	expect(prompt).toContain("项目代码属于 Ava。");
	expect(prompt).toContain('"contentHash":"hash-v2"');
	expect(prompt).toContain('"confirmation":null');
});

it("reports partial availability when readiness diagnostics fail after usable retrieval", async () => {
	const search = createUnifiedSearch({
		searchRawMessagesLexical: async () => [
			{ id: "m1", content: "review notes", similarity: 0.9, metadata: {} },
		],
		getRawMessageRetrievalStatus: async () => {
			throw new Error("Status unavailable");
		},
	});
	const result = await search.search({ userId: "alice", query: "review", sources: ["memory"] });
	expect(result.results.map((hit) => hit.id)).toEqual(["m1"]);
	expect(result.sourceStates).toEqual([
		expect.objectContaining({ source: "memory", status: "partial", count: 1 }),
	]);
});

it("keeps lexical evidence and other sources when optional diagnostics never settle", async () => {
	const search = createUnifiedSearch({
		sourceTimeoutMs: 10,
		searchTimeoutMs: 200,
		searchRawMessagesLexical: async () => [
			{ id: "m1", content: "review notes", similarity: 0.9, metadata: {} },
		],
		getRawMessageRetrievalStatus: () => new Promise(() => {}),
		searchWorkspace: async () => ({
			status: "complete",
			hits: [{ id: "f1", content: "review file", similarity: 0.9, metadata: {} }],
		}),
	});
	const result = await search.search({ userId: "alice", query: "review", sources: ["memory", "workspace"] });
	expect(result.results.map((hit) => hit.id).sort()).toEqual(["f1", "m1"]);
}, 1000);

it.each([false, true])(
	"reports a failed source when all retrieval channels fail (diagnostic failure: %s)",
	async (diagnosticFailure) => {
		const search = createUnifiedSearch({
			embedQuery: async () => {
				throw new Error("Embedding unavailable");
			},
			searchRawMessagesAnn: async () => [],
			searchRawMessagesLexical: async () => {
				throw new Error("Lexical unavailable");
			},
			getRawMessageRetrievalStatus: diagnosticFailure
				? async () => {
						throw new Error("Status unavailable");
					}
				: undefined,
		});
		const result = await search.search({ userId: "alice", query: "review", sources: ["memory"] });
		expect(result.sourceStates).toEqual([
			expect.objectContaining({ source: "memory", status: "failed", count: 0 }),
		]);
	},
);

it("cancels a pending source and skips queries for already cancelled requests", async () => {
	const controller = new AbortController();
	const search = createUnifiedSearch({
		signal: controller.signal,
		searchWorkspace: () => new Promise(() => {}),
	});
	const pending = search.search({ userId: "alice", query: "资料", sources: ["workspace"] });
	const timer = setTimeout(() => controller.abort(), 5);
	try {
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		clearTimeout(timer);
	}
	let queried = false;
	const cancelled = createUnifiedSearch({
		signal: controller.signal,
		searchWorkspace: async () => {
			queried = true;
			return { status: "complete", hits: [] };
		},
	});
	await expect(
		cancelled.search({ userId: "alice", query: "资料", sources: ["workspace"] }),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(queried).toBe(false);
}, 1000);

it("deduplicates the same file identity and applies the common result limit", async () => {
	const hit = {
		id: "file:1:version:1:chunk:0",
		content: "代码",
		similarity: 0.9,
		metadata: { origin: "personal_memory" },
	};
	const search = createUnifiedSearch({
		searchWorkspace: async () => ({ status: "complete", hits: [hit, hit] }),
	});
	const result = await search.search({ userId: "alice", query: "代码", sources: ["workspace"], limit: 1 });
	expect(result.results).toHaveLength(1);
	expect(result.results[0]?.id).toBe(hit.id);
});

it.each(["rrf", "similarity"] as const)(
	"retains known provenance from duplicate candidates under %s",
	async (mergeStrategy) => {
		const hit = { id: "file:1", content: "代码", similarity: 0.9, metadata: {} };
		const search = createUnifiedSearch({
			searchWorkspace: async () => ({
				status: "complete",
				hits: [
					hit,
					{ ...hit, provenance: { version: 2, contentHash: "hash-v2", derivedFrom: ["source:1"] } },
				],
			}),
		});
		const result = await search.search({
			userId: "alice",
			query: "代码",
			sources: ["workspace"],
			mergeStrategy,
		});
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]?.provenance).toMatchObject({
			version: 2,
			contentHash: "hash-v2",
			derivedFrom: ["source:1"],
		});
	},
);

it("reports not ready when no configured provider can execute within trusted scope", async () => {
	const search = createUnifiedSearch({ searchRawMessagesHybrid: async () => [] });
	const result = await search.search(
		{ userId: "alice", query: "review", sources: ["memory"] },
		{ applicabilityContexts: [{ scope: "global" }] },
	);
	expect(result.sourceStates[0]?.status).toBe("not_ready");
});

it("honors explicit index readiness when retrieval returns no candidates", async () => {
	const result = await createUnifiedSearch({
		searchRawMessagesLexical: async () => [],
		getRawMessageRetrievalStatus: async () => ({
			backend: "sqlite",
			childCount: 0,
			embeddedChildCount: 0,
			indexedDimensions: [],
			semanticReady: false,
			lexicalReady: false,
		}),
	}).search({ userId: "alice", query: "review", sources: ["memory"] });
	expect(result.sourceStates[0]?.status).toBe("not_ready");
});

it("cancels even when a downstream reranker is still pending", async () => {
	const controller = new AbortController();
	let entered: () => void = () => {};
	const reranking = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const search = createUnifiedSearch({
		signal: controller.signal,
		searchWorkspace: async () => ({
			status: "complete",
			hits: [{ id: "f1", content: "资料", similarity: 0.9, metadata: {} }],
		}),
		reranker: {
			rerank: () => {
				entered();
				return new Promise(() => {});
			},
		},
	});
	const pending = search.search({ userId: "alice", query: "资料", sources: ["workspace"] });
	await reranking;
	controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
}, 1000);
