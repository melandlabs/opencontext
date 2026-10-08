import { describe, expect, it, vi } from "vitest";
import {
	applyUnifiedFlag,
	buildUnified,
	parseUnifiedArgs,
	unifiedArgsFromEnv,
	validateUnifiedArgs,
} from "./cli-shared";

describe("memory-store backend CLI", () => {
	it("validates explicit local pooling without changing its default", () => {
		expect(parseUnifiedArgs([]).embeddingPooling).toBeUndefined();
		for (const pooling of ["mean", "cls"] as const) {
			expect(
				parseUnifiedArgs(["--embedding-provider", "local", "--embedding-pooling", pooling]),
			).toMatchObject({ embeddingPooling: pooling });
		}
		expect(() =>
			parseUnifiedArgs(["--embedding-provider", "local", "--embedding-pooling", "invalid"]),
		).toThrow("--embedding-pooling must be one of");
		expect(() => parseUnifiedArgs(["--embedding-pooling", "cls"])).toThrow(
			"requires --embedding-provider local",
		);
		expect(() => parseUnifiedArgs(["--embedding-provider", "local", "--embedding-pooling"])).toThrow(
			"requires a value",
		);
	});

	it("reads retrieval experiment defaults without enabling them implicitly", () => {
		const defaults = unifiedArgsFromEnv({});
		expect(defaults.rrfDenseWeight).toBeUndefined();
		expect(defaults.sessionNeighborSeedK).toBeUndefined();
		const configured = unifiedArgsFromEnv({
			OPENCONTEXT_RRF_DENSE_WEIGHT: "0.7",
			OPENCONTEXT_RRF_LEXICAL_WEIGHT: "0.3",
			OPENCONTEXT_RRF_K: "60",
			OPENCONTEXT_SESSION_NEIGHBOR_SEED_K: "20",
			OPENCONTEXT_SESSION_NEIGHBOR_WINDOW: "1",
			OPENCONTEXT_SESSION_NEIGHBOR_MODE: "union",
			OPENCONTEXT_SESSION_NEIGHBOR_MAX_SLOTS: "4",
		});
		expect(configured).toMatchObject({
			rrfDenseWeight: 0.7,
			rrfLexicalWeight: 0.3,
			rrfK: 60,
			sessionNeighborSeedK: 20,
			sessionNeighborWindow: 1,
			sessionNeighborMode: "union",
			sessionNeighborMaxSlots: 4,
		});
		validateUnifiedArgs(configured);
	});

	it("shares model, chunk and scoring flags with facade server parsers", () => {
		const argv = [
			"--embedding-provider",
			"local",
			"--embedding-model",
			"Xenova/bge-m3",
			"--embedding-pooling",
			"cls",
			"--chunk-max-tokens",
			"1024",
			"--chunk-overlap-tokens",
			"128",
			"--reranker-provider",
			"local",
			"--reranker-candidate-mode",
			"matched-chunks",
		];
		const args = unifiedArgsFromEnv();
		for (let i = 0; i < argv.length; i += 1) {
			expect(applyUnifiedFlag(args, argv[i], () => argv[++i])).toBe(true);
		}
		validateUnifiedArgs(args, "[opencontext/http]");
		expect(args).toEqual(parseUnifiedArgs(argv));
		const takeValue = vi.fn();
		expect(applyUnifiedFlag(args, "--host", takeValue)).toBe(false);
		expect(takeValue).not.toHaveBeenCalled();
		args.embeddingPooling = "invalid" as typeof args.embeddingPooling;
		expect(() => validateUnifiedArgs(args, "[opencontext/http]")).toThrow(
			"[opencontext/http] --embedding-pooling",
		);
	});

	it("wires CLS and reports the actual provider model, cap and output dimensions", async () => {
		const constructed = vi.fn();
		vi.doMock("@melandlabs/ai-rag/local-transformers-embedding-provider", () => ({
			LocalTransformersEmbeddingProvider: class {
				constructor(options: unknown) {
					constructed(options);
				}
				getModelName() {
					return "Xenova/bge-m3";
				}
				getMaxTokens() {
					return 1152;
				}
				async getTokenCounter() {
					return (text: string) => text.length;
				}
				async embedQuery() {
					return Array.from({ length: 1024 }, () => 0);
				}
				async embedDocuments(texts: string[]) {
					return texts.map(() => Array.from({ length: 1024 }, () => 0));
				}
			},
		}));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const args = parseUnifiedArgs([
				"--embedding-provider",
				"local",
				"--embedding-model",
				"Xenova/bge-m3",
				"--embedding-pooling",
				"cls",
				"--chunk-max-tokens",
				"1024",
				"--chunk-overlap-tokens",
				"128",
				"--memory-backend",
				"none",
				"--reranker-provider",
				"none",
				"--insights-backend",
				"none",
				"--knowledge-backend",
				"none",
				"--no-reasoning",
			]);
			const unified = await buildUnified(args);
			expect(constructed).toHaveBeenCalledWith({
				modelName: "Xenova/bge-m3",
				cacheDir: args.embeddingCacheDir,
				pooling: "cls",
			});
			expect(unified.embeddingInfo).toMatchObject({ model: "Xenova/bge-m3", maxTokens: 1152 });
			expect(await unified.getDocumentChunking?.()).toMatchObject({ maxTokens: 1024, overlapTokens: 128 });
			await unified.embedDocuments?.({ userId: "test-user", texts: ["source"] });
			expect(unified.embeddingInfo?.dimensions).toBe(1024);
			await buildUnified({ ...args, embeddingPooling: undefined });
			expect(constructed).toHaveBeenLastCalledWith({
				modelName: "Xenova/bge-m3",
				cacheDir: args.embeddingCacheDir,
				pooling: undefined,
			});
			const inferred = await buildUnified({ ...args, embeddingModel: undefined });
			expect(inferred.embeddingInfo?.model).toBe("Xenova/bge-m3");
			constructed.mockImplementationOnce(() => {
				throw new Error("local initialization failed");
			});
			await expect(
				buildUnified({ ...args, chunkMaxTokens: undefined, chunkOverlapTokens: undefined }),
			).rejects.toThrow("local initialization failed");
		} finally {
			warn.mockRestore();
			vi.doUnmock("@melandlabs/ai-rag/local-transformers-embedding-provider");
			vi.resetModules();
		}
	});

	it("requires a local reranker for explicit matched-chunk scoring", () => {
		expect(
			parseUnifiedArgs(["--reranker-provider", "local", "--reranker-candidate-mode", "matched-chunks"]),
		).toMatchObject({ rerankerCandidateMode: "matched-chunks" });
		expect(() => parseUnifiedArgs(["--reranker-candidate-mode", "matched-chunks"])).toThrow(
			"requires a local reranker",
		);
		expect(() =>
			parseUnifiedArgs(["--reranker-provider", "local", "--reranker-candidate-mode", "invalid"]),
		).toThrow("reranker-candidate-mode");
	});
	it("validates explicit model-tokenizer chunk budgets without changing legacy defaults", () => {
		expect(parseUnifiedArgs([]).chunkMaxTokens).toBeUndefined();
		expect(
			parseUnifiedArgs([
				"--embedding-provider",
				"local",
				"--chunk-max-tokens",
				"384",
				"--chunk-overlap-tokens",
				"64",
			]),
		).toMatchObject({ chunkMaxTokens: 384, chunkOverlapTokens: 64 });
		expect(() => parseUnifiedArgs(["--embedding-provider", "local", "--chunk-max-tokens", "384"])).toThrow(
			"require positive size",
		);
		expect(() =>
			parseUnifiedArgs([
				"--embedding-provider",
				"local",
				"--chunk-max-tokens",
				"384.5",
				"--chunk-overlap-tokens",
				"64",
			]),
		).toThrow("require positive size");
		expect(() =>
			parseUnifiedArgs([
				"--embedding-provider",
				"local",
				"--chunk-max-tokens",
				"64",
				"--chunk-overlap-tokens",
				"64",
			]),
		).toThrow("require positive size");
		expect(() => parseUnifiedArgs(["--chunk-max-tokens", "384", "--chunk-overlap-tokens", "64"])).toThrow(
			"requires --embedding-provider local",
		);
	});
	it("requires an explicit valid semantic-variant merge switch", async () => {
		const keys = ["OPENCONTEXT_LLM_API_KEY", "OPENCONTEXT_LLM_QUERY_REWRITE_SEMANTIC_MERGE"] as const;
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
			Reflect.deleteProperty(process.env, keys[1]);
			expect((await buildUnified(args)).reasoning?.rewriteSemanticMerge).toBeUndefined();
			process.env[keys[1]] = "max-score";
			expect((await buildUnified(args)).reasoning?.rewriteSemanticMerge).toBeUndefined();
			process.env[keys[1]] = "rrf";
			expect((await buildUnified(args)).reasoning?.rewriteSemanticMerge).toBe("rrf");
			process.env[keys[1]] = "invalid";
			await expect(buildUnified(args)).rejects.toThrow("must be max-score or rrf");
		} finally {
			keys.forEach((key, index) => {
				if (saved[index] === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = saved[index];
			});
		}
	});
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
