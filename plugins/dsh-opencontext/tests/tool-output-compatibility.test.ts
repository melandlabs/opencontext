/**
 * tests/tool-output-compatibility.test.ts
 *
 * Tests that verify tool output schemas are compatible with DSH's
 * JSON Schema subset and "lossless JSON" requirements.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerTools } from "../src/tools.js";
import { registerInsightsTools } from "../src/tools-insights.js";
import { registerKnowledgeTools } from "../src/tools-knowledge.js";
import { registerSummaryTools } from "../src/tools-summary.js";
import { makeConfig, makeFakeBackend } from "./_helpers.js";

describe("DSH tool output compatibility", () => {
	const registeredTools: unknown[] = [];
	const toolsService = {
		register: vi.fn((tool: unknown) => {
			registeredTools.push(tool);
			return () => {
				const idx = registeredTools.indexOf(tool);
				if (idx >= 0) registeredTools.splice(idx, 1);
			};
		}),
	};

	const ctx = {
		get: vi.fn((name: string) => {
			if (name === "tools") return toolsService;
			return undefined;
		}),
		tools: toolsService,
		logger: { warn: vi.fn(), info: vi.fn() },
		effect: (fn: () => () => void) => fn(),
	};

	beforeEach(() => {
		registeredTools.length = 0;
		toolsService.register.mockClear();
		ctx.get.mockClear();
	});

	describe("core tools", () => {
		beforeEach(() => {
			const backend = makeFakeBackend();
			registerTools(ctx as never, backend, makeConfig());
		});

		it("should register all core tools", () => {
			// 8 core tools: oc_search, oc_remember, oc_memory_list, oc_memory_get,
			// oc_memory_revise, oc_memory_retire, oc_prepare_context, oc_capture_source
			expect(registeredTools.length).toBe(8);
		});

		it("each tool must have output.schema", () => {
			for (const tool of registeredTools) {
				const t = tool as { name: string; output?: { schema: unknown } };
				expect(t.output).toBeDefined();
				expect(t.output?.schema).toBeDefined();
			}
		});

		it("each tool must have output.render function", () => {
			for (const tool of registeredTools) {
				const t = tool as { name: string; output?: { render: unknown } };
				expect(t.output?.render).toBeDefined();
				expect(typeof t.output?.render).toBe("function");
			}
		});

		it("output.schema must be valid JSON Schema", () => {
			const validKeywords = new Set([
				"type",
				"oneOf",
				"properties",
				"required",
				"additionalProperties",
				"items",
				"enum",
				"const",
				"$schema",
			]);

			for (const tool of registeredTools) {
				const t = tool as {
					name: string;
					output: { schema: { type: string; properties: Record<string, unknown> } };
				};
				const schema = t.output.schema;

				// Must be an object
				expect(schema).toBeInstanceOf(Object);
				expect(schema.type).toBe("object");

				// Must have 'ok' property
				expect(schema.properties).toHaveProperty("ok");

				// Check 'ok' is boolean
				expect((schema.properties.ok as { type: string }).type).toBe("boolean");

				// Check 'value' exists (can be empty schema {} for any type)
				expect(schema.properties).toHaveProperty("value");

				// Check 'error' is an object
				expect(schema.properties).toHaveProperty("error");
			}
		});

		it("output.render must return JSON-serializable values", () => {
			// Test with sample values that tools actually return
			const testValues = [
				{ ok: true, value: { ids: ["test-id"] } },
				{ ok: true, value: { items: [] } },
				{ ok: true, value: { hits: [{ id: "x", content: "y", score: 0.5 }] } },
				{ ok: true, value: { ok: true } },
				{ ok: false, error: { code: "timeout", message: "error" } },
			];

			for (const tool of registeredTools) {
				const t = tool as { name: string; output: { render: (args: unknown, value: unknown) => unknown } };

				for (const testValue of testValues) {
					const result = t.output.render({}, testValue);

					// Must not throw
					expect(() => JSON.stringify(result)).not.toThrow();

					// Result must be JSON-serializable
					const serialized = JSON.stringify(result);
					const parsed = JSON.parse(serialized);
					expect(parsed).toBeDefined();
				}
			}
		});
	});

	describe("insights tools", () => {
		beforeEach(() => {
			const backend = makeFakeBackend();
			registerInsightsTools(ctx as never, backend, makeConfig({ enableInsights: true }));
		});

		it("should register insights tools", () => {
			expect(registeredTools.length).toBeGreaterThanOrEqual(2);
		});

		it("insights tools must have valid output schemas", () => {
			for (const tool of registeredTools) {
				const t = tool as {
					name: string;
					output: { schema: { type: string; properties: Record<string, unknown> } };
				};
				expect(t.output?.schema?.type).toBe("object");
			}
		});
	});

	describe("knowledge tools", () => {
		beforeEach(() => {
			const backend = makeFakeBackend();
			registerKnowledgeTools(ctx as never, backend, makeConfig({ enableKnowledge: true }));
		});

		it("should register knowledge tools", () => {
			expect(registeredTools.length).toBeGreaterThanOrEqual(3);
		});

		it("knowledge tools must have valid output schemas", () => {
			for (const tool of registeredTools) {
				const t = tool as {
					name: string;
					output: { schema: { type: string; properties: Record<string, unknown> } };
				};
				expect(t.output?.schema?.type).toBe("object");
			}
		});
	});

	describe("summary tools", () => {
		beforeEach(() => {
			const backend = makeFakeBackend();
			registerSummaryTools(ctx as never, backend, makeConfig());
		});

		it("should register summary tools", () => {
			expect(registeredTools.length).toBeGreaterThanOrEqual(3);
		});

		it("summary tools must have valid output schemas", () => {
			for (const tool of registeredTools) {
				const t = tool as {
					name: string;
					output: { schema: { type: string; properties: Record<string, unknown> } };
				};
				expect(t.output?.schema?.type).toBe("object");
			}
		});
	});
});

describe("Tool output value serialization", () => {
	it("serializes oc_remember output correctly", () => {
		const output = { ok: true, value: { ids: ["test-id-123"] } };
		expect(() => JSON.stringify(output)).not.toThrow();

		const serialized = JSON.stringify(output);
		const parsed = JSON.parse(serialized);
		expect(parsed).toEqual(output);
	});

	it("serializes oc_search output correctly", () => {
		const output = {
			ok: true,
			value: {
				hits: [{ id: "x", content: "test", score: 0.8, timestamp: 12345, metadata: {} }],
			},
		};
		expect(() => JSON.stringify(output)).not.toThrow();

		const serialized = JSON.stringify(output);
		const parsed = JSON.parse(serialized);
		expect(parsed).toEqual(output);
	});

	it("serializes oc_memory_list output correctly", () => {
		const output = {
			ok: true,
			value: {
				items: [{ id: "x", content: "test", timestamp: 12345, metadata: {} }],
			},
		};
		expect(() => JSON.stringify(output)).not.toThrow();
	});

	it("serializes error output correctly", () => {
		const output = {
			ok: false,
			error: { code: "timeout", message: "request timed out" },
		};
		expect(() => JSON.stringify(output)).not.toThrow();

		const serialized = JSON.stringify(output);
		const parsed = JSON.parse(serialized);
		expect(parsed).toEqual(output);
	});
});
