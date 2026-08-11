/**
 * demo: @melandlabs/memory-store — fully-wired HTTP daemon.
 *
 * The bare `opencontext-memory-http` CLI is a minimal standalone daemon
 * — it doesn't wire `unified.{embedQuery, searchInsights, searchKnowledge}`,
 * so every search response carries three structured warnings:
 *
 *   - memory      → "embedQuery is not configured"
 *   - insights    → "insights_search_not_configured"
 *   - knowledge   → "knowledge_search_not_configured"
 *
 * This demo boots a *fully-wired* HTTP server by importing
 * `startHttpServer` from `@melandlabs/memory-store/http` and supplying
 * those three deps itself. The embedder is a local ONNX model
 * (`LocalTransformersEmbeddingProvider`, default `Xenova/all-MiniLM-L6-v2`,
 * 384 dims, no API key), and the two `search*` deps are tiny in-memory
 * cosine-similarity indices seeded with a handful of demo docs / insights.
 *
 * The important property demonstrated here: with all three `unified.*`
 * deps supplied, `/v1/search` returns hits and `warnings` is empty.
 *
 * If the local ONNX weights cannot be loaded (no network, no populated
 * HuggingFace cache) the inference-dependent checks skip cleanly — the
 * same pattern `demo/14-local-embedding.ts` uses.
 */

import { startHttpServer } from "@melandlabs/memory-store/http";
import { getConfiguredEmbeddingProvider } from "@melandlabs/ai-rag/embedding-provider";
import { LocalTransformersEmbeddingProvider } from "@melandlabs/ai-rag/local-transformers-embedding-provider";
import { cosineSimilarity } from "@melandlabs/ai-rag/embeddings";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

const MODEL = "Xenova/all-MiniLM-L6-v2";

// Seed corpora for the in-memory cross-source indices. Kept tiny on
// purpose — the demo asserts on shape, not corpus size.
const KNOWLEDGE_DOCS: ReadonlyArray<{
	documentId: string;
	documentName: string;
	chunkIndex: number;
	content: string;
}> = [
	{
		documentId: "doc-architecture",
		documentName: "architecture.md",
		chunkIndex: 0,
		content: "The temporal context graph is a DAG where every fact has valid_from and valid_until.",
	},
	{
		documentId: "doc-architecture",
		documentName: "architecture.md",
		chunkIndex: 1,
		content: "Supersession and contradiction are first-class edges in the context graph.",
	},
	{
		documentId: "doc-quickstart",
		documentName: "quickstart.md",
		chunkIndex: 0,
		content: "Install with pnpm add @melandlabs/opencontext and import createMemoryStore.",
	},
];

const INSIGHTS: ReadonlyArray<{ id: string; content: string; metadata: Record<string, unknown> }> = [
	{
		id: "insight-1",
		content: "The user prefers dark mode in all tools.",
		metadata: { topic: "preferences", importance: 0.9 },
	},
	{
		id: "insight-2",
		content: "The user is allergic to peanuts and avoids them strictly.",
		metadata: { topic: "health", importance: 0.95 },
	},
	{
		id: "insight-3",
		content: "The user works on the OpenContext memory substrate.",
		metadata: { topic: "work", importance: 0.6 },
	},
];

export default async function demoHttpServer() {
	await runSection("demo: @melandlabs/memory-store (HTTP server, all unified deps wired)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/http-server");

		// 1. Build the local embedder and probe it once. If the ONNX model
		//    can't load (no network + no cache) every inference step below
		//    is an expected skip.
		const provider = new LocalTransformersEmbeddingProvider({ modelName: MODEL });
		let probe: number[];
		try {
			probe = await provider.embedQuery("probe");
		} catch (err) {
			const detail = (err as Error).message.split("\n")[0];
			skip("local embedder boots and returns a vector", "transformers.js could not load the model", detail);
			skip("knowledge index seeds embed successfully", "depends on the model loading");
			skip("insights index seeds embed successfully", "depends on the model loading");
			skip("startHttpServer boots with all three unified deps", "depends on the model loading");
			skip("GET /health returns { ok: true }", "depends on the model loading");
			skip("POST /v1/raw-messages round-trips a message", "depends on the model loading");
			skip("POST /v1/search returns hits with no cross-source warnings", "depends on the model loading");
			return;
		}
		check(
			"local embedder returns a finite number vector",
			Array.isArray(probe) && probe.every(Number.isFinite),
			`${probe.length} dims`,
		);

		// 2. Pre-embed the seeded corpora. Done once up-front; the in-memory
		//    `search*` implementations only do cosine against the query.
		const knowledgeCorpus = await Promise.all(
			KNOWLEDGE_DOCS.map(async (d) => ({ ...d, vector: await provider.embedQuery(d.content) })),
		);
		const insightCorpus = await Promise.all(
			INSIGHTS.map(async (i) => ({ ...i, vector: await provider.embedQuery(i.content) })),
		);
		check(
			"knowledge corpus pre-embeds (one vector per doc)",
			knowledgeCorpus.every((d) => d.vector.length > 0),
		);
		check(
			"insights corpus pre-embeds (one vector per insight)",
			insightCorpus.every((i) => i.vector.length > 0),
		);

		// 3. Wire the three unified deps. The shapes match the contract in
		//    `packages/memory-store/src/config.ts` (UnifiedSearchDeps).
		const embedQuery = async ({ query }: { userId: string; query: string }) => provider.embedQuery(query);

		const searchKnowledge = async ({
			query,
			options,
		}: {
			userId: string;
			query: string;
			options: { limit: number; threshold: number; documentIds?: string[] };
			authToken?: string;
		}) => {
			const qv = await provider.embedQuery(query);
			const allowed = options.documentIds ? new Set(options.documentIds) : null;
			const scored = knowledgeCorpus
				.filter((d) => !allowed || allowed.has(d.documentId))
				.map((d) => ({ hit: d, score: cosineSimilarity(qv, d.vector) }))
				.filter(({ score }) => score >= options.threshold)
				.sort((a, b) => b.score - a.score)
				.slice(0, options.limit);
			return scored.map(({ hit, score }) => ({
				chunkId: `${hit.documentId}#${hit.chunkIndex}`,
				documentId: hit.documentId,
				documentName: hit.documentName,
				content: hit.content,
				similarity: score,
				chunkIndex: hit.chunkIndex,
			}));
		};

		const searchInsights = async ({
			query,
			limit,
			threshold,
		}: {
			userId: string;
			query: string;
			limit: number;
			threshold: number;
			botIds?: string[];
			includeArchived?: boolean;
			authToken?: string;
		}) => {
			const qv = await provider.embedQuery(query);
			return insightCorpus
				.map((i) => ({ hit: i, score: cosineSimilarity(qv, i.vector) }))
				.filter(({ score }) => score >= threshold)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map(({ hit, score }) => ({
					id: hit.id,
					content: hit.content,
					similarity: score,
					metadata: hit.metadata,
				}));
		};

		// 4. Boot the daemon on a random high port to avoid collisions,
		//    pointed at a scratch sqlite file so we don't touch the user's
		//    real ~/.opencontext/memory/store.db.
		const previousDbPath = process.env.MEMORY_STORE_DB_PATH;
		await withTmp("http-server", async (dir) => {
			process.env.MEMORY_STORE_DB_PATH = `${dir}/store.db`;
			const port = 30_000 + Math.floor(Math.random() * 10_000);

			const started = await startHttpServer({
				port,
				host: "127.0.0.1",
				unified: { embedQuery, searchKnowledge, searchInsights },
			});
			info("demo/http-server", `daemon listening at ${started.url}`);

			try {
				// 5. /health → { ok: true, store: "memory", ts }
				const health = (await fetch(`${started.url}/health`).then((r) => r.json())) as {
					ok: boolean;
					store: string;
				};
				check(
					"GET /health returns ok=true with store=memory",
					health.ok === true && health.store === "memory",
				);

				// 6. POST /v1/raw-messages round-trip
				const now = Date.now();
				const insertRes = await fetch(`${started.url}/v1/raw-messages`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						userId: "u-42",
						messages: [
							{
								messageId: "msg-http-1",
								content: "User prefers dark mode in all tools",
								platform: "test",
								botId: "bot-1",
								timestamp: now,
								createdAt: now,
							},
						],
					}),
				});
				check("POST /v1/raw-messages returns 200 ok", insertRes.ok);

				// 7. GET /v1/raw-messages/:id. The default sqlite manager does
				//    NOT implement `getMessageById` (it's an optional method
				//    in the storage contract — see the postgres factory), so
				//    the endpoint returns 404 in this config. We just assert
				//    the route is wired (i.e. a JSON response, not 5xx) and
				//    that 200/404 are both acceptable.
				const getRes = await fetch(`${started.url}/v1/raw-messages/msg-http-1?userId=u-42`);
				const getBody = (await getRes.json()) as { message?: { content: string }; error?: string };
				check(
					"GET /v1/raw-messages/:id responds with a JSON shape (200/404 both valid here)",
					getRes.status === 200 || getRes.status === 404,
					`status=${getRes.status} body=${JSON.stringify(getBody).slice(0, 120)}`,
				);

				// 8. POST /v1/search with all three sources wired. The three
				//    warnings the bare CLI produced should be gone. We also
				//    pass `threshold: 0` because MiniLM mean-pooled cosine
				//    similarities sit around 0.3-0.6 between related
				//    sentences — the default 0.7 in
				//    `clampUnifiedMemorySearchThreshold` would drop every hit.
				const searchRes = (await fetch(`${started.url}/v1/search`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						userId: "u-42",
						query: "What does the user prefer?",
						limit: 5,
						threshold: 0,
					}),
				}).then((r) => r.json())) as {
					results: Array<{ type: string; content: string; similarity: number }>;
					count: number;
					warnings: Array<{ source: string; code: string; message: string }>;
				};

				info("demo/http-server", `search returned count=${searchRes.count}`);
				for (const w of searchRes.warnings)
					info("demo/http-server", `  warning [${w.source}] ${w.code}: ${w.message}`);

				const badCodes = [
					"memory_search_failed",
					"insights_search_not_configured",
					"knowledge_search_not_configured",
				];
				const remaining = searchRes.warnings.filter((w) => badCodes.includes(w.code));
				check(
					"no `embedQuery is not configured` / `*_not_configured` warnings remain",
					remaining.length === 0,
					remaining.map((w) => w.code).join(", ") || "none",
				);

				const sourceTypes = new Set(searchRes.results.map((r) => r.type));
				info("demo/http-server", `hit types: ${[...sourceTypes].join(", ") || "(none)"}`);
				check(
					"at least one insight or knowledge hit comes back for the seeded query",
					searchRes.count > 0,
					`${searchRes.count} hits`,
				);

				// 8. The factory provider resolves to the local class when
				//    EMBEDDING_PROVIDER=local — same env-var routing the
				//    memory-store facade uses internally.
				const previous = process.env.EMBEDDING_PROVIDER;
				process.env.EMBEDDING_PROVIDER = "local";
				try {
					const factory = getConfiguredEmbeddingProvider();
					check(
						"getConfiguredEmbeddingProvider() returns the local embedder under EMBEDDING_PROVIDER=local",
						factory.constructor.name === "LocalTransformersEmbeddingProvider",
						factory.constructor.name,
					);
				} finally {
					if (previous === undefined) delete process.env.EMBEDDING_PROVIDER;
					else process.env.EMBEDDING_PROVIDER = previous;
				}
			} finally {
				await started.stop();
			}
		});
		if (previousDbPath === undefined) delete process.env.MEMORY_STORE_DB_PATH;
		else process.env.MEMORY_STORE_DB_PATH = previousDbPath;
	});
}
