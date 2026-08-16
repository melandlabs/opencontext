import { createMemoryStore, LocalTransformersEmbeddingProvider } from "@melandlabs/opencontext";
import { cosineSimilarity } from "@melandlabs/opencontext";

const INSIGHTS = [
	{ id: "insight-1", content: "User prefers dark mode in all tools.", metadata: { topic: "preferences" } },
	{
		id: "insight-2",
		content: "User is allergic to peanuts and avoids them strictly.",
		metadata: { topic: "health" },
	},
];

const KNOWLEDGE = [
	{
		documentId: "doc-1",
		documentName: "quickstart.md",
		chunkIndex: 0,
		content: "Install with pnpm add @melandlabs/opencontext and import createMemoryStore.",
	},
	{
		documentId: "doc-2",
		documentName: "architecture.md",
		chunkIndex: 0,
		content: "The temporal context graph stores every fact with valid_from and valid_until.",
	},
];

async function main() {
	const provider = new LocalTransformersEmbeddingProvider({
		modelName: "Xenova/all-MiniLM-L6-v2",
	});

	// Pre-embed the seeded corpora so the in-memory search* functions only do cosine.
	const insightCorpus = await Promise.all(
		INSIGHTS.map(async (i) => ({ ...i, vector: await provider.embedQuery(i.content) })),
	);
	const knowledgeCorpus = await Promise.all(
		KNOWLEDGE.map(async (k) => ({ ...k, vector: await provider.embedQuery(k.content) })),
	);

	const store = await createMemoryStore({
		db: { type: "sqlite-vec", path: "./tutorials-semantic-search-wired.db" },
		unified: {
			embedQuery: async ({ query }) => provider.embedQuery(query),
			searchInsights: async ({ query, limit, threshold }) => {
				const qv = await provider.embedQuery(query);
				return insightCorpus
					.map((i) => ({ hit: i, score: cosineSimilarity(qv, i.vector) }))
					.filter(({ score }) => score >= threshold)
					.sort((a, b) => b.score - a.score)
					.slice(0, limit)
					.map(({ hit, score }) => ({
						source: "insights",
						id: hit.id,
						content: hit.content,
						similarity: score,
						metadata: hit.metadata,
					}));
			},
			searchKnowledge: async ({ query, options }) => {
				const qv = await provider.embedQuery(query);
				return knowledgeCorpus
					.map((k) => ({ hit: k, score: cosineSimilarity(qv, k.vector) }))
					.filter(({ score }) => score >= (options.threshold ?? 0.7))
					.sort((a, b) => b.score - a.score)
					.slice(0, options.limit)
					.map(({ hit, score }) => ({
						source: "knowledge",
						chunkId: `${hit.documentId}#${hit.chunkIndex}`,
						documentId: hit.documentId,
						documentName: hit.documentName,
						content: hit.content,
						similarity: score,
						chunkIndex: hit.chunkIndex,
					}));
			},
		},
	});

	// Store a raw memory as well.
	const messages = await store.raw.getManager();
	const now = Date.now();
	await messages.storeMessages([
		{
			messageId: `msg-${now}`,
			userId: "user-42",
			content: "User prefers dark mode in all applications",
			platform: "tutorial",
			botId: "tutorial-bot",
			timestamp: now,
			createdAt: now,
		},
	]);

	const results = await store.searchUnifiedMemory({
		userId: "user-42",
		query: "What theme does the user like?",
		sources: ["memory", "insights", "knowledge"],
		limit: 5,
		threshold: 0.0,
	});

	console.log("Found", results.count, "results from", results.sources.join(", "));
	console.log("Warnings:", results.warnings.length);
	for (const hit of results.results) {
		console.log(`[${hit.type}] ${hit.content} (${hit.similarity ?? hit.score})`);
	}

	await store.raw.close();
}

main().catch(console.error);
