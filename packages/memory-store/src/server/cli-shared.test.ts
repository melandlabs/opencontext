import { describe, expect, it, vi } from "vitest";
import { buildUnified, parseUnifiedArgs } from "./cli-shared";

describe("memory-store backend CLI", () => {
	it("enables lexical rewriting only with its explicit switch", async () => {
		const keys = ["OPENCONTEXT_LLM_API_KEY", "OPENCONTEXT_LLM_QUERY_REWRITE_LEXICAL"] as const;
		const saved = keys.map((key) => process.env[key]);
		process.env.OPENCONTEXT_LLM_API_KEY = "test-key";
		const args = parseUnifiedArgs([
			"--embedding-provider",
			"none",
			"--memory-backend",
			"none",
			"--reranker-provider",
			"none",
			"--reasoning",
		]);
		try {
			process.env.OPENCONTEXT_LLM_QUERY_REWRITE_LEXICAL = "0";
			expect((await buildUnified(args)).reasoning?.rewriteLexical).toBeUndefined();
			process.env.OPENCONTEXT_LLM_QUERY_REWRITE_LEXICAL = "1";
			expect((await buildUnified(args)).reasoning?.rewriteLexical).toBe(true);
		} finally {
			keys.forEach((key, index) => {
				if (saved[index] === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = saved[index];
			});
		}
	});
	it("only wires evidence selection when explicitly enabled", async () => {
		const keys = ["OPENCONTEXT_LLM_API_KEY", "OPENCONTEXT_LLM_EVIDENCE_SELECTION"] as const;
		const saved = keys.map((key) => process.env[key]);
		process.env.OPENCONTEXT_LLM_API_KEY = "test-key";
		const args = parseUnifiedArgs([
			"--embedding-provider",
			"none",
			"--memory-backend",
			"none",
			"--reranker-provider",
			"none",
			"--reasoning",
		]);
		try {
			process.env.OPENCONTEXT_LLM_EVIDENCE_SELECTION = "0";
			expect((await buildUnified(args)).reasoning?.evidenceSelector).toBeUndefined();
			process.env.OPENCONTEXT_LLM_EVIDENCE_SELECTION = "1";
			expect((await buildUnified(args)).reasoning?.evidenceSelector).toBeDefined();
		} finally {
			keys.forEach((key, index) => {
				if (saved[index] === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = saved[index];
			});
		}
	});
	it("forwards an explicit no-thinking setting to the retrieval model", async () => {
		const oldKey = process.env.OPENCONTEXT_LLM_API_KEY;
		const oldEffort = process.env.OPENCONTEXT_LLM_REASONING_EFFORT;
		process.env.OPENCONTEXT_LLM_API_KEY = "test-key";
		process.env.OPENCONTEXT_LLM_REASONING_EFFORT = "none";
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "- Did I mention my favorite color?" } }] }),
		}));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const unified = await buildUnified(
				parseUnifiedArgs([
					"--embedding-provider",
					"none",
					"--memory-backend",
					"none",
					"--reranker-provider",
					"none",
					"--reasoning",
				]),
			);
			const variants = await unified.reasoning?.queryRewriter?.rewrite({
				query: "What is the user's favorite color?",
				userId: "u1",
			});
			expect(variants).toHaveLength(2);
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(request.reasoning).toEqual({ effort: "none" });
		} finally {
			vi.unstubAllGlobals();
			if (oldKey === undefined) Reflect.deleteProperty(process.env, "OPENCONTEXT_LLM_API_KEY");
			else process.env.OPENCONTEXT_LLM_API_KEY = oldKey;
			if (oldEffort === undefined) Reflect.deleteProperty(process.env, "OPENCONTEXT_LLM_REASONING_EFFORT");
			else process.env.OPENCONTEXT_LLM_REASONING_EFFORT = oldEffort;
		}
	});
	it("pins and verifies the OpenRouter provider for retrieval reasoning", async () => {
		const oldKey = process.env.OPENCONTEXT_LLM_API_KEY;
		const oldBase = process.env.OPENCONTEXT_LLM_BASE_URL;
		const oldProvider = process.env.OPENCONTEXT_LLM_PROVIDER;
		process.env.OPENCONTEXT_LLM_API_KEY = "test-key";
		process.env.OPENCONTEXT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.OPENCONTEXT_LLM_PROVIDER = "OpenInference";
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
			ok: true,
			json: async () => ({
				provider: "OpenInference",
				choices: [{ message: { content: "- What color did the user mention?" } }],
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const unified = await buildUnified(
				parseUnifiedArgs([
					"--embedding-provider",
					"none",
					"--memory-backend",
					"none",
					"--reranker-provider",
					"none",
					"--reasoning",
				]),
			);
			await unified.reasoning?.queryRewriter?.rewrite({
				query: "What is the user's favorite color?",
				userId: "u1",
			});
			const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(request.provider).toEqual({ order: ["OpenInference"], allow_fallbacks: false });
			fetchMock.mockImplementation(async () => ({
				ok: true,
				json: async () => ({
					provider: "OpenInference",
					choices: [{ message: { content: "Action: finish\nAction Input: {}" } }],
				}),
			}));
			await unified.reasoning?.iterativePlanner?.plan({
				query: "What is the user's favorite color?",
				executor: { search: async () => ({ candidates: [] }) },
				options: { fallbackToBaseline: false },
			});
			const plannerRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
			expect(plannerRequest.messages.map((message: { role: string }) => message.role)).toEqual([
				"system",
				"user",
			]);
			expect(plannerRequest.provider).toEqual({ order: ["OpenInference"], allow_fallbacks: false });
			fetchMock.mockImplementation(async () => ({
				ok: true,
				json: async () => ({ provider: "other", choices: [{ message: { content: "rewritten" } }] }),
			}));
			await expect(
				unified.reasoning?.queryRewriter?.rewrite({ query: "What is the user's age?", userId: "u1" }),
			).resolves.toEqual(["What is the user's age?"]);
			expect(unified.reasoning?.queryRewriter?.lastDegraded?.()).toBe(true);
		} finally {
			vi.unstubAllGlobals();
			if (oldKey === undefined) Reflect.deleteProperty(process.env, "OPENCONTEXT_LLM_API_KEY");
			else process.env.OPENCONTEXT_LLM_API_KEY = oldKey;
			if (oldBase === undefined) Reflect.deleteProperty(process.env, "OPENCONTEXT_LLM_BASE_URL");
			else process.env.OPENCONTEXT_LLM_BASE_URL = oldBase;
			if (oldProvider === undefined) Reflect.deleteProperty(process.env, "OPENCONTEXT_LLM_PROVIDER");
			else process.env.OPENCONTEXT_LLM_PROVIDER = oldProvider;
		}
	});
	it("parses the local reranker configuration", () => {
		const args = parseUnifiedArgs([
			"--reranker-provider",
			"local",
			"--reranker-model",
			"Xenova/ms-marco-MiniLM-L-6-v2",
			"--reranker-cache-dir",
			"C:/models/reranker",
			"--reranker-batch-size",
			"4",
			"--reranker-max-tokens",
			"384",
		]);

		expect(args).toMatchObject({
			rerankerProvider: "local",
			rerankerModel: "Xenova/ms-marco-MiniLM-L-6-v2",
			rerankerCacheDir: "C:/models/reranker",
			rerankerBatchSize: 4,
			rerankerMaxTokens: 384,
		});
	});

	it("parses the four supported raw-message backends and their connection settings", () => {
		const args = parseUnifiedArgs([
			"--embedding-provider",
			"none",
			"--memory-backend",
			"milvus",
			"--milvus-address",
			"http://milvus.test:19530",
			"--milvus-token",
			"secret-placeholder",
			"--milvus-database",
			"memory",
			"--milvus-collection",
			"raw_children",
			"--milvus-dimension",
			"384",
			"--insights-backend",
			"none",
			"--knowledge-backend",
			"none",
		]);

		expect(args).toMatchObject({
			memoryBackend: "milvus",
			milvusAddress: "http://milvus.test:19530",
			milvusToken: "secret-placeholder",
			milvusDatabase: "memory",
			milvusCollection: "raw_children",
			milvusDimension: 384,
		});
	});

	it.each([
		["chroma", "--memory-backend=chroma requires --chroma-url"],
		["lancedb", "--memory-backend=lancedb requires --lancedb-uri"],
		["milvus", "--memory-backend=milvus requires --milvus-address"],
	] as const)("fails %s configuration before opening a backend", async (backend, message) => {
		await expect(
			buildUnified({
				embeddingProvider: "none",
				rerankerProvider: "none",
				memoryBackend: backend,
				insightsBackend: "none",
				insightsCollection: "insights",
				knowledgeBackend: "none",
				knowledgeCollection: "knowledge",
				reasoning: false,
			}),
		).rejects.toThrow(message);
	});
});
