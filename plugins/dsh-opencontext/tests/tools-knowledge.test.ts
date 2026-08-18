/**
 * Tests for knowledge/RAG tools
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeKnowledgeTools, registerKnowledgeTools } from "../src/tools-knowledge.js";
import { assertToolError, assertToolOk, makeFakeBackend } from "./_helpers.js";

describe("knowledge tools", () => {
	describe("makeKnowledgeTools", () => {
		it("should create 3 knowledge tools", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			expect(tools).toHaveLength(3);
			expect(tools[0]!.name).toBe("oc_knowledge_search");
			expect(tools[1]!.name).toBe("oc_document_upload");
			expect(tools[2]!.name).toBe("oc_document_list");
		});

		it("oc_knowledge_search should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const searchTool = tools[0]!;

			expect(searchTool.name).toBe("oc_knowledge_search");
			expect(searchTool.kind).toBe("search");
			expect(searchTool.parameters).toHaveProperty("query");
			expect(searchTool.parameters).toHaveProperty("documentIds");
			expect(searchTool.parameters).toHaveProperty("limit");
			expect(searchTool.parameters).toHaveProperty("threshold");
		});

		it("oc_document_upload should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const uploadTool = tools[1]!;

			expect(uploadTool.name).toBe("oc_document_upload");
			expect(uploadTool.kind).toBe("read");
			expect(uploadTool.parameters).toHaveProperty("content");
			expect(uploadTool.parameters).toHaveProperty("filename");
			expect(uploadTool.parameters).toHaveProperty("mimeType");
		});

		it("oc_document_list should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const listTool = tools[2]!;

			expect(listTool.name).toBe("oc_document_list");
			expect(listTool.kind).toBe("read");
			expect(listTool.parameters).toHaveProperty("limit");
		});
	});

	describe("registerKnowledgeTools", () => {
		const defineTool = vi.fn((x: unknown) => x);

		it("should register tools and return disposer", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const ctx = {
				tools: { register: vi.fn(() => vi.fn()) },
			};

			const disposer = registerKnowledgeTools(
				ctx as unknown as Parameters<typeof registerKnowledgeTools>[0],
				{ backend, config },
				defineTool,
			);

			expect(ctx.tools.register).toHaveBeenCalledTimes(3);
			expect(typeof disposer).toBe("function");
		});

		it("disposer should clean up all tools", () => {
			const disposers = [vi.fn(), vi.fn(), vi.fn()];
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			let callCount = 0;
			const ctx = {
				tools: {
					register: vi.fn(() => {
						return disposers[callCount++];
					}),
				},
			};

			const disposer = registerKnowledgeTools(
				ctx as unknown as Parameters<typeof registerKnowledgeTools>[0],
				{ backend, config },
				defineTool,
			);
			disposer();

			expect(disposers[0]).toHaveBeenCalled();
			expect(disposers[1]).toHaveBeenCalled();
			expect(disposers[2]).toHaveBeenCalled();
		});
	});

	describe("oc_knowledge_search execute", () => {
		it("should return error when query is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const searchTool = tools[0]!;

			const result = await searchTool.execute({}, {});

			assertToolError(result);
			expect(result.code).toBe("invalid_arguments");
		});

		it("should return fallback when backend does not support knowledge", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const searchTool = tools[0]!;

			const result = await searchTool.execute({ query: "test" }, {});

			assertToolOk(result);
			expect(result.data).toHaveProperty("chunks");
			expect((result.data as unknown as { chunks: unknown[] }).chunks).toEqual([]);
		});
	});

	describe("oc_document_upload execute", () => {
		it("should return error when content is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const uploadTool = tools[1]!;

			const result = await uploadTool.execute({ filename: "test.txt" }, {});

			assertToolError(result);
			expect(result.code).toBe("invalid_arguments");
		});

		it("should return error when filename is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeKnowledgeTools(
				backend,
				config as unknown as Parameters<typeof makeKnowledgeTools>[1],
			);
			const uploadTool = tools[1]!;

			const result = await uploadTool.execute({ content: "test" }, {});

			assertToolError(result);
			expect(result.code).toBe("invalid_arguments");
		});
	});
});
