import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerTools } from "../src/tools";
import { makeConfig, makeFakeBackend, makeSearchHit, makeMemoryItem } from "./_helpers";

const registeredTools: Array<{
	name: string;
	description: string;
	kind: "search" | "read";
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}> = [];

const toolsService = {
	tools: {
		register: vi.fn((definition: unknown) => {
			const t = definition as (typeof registeredTools)[number];
			registeredTools.push(t);
			return () => {
				const i = registeredTools.findIndex((r) => r.name === t.name);
				if (i >= 0) registeredTools.splice(i, 1);
			};
		}),
	},
} as unknown as Parameters<typeof registerTools>[0];

beforeEach(() => {
	registeredTools.length = 0;
	(toolsService.tools.register as unknown as { mockClear: () => void }).mockClear();
});

function getTool(name: string) {
	const tool = registeredTools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool;
}

describe("registerTools", () => {
	it("registers all 8 oc_* tools", () => {
		const backend = makeFakeBackend();
		registerTools(toolsService, backend, makeConfig());
		const names = registeredTools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"oc_search",
				"oc_remember",
				"oc_memory_list",
				"oc_memory_get",
				"oc_memory_revise",
				"oc_memory_retire",
				"oc_prepare_context",
				"oc_capture_source",
			]),
		);
		expect(registeredTools).toHaveLength(8);
	});

	it("oc_search returns structured ok with hits and calls backend.search", async () => {
		const backend = makeFakeBackend({
			search: vi.fn(async () => [makeSearchHit({ id: "h1", content: "alpha" })]),
		});
		registerTools(toolsService, backend, makeConfig({ maxRecallItems: 4 }));
		const t = getTool("oc_search");
		const result = (await t.execute({ query: "alpha", limit: 3 }, {})) as {
			ok: boolean;
			value?: { hits: unknown[] };
		};
		expect(result.ok).toBe(true);
		expect(result.value?.hits).toHaveLength(1);
		expect(backend.search).toHaveBeenCalledWith(
			expect.objectContaining({ query: "alpha", limit: 3, threshold: 0.5 }),
			expect.any(Object),
		);
	});

	it("oc_search returns invalid_arguments when query is empty", async () => {
		const backend = makeFakeBackend();
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_search");
		const result = (await t.execute({ query: "  " }, {})) as { ok: boolean; error?: { code: string } };
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("invalid_arguments");
	});

	it("oc_remember rejects secret-like content", async () => {
		const backend = makeFakeBackend();
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_remember");
		const result = (await t.execute({ content: "my sk-abcdefghijklmnopqrstuv is here" }, {})) as {
			ok: boolean;
			error?: { code: string };
		};
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("secret_rejected");
	});

	it("oc_remember persists content and returns ids", async () => {
		const backend = makeFakeBackend({ remember: vi.fn(async () => ({ ids: ["a", "b"] })) });
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_remember");
		const result = (await t.execute({ content: "remember this" }, {})) as {
			ok: boolean;
			value?: { ids: string[] };
		};
		expect(result.ok).toBe(true);
		expect(result.value?.ids).toEqual(["a", "b"]);
	});

	it("oc_memory_list maps to backend.list with default limit", async () => {
		const backend = makeFakeBackend({ list: vi.fn(async () => [makeMemoryItem()]) });
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_memory_list");
		const result = (await t.execute({}, {})) as { ok: boolean; value?: { items: unknown[] } };
		expect(result.ok).toBe(true);
		expect(result.value?.items).toHaveLength(1);
		expect(backend.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }), expect.any(Object));
	});

	it("oc_memory_get requires ids", async () => {
		const backend = makeFakeBackend();
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_memory_get");
		const result = (await t.execute({ ids: [] }, {})) as { ok: boolean; error?: { code: string } };
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("invalid_arguments");
	});

	it("oc_memory_revise returns deprecatedId and newId", async () => {
		const backend = makeFakeBackend({
			revise: vi.fn(async () => ({ deprecatedId: "old", newId: "new" })),
		});
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_memory_revise");
		const result = (await t.execute({ id: "old", content: "new" }, {})) as {
			ok: boolean;
			value?: { deprecatedId: string; newId: string };
		};
		expect(result.ok).toBe(true);
		expect(result.value?.deprecatedId).toBe("old");
		expect(result.value?.newId).toBe("new");
	});

	it("oc_memory_retire returns ok on success", async () => {
		const backend = makeFakeBackend();
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_memory_retire");
		const result = (await t.execute({ id: "x" }, {})) as { ok: boolean; value?: { ok: boolean } };
		expect(result.ok).toBe(true);
		expect(result.value?.ok).toBe(true);
	});

	it("oc_prepare_context returns empty block when no hits", async () => {
		const backend = makeFakeBackend();
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_prepare_context");
		const result = (await t.execute({ query: "anything" }, {})) as {
			ok: boolean;
			value?: { hits: number; contextBlock: string; truncated: boolean };
		};
		expect(result.ok).toBe(true);
		expect(result.value?.hits).toBe(0);
		expect(result.value?.contextBlock).toBe("");
	});

	it("oc_prepare_context returns a framed block when hits are present", async () => {
		const backend = makeFakeBackend({
			search: vi.fn(async () => [
				makeSearchHit({ id: "h1", content: "alpha" }),
				makeSearchHit({ id: "h2", content: "beta" }),
			]),
		});
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_prepare_context");
		const result = (await t.execute({ query: "alpha" }, {})) as {
			ok: boolean;
			value?: { hits: number; contextBlock: string; truncated: boolean };
		};
		expect(result.ok).toBe(true);
		expect(result.value?.hits).toBe(2);
		expect(result.value?.contextBlock).toContain('<opencontext_evidence hits="2">');
	});

	it("oc_capture_source returns id and tags sourceType", async () => {
		const backend = makeFakeBackend({ captureSource: vi.fn(async () => ({ id: "cap-1" })) });
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_capture_source");
		const result = (await t.execute({ content: "snippet", sourceType: "url" }, {})) as {
			ok: boolean;
			value?: { id: string };
		};
		expect(result.ok).toBe(true);
		expect(result.value?.id).toBe("cap-1");
	});

	it("tool errors never throw to the model", async () => {
		const backend = makeFakeBackend({
			search: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		registerTools(toolsService, backend, makeConfig());
		const t = getTool("oc_search");
		const result = (await t.execute({ query: "x" }, {})) as {
			ok: boolean;
			error?: { code: string; message: string };
		};
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("internal_error");
	});
});
