import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the backends before importing the entry.
vi.mock("../src/backend.js", async () => {
	const actual = await vi.importActual<typeof import("../src/backend.js")>("../src/backend.js");
	return {
		...actual,
		createBackend: vi.fn(),
	};
});

import { createBackend } from "../src/backend.js";
import { ConfigSchema, apply, inject, name } from "../src/index.js";
import { makeConfig, makeFakeBackend } from "./_helpers.js";

const mockCreateBackend = vi.mocked(createBackend);

beforeEach(() => {
	mockCreateBackend.mockReset();
});

describe("plugin entry", () => {
	it("exports the expected name, inject list, and schema", () => {
		expect(name).toBe("dsh-opencontext");
		expect(inject).toEqual(
			expect.arrayContaining([
				"tools",
				"agents",
				"agentDefaultModel",
				"systemPrompt",
				"commands",
				"llm",
				"sessions",
			]),
		);
		expect(ConfigSchema).toBeDefined();
	});

	it("apply() registers tools, listeners, skill, and command", async () => {
		const backend = makeFakeBackend();
		mockCreateBackend.mockReturnValue(backend);
		const _registered: string[] = [];
		const listeners: Array<{ event: string }> = [];
		const ctx = {
			tools: { register: vi.fn((_t: unknown) => () => undefined) },
			on: vi.fn((event: string) => {
				listeners.push({ event });
				return () => undefined;
			}),
			get: vi.fn((name: string) => {
				if (name === "skill") return { register: vi.fn() };
				if (name === "commands") return { register: vi.fn() };
				return undefined;
			}),
			logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
			effect: vi.fn((setup: () => () => void) => {
				setup();
				return () => undefined;
			}),
		};
		await apply(ctx as unknown as Parameters<typeof apply>[0], makeConfig());
		// 16 tools registered: 8 core + 2 insights + 3 knowledge + 3 summary
		expect(ctx.tools.register).toHaveBeenCalledTimes(16);
		// Two agent/pre-step listeners (recall + capture)
		expect(listeners.filter((l) => l.event === "agent/pre-step")).toHaveLength(2);
		// turn/end listener (always registered)
		expect(listeners.filter((l) => l.event === "turn/end")).toHaveLength(1);
		// tool/result listener is NOT registered by default (captureToolResults=false)
		expect(listeners.filter((l) => l.event === "tool/result")).toHaveLength(0);
		// Skill + command each looked up
		expect(ctx.get).toHaveBeenCalledWith("skill");
		expect(ctx.get).toHaveBeenCalledWith("commands");
	});

	it("apply() invokes dispose on the backend when the effect tears down", async () => {
		const dispose = vi.fn(async () => undefined);
		const backend = makeFakeBackend({ dispose });
		mockCreateBackend.mockReturnValue(backend);
		let cleanupFn: (() => unknown) | undefined;
		const ctx = {
			tools: { register: vi.fn(() => () => undefined) },
			on: vi.fn(() => () => undefined),
			get: vi.fn(() => undefined),
			logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
			effect: vi.fn((setup: () => () => void) => {
				cleanupFn = setup();
				return cleanupFn;
			}),
		};
		await apply(ctx as unknown as Parameters<typeof apply>[0], makeConfig());
		if (cleanupFn) {
			await cleanupFn();
		}
		expect(dispose).toHaveBeenCalled();
	});
});
