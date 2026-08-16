/**
 * Tests for turn/end event listener
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTurnEndListener } from "../src/events-turn-end.js";
import { makeFakeBackend } from "./_helpers.js";

describe("events-turn-end", () => {
	describe("registerTurnEndListener", () => {
		it("should register turn/end event listener", () => {
			const backend = makeFakeBackend();
			const config = {
				scopeId: "test",
				timeoutMs: 4000,
				autoSummarize: false,
				captureToolOutcomes: false,
			};
			const listeners: Array<{ event: string }> = [];
			const ctx = {
				on: vi.fn((event: string) => {
					listeners.push({ event });
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerTurnEndListener(ctx as any, backend, config as any);

			expect(listeners.some((l) => l.event === "turn/end")).toBe(true);
		});

		it("should return a disposer function", () => {
			const backend = makeFakeBackend();
			const config = { scopeId: "test", timeoutMs: 4000 };
			const ctx = {
				on: vi.fn(() => vi.fn()),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			const disposer = registerTurnEndListener(ctx as any, backend, config as any);

			expect(typeof disposer).toBe("function");
		});
	});

	describe("turn/end handler", () => {
		it("should generate summary when autoSummarize is true", async () => {
			const remember = vi.fn().mockResolvedValue({ ids: ["test-id"] });
			const backend = makeFakeBackend({ remember });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				autoSummarize: true,
				captureToolOutcomes: false,
			};

			let handler: ((payload: unknown) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "turn/end") {
						handler = h as (payload: unknown) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerTurnEndListener(ctx as any, backend, config as any);

			expect(handler).not.toBeNull();

			const payload = {
				messages: [
					{ role: "user", content: "What is the weather?" },
					{ role: "assistant", content: "The weather is sunny." },
				],
				session: { header: { id: "session-123" } },
				toolsUsed: ["search"],
			};

			const result = await handler!(payload);

			expect(remember).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceType: "turn-summary",
					content: expect.stringContaining("User:"),
				}),
				expect.anything(),
			);
			expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("turn summary captured"));
		});

		it("should not generate summary when autoSummarize is false", async () => {
			const remember = vi.fn().mockResolvedValue({ ids: ["test-id"] });
			const backend = makeFakeBackend({ remember });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				autoSummarize: false,
				captureToolOutcomes: false,
			};

			let handler: ((payload: unknown) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "turn/end") {
						handler = h as (payload: unknown) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerTurnEndListener(ctx as any, backend, config as any);

			const payload = {
				messages: [{ role: "user", content: "Hello" }],
				session: { header: { id: "session-123" } },
			};

			await handler!(payload);

			expect(remember).not.toHaveBeenCalled();
		});

		it("should capture tool outcomes when captureToolOutcomes is true", async () => {
			const captureSource = vi.fn().mockResolvedValue({ id: "test-id" });
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				autoSummarize: false,
				captureToolOutcomes: true,
			};

			let handler: ((payload: unknown) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "turn/end") {
						handler = h as (payload: unknown) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerTurnEndListener(ctx as any, backend, config as any);

			const payload = {
				messages: [
					{ role: "user", content: "Search for X" },
					{ role: "assistant", content: "Found X" },
				],
				session: { header: { id: "session-123" } },
				toolsUsed: ["search"],
			};

			await handler!(payload);

			expect(captureSource).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceType: "tool-outcome",
					content: "Found X",
				}),
				expect.anything(),
			);
		});

		it("should handle errors gracefully", async () => {
			const remember = vi.fn().mockRejectedValue(new Error("Backend error"));
			const backend = makeFakeBackend({ remember });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				autoSummarize: true,
				captureToolOutcomes: false,
			};

			let handler: ((payload: unknown) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "turn/end") {
						handler = h as (payload: unknown) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerTurnEndListener(ctx as any, backend, config as any);

			const payload = {
				messages: [{ role: "user", content: "Hello" }],
				session: { header: { id: "session-123" } },
			};

			const result = await handler!(payload);

			expect(ctx.logger.warn).toHaveBeenCalled();
			expect((result as any).errors).toHaveLength(1);
		});
	});

	describe("generateSimpleSummary", () => {
		it("should extract user and assistant messages", async () => {
			const remember = vi.fn().mockResolvedValue({ ids: ["test-id"] });
			const backend = makeFakeBackend({ remember });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				autoSummarize: true,
				captureToolOutcomes: false,
			};

			let handler: ((payload: unknown) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "turn/end") {
						handler = h as (payload: unknown) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerTurnEndListener(ctx as any, backend, config as any);

			const payload = {
				messages: [
					{ role: "user", content: "What is X?" },
					{ role: "assistant", content: "X is a value" },
				],
				session: { header: { id: "session-123" } },
				toolsUsed: ["search"],
			};

			await handler!(payload);

			const call = remember.mock.calls[0];
			expect(call).toBeDefined();
			const summaryArg = call![0];
			expect(summaryArg.content).toContain("User:");
			expect(summaryArg.content).toContain("Tools used:");
		});
	});
});
