/**
 * Tests for summary tools
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSummaryTools, registerSummaryTools } from "../src/tools-summary.js";
import { makeFakeBackend } from "./_helpers.js";

describe("summary tools", () => {
	describe("makeSummaryTools", () => {
		it("should create 3 summary tools", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			expect(tools).toHaveLength(3);
			expect(tools[0].name).toBe("oc_session_summary");
			expect(tools[1].name).toBe("oc_task_outcome");
			expect(tools[2].name).toBe("oc_recent_summaries");
		});

		it("oc_session_summary should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const summaryTool = tools[0];

			expect(summaryTool.name).toBe("oc_session_summary");
			expect(summaryTool.kind).toBe("read");
			expect(summaryTool.parameters).toHaveProperty("summary");
			expect(summaryTool.parameters).toHaveProperty("tags");
			expect(summaryTool.parameters).toHaveProperty("metadata");
		});

		it("oc_task_outcome should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const outcomeTool = tools[1];

			expect(outcomeTool.name).toBe("oc_task_outcome");
			expect(outcomeTool.kind).toBe("read");
			expect(outcomeTool.parameters).toHaveProperty("outcome");
			expect(outcomeTool.parameters).toHaveProperty("taskName");
			expect(outcomeTool.parameters).toHaveProperty("status");
		});

		it("oc_recent_summaries should have correct structure", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const listTool = tools[2];

			expect(listTool.name).toBe("oc_recent_summaries");
			expect(listTool.kind).toBe("read");
			expect(listTool.parameters).toHaveProperty("limit");
			expect(listTool.parameters).toHaveProperty("sourceTypes");
		});
	});

	describe("registerSummaryTools", () => {
		it("should register tools and return disposer", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const ctx = {
				tools: { register: vi.fn(() => vi.fn()) },
			};

			const disposer = registerSummaryTools(ctx as any, backend, config as any);

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

			const disposer = registerSummaryTools(ctx as any, backend, config as any);
			disposer();

			expect(disposers[0]).toHaveBeenCalled();
			expect(disposers[1]).toHaveBeenCalled();
			expect(disposers[2]).toHaveBeenCalled();
		});
	});

	describe("oc_session_summary execute", () => {
		it("should return error when summary is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const summaryTool = tools[0];

			const result = await summaryTool.execute({}, {});

			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("invalid_arguments");
		});

		it("should call backend.remember with correct params", async () => {
			const remember = vi.fn().mockResolvedValue({ ids: ["test-id"] });
			const backend = makeFakeBackend({ remember });
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const summaryTool = tools[0];

			const result = await summaryTool.execute(
				{ summary: "Test summary", tags: ["tag1"], metadata: { key: "value" } },
				{},
			);

			expect(remember).toHaveBeenCalledWith(
				expect.objectContaining({
					content: "Test summary",
					sourceType: "session-summary",
					metadata: expect.objectContaining({
						tags: ["tag1"],
						key: "value",
					}),
				}),
				expect.anything(),
			);
			expect(result.ok).toBe(true);
		});
	});

	describe("oc_task_outcome execute", () => {
		it("should return error when outcome is missing", async () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const outcomeTool = tools[1];

			const result = await outcomeTool.execute({}, {});

			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("invalid_arguments");
		});

		it("should call backend.remember with task-outcome sourceType", async () => {
			const remember = vi.fn().mockResolvedValue({ ids: ["test-id"] });
			const backend = makeFakeBackend({ remember });
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const outcomeTool = tools[1];

			const result = await outcomeTool.execute(
				{ outcome: "Task completed", taskName: "My Task", status: "completed" },
				{},
			);

			expect(remember).toHaveBeenCalledWith(
				expect.objectContaining({
					content: "Task completed",
					sourceType: "task-outcome",
					metadata: expect.objectContaining({
						taskName: "My Task",
						status: "completed",
					}),
				}),
				expect.anything(),
			);
			expect(result.ok).toBe(true);
		});
	});

	describe("oc_recent_summaries execute", () => {
		it("should call backend.list and filter results", async () => {
			const list = vi.fn().mockResolvedValue([
				{ id: "1", content: "Summary 1", platform: "session-summary", timestamp: 1000 },
				{ id: "2", content: "Outcome 1", platform: "task-outcome", timestamp: 2000 },
				{ id: "3", content: "Other", platform: "other", timestamp: 3000 },
			]);
			const backend = makeFakeBackend({ list });
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const listTool = tools[2];

			const result = await listTool.execute({ limit: 10 }, {});

			expect(result.ok).toBe(true);
			const items = (result.value as any).items;
			expect(items).toHaveLength(2); // Only session-summary and task-outcome
			expect(items[0].sourceType).toBe("session-summary");
			expect(items[1].sourceType).toBe("task-outcome");
		});

		it("should filter by sourceTypes when provided", async () => {
			const list = vi.fn().mockResolvedValue([
				{ id: "1", content: "Summary 1", platform: "session-summary", timestamp: 1000 },
				{ id: "2", content: "Outcome 1", platform: "task-outcome", timestamp: 2000 },
			]);
			const backend = makeFakeBackend({ list });
			const config = { scopeId: "test", timeoutMs: 4000 };
			const tools = makeSummaryTools(backend, config as any);
			const listTool = tools[2];

			const result = await listTool.execute({ sourceTypes: ["session-summary"] }, {});

			expect(result.ok).toBe(true);
			const items = (result.value as any).items;
			expect(items).toHaveLength(1);
			expect(items[0].sourceType).toBe("session-summary");
		});
	});
});
