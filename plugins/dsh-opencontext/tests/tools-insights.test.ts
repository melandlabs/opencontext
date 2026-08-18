/**
 * Tests for insights tools
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeInsightsTools, registerInsightsTools } from "../src/tools-insights.js";
import { assertToolError, assertToolOk, makeFakeBackend } from "./_helpers.js";

describe("insights tools", () => {
	describe("makeInsightsTools", () => {
		it("should create 2 insight tools", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			expect(tools).toHaveLength(2);
			expect(tools[0]!.name).toBe("oc_insights_search");
			expect(tools[1]!.name).toBe("oc_insight_capture");
		});

		it("oc_insights_search should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			const searchTool = tools[0]!;

			expect(searchTool.name).toBe("oc_insights_search");
			expect(searchTool.kind).toBe("search");
			expect(searchTool.parameters).toHaveProperty("query");
			expect(searchTool.parameters).toHaveProperty("categories");
			expect(searchTool.parameters).toHaveProperty("limit");
			expect(typeof searchTool.execute).toBe("function");
		});

		it("oc_insight_capture should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			const captureTool = tools[1]!;

			expect(captureTool.name).toBe("oc_insight_capture");
			expect(captureTool.kind).toBe("read");
			expect(captureTool.parameters).toHaveProperty("content");
			expect(captureTool.parameters).toHaveProperty("category");
			expect(typeof captureTool.execute).toBe("function");
		});
	});

	describe("registerInsightsTools", () => {
		const defineTool = vi.fn((x: unknown) => x);

		it("should register tools and return disposer", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const ctx = {
				tools: { register: vi.fn(() => vi.fn()) },
			};

			const disposer = registerInsightsTools(
				ctx as unknown as Parameters<typeof registerInsightsTools>[0],
				{ backend, config },
				defineTool,
			);

			expect(ctx.tools.register).toHaveBeenCalledTimes(2);
			expect(typeof disposer).toBe("function");
		});

		it("disposer should clean up all tools", () => {
			const disposers = [vi.fn(), vi.fn()];
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

			const disposer = registerInsightsTools(
				ctx as unknown as Parameters<typeof registerInsightsTools>[0],
				{ backend, config },
				defineTool,
			);
			disposer();

			expect(disposers[0]).toHaveBeenCalled();
			expect(disposers[1]).toHaveBeenCalled();
		});
	});

	describe("oc_insights_search execute", () => {
		it("should return error when query is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			const searchTool = tools[0]!;

			const result = await searchTool.execute({}, {});

			assertToolError(result);
			expect(result.code).toBe("invalid_arguments");
		});

		it("should return fallback when backend does not support insights", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			const searchTool = tools[0]!;

			const result = await searchTool.execute({ query: "test" }, {});

			assertToolOk(result);
			expect(result.data).toHaveProperty("insights");
			expect((result.data as unknown as { insights: unknown[] }).insights).toEqual([]);
		});
	});

	describe("oc_insight_capture execute", () => {
		it("should return error when content is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			const captureTool = tools[1]!;

			const result = await captureTool.execute({}, {});

			assertToolError(result);
			expect(result.code).toBe("invalid_arguments");
		});

		it("should validate insight categories", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeInsightsTools(backend, config as unknown as Parameters<typeof makeInsightsTools>[1]);
			const captureTool = tools[1]!;

			const result = await captureTool.execute({ content: "test", category: "invalid" }, {});

			assertToolError(result);
			expect(result.code).toBe("invalid_arguments");
			expect(result.message).toContain("category must be one of");
		});
	});
});
