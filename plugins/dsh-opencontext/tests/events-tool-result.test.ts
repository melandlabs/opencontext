/**
 * Tests for tool/result event listener
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerToolResultListener } from "../src/events-tool-result.js";
import { makeFakeBackend } from "./_helpers.js";

describe("events-tool-result", () => {
	describe("registerToolResultListener", () => {
		it("should register tool/result listener when captureToolResults is true", () => {
			const backend = makeFakeBackend();
			const config = {
				scopeId: "test",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};
			const listeners: Array<{ event: string }> = [];
			const ctx = {
				on: vi.fn((event: string) => {
					listeners.push({ event });
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			expect(listeners.some((l) => l.event === "tool/result")).toBe(true);
		});

		it("should NOT register tool/result listener when captureToolResults is false", () => {
			const backend = makeFakeBackend();
			const config = {
				scopeId: "test",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: false,
			};
			const listeners: Array<{ event: string }> = [];
			const ctx = {
				on: vi.fn((event: string) => {
					listeners.push({ event });
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			expect(listeners.some((l) => l.event === "tool/result")).toBe(false);
		});

		it("should return a disposer function", () => {
			const backend = makeFakeBackend();
			const config = {
				scopeId: "test",
				timeoutMs: 4000,
				captureToolResults: true,
			};
			const ctx = {
				on: vi.fn(() => vi.fn()),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			const disposer = registerToolResultListener(ctx as any, backend, config as any);

			expect(typeof disposer).toBe("function");
		});
	});

	describe("tool/result handler", () => {
		it("should call next before processing", async () => {
			const captureSource = vi.fn().mockResolvedValue({ id: "test-id" });
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};

			let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
			const nextCalled = vi.fn();
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "tool/result") {
						handler = h as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			const next = vi.fn(async () => {
				nextCalled();
				return { result: "success" };
			});

			const payload = {
				tool: "test_tool",
				arguments: { input: "value" },
				result: { output: "done" },
				session: { header: { id: "session-123" } },
			};

			await handler!(payload, next);

			expect(nextCalled).toHaveBeenCalled();
		});

		it("should capture successful tool result", async () => {
			const captureSource = vi.fn().mockResolvedValue({ id: "test-id" });
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};

			let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "tool/result") {
						handler = h as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			const next = vi.fn(async () => ({ result: "success" }));

			const payload = {
				tool: "test_tool",
				arguments: { input: "value" },
				result: { output: "done" },
				session: { header: { id: "session-123" } },
			};

			await handler!(payload, next);

			expect(captureSource).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceType: "tool-interaction",
					content: expect.stringContaining("Tool: test_tool"),
				}),
				expect.anything(),
			);
		});

		it("should sanitize arguments containing secrets", async () => {
			const captureSource = vi.fn().mockResolvedValue({ id: "test-id" });
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};

			let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "tool/result") {
						handler = h as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			const next = vi.fn(async () => ({ result: "success" }));

			// Use a key that will be sanitized (password) and a value that will also be sanitized
			const payload = {
				tool: "api_call",
				arguments: { password: "sk-1234567890abcdefghijklmn", input: "value" },
				result: { output: "done" },
				session: { header: { id: "session-123" } },
			};

			await handler!(payload, next);

			// Verify capture was called
			expect(captureSource).toHaveBeenCalled();
			const call = captureSource.mock.calls[0];
			expect(call).toBeDefined();
			const content = call![0].content;
			// The password key should be sanitized to [REDACTED]
			expect(content).toContain("[REDACTED]");
			// The secret value should not appear in the captured content
			expect(content).not.toContain("sk-1234567890abcdefghijklmn");
		});

		it("should skip capture if content looks like a secret", async () => {
			const captureSource = vi.fn().mockResolvedValue({ id: "test-id" });
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};

			let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "tool/result") {
						handler = h as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			const next = vi.fn(async () => ({ result: "success" }));

			// Use a valid OpenAI-style secret pattern (sk- followed by 20+ chars)
			const payload = {
				tool: "secret_tool",
				arguments: {},
				result: { output: "sk-1234567890abcdefghijklmn" },
				session: { header: { id: "session-123" } },
			};

			await handler!(payload, next);

			expect(captureSource).not.toHaveBeenCalled();
		});

		it("should capture error results", async () => {
			const captureSource = vi.fn().mockResolvedValue({ id: "test-id" });
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};

			let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "tool/result") {
						handler = h as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			const next = vi.fn(async () => ({ result: "success" }));

			const payload = {
				tool: "failing_tool",
				arguments: {},
				error: { message: "Tool failed", code: "ERR_001" },
				session: { header: { id: "session-123" } },
			};

			await handler!(payload, next);

			const call = captureSource.mock.calls[0];
			expect(call).toBeDefined();
			const content = call![0].content;
			expect(content).toContain("Status: ERROR");
			expect(content).toContain("Tool failed");
		});

		it("should handle capture errors gracefully", async () => {
			const captureSource = vi.fn().mockRejectedValue(new Error("Capture failed"));
			const backend = makeFakeBackend({ captureSource });
			const config = {
				scopeId: "test-scope",
				timeoutMs: 4000,
				requestTimeoutMs: 1000,
				captureToolResults: true,
			};

			let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
			const ctx = {
				on: vi.fn((event: string, h: unknown) => {
					if (event === "tool/result") {
						handler = h as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
					}
					return vi.fn();
				}),
				logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			};

			registerToolResultListener(ctx as any, backend, config as any);

			const next = vi.fn(async () => ({ result: "success" }));

			const payload = {
				tool: "test_tool",
				arguments: {},
				result: { output: "done" },
				session: { header: { id: "session-123" } },
			};

			const result = await handler!(payload, next);

			// Should still return the downstream result
			expect(result).toEqual({ result: "success" });
			expect(ctx.logger.warn).toHaveBeenCalled();
		});
	});
});
