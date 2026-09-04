import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UnifiedSearchDeps } from "./config";
import { startHttpServer } from "./http";
import { startMcpServer } from "./mcp";

interface McpRegistration {
	config: { inputSchema?: Record<string, unknown> };
	handler: (args: unknown) => Promise<unknown>;
}

const transportHarness = vi.hoisted(() => ({
	httpFetch: undefined as ((request: Request) => Promise<Response>) | undefined,
	mcpTools: new Map<string, McpRegistration>(),
	closeRawStore: vi.fn(async () => undefined),
}));

vi.mock("@hono/node-server", () => ({
	serve: vi.fn((options: { fetch: (request: Request) => Promise<Response> }) => {
		transportHarness.httpFetch = options.fetch;
		return { close: (done: () => void) => done() };
	}),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		tool(): void {}

		registerTool(name: string, config: McpRegistration["config"], handler: McpRegistration["handler"]): void {
			transportHarness.mcpTools.set(name, { config, handler });
		}

		async connect(): Promise<void> {}
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
	StdioServerTransport: class {},
}));

vi.mock("@melandlabs/sqlite", () => ({
	getSQLiteVsaStore: vi.fn(async () => ({})),
	closeSQLiteVsaStore: vi.fn(async () => undefined),
}));

vi.mock("@melandlabs/okf/http", () => ({
	registerOkfRoutes: vi.fn(),
}));

vi.mock("@melandlabs/okf/mcp", () => ({
	registerOkfTools: vi.fn(),
}));

vi.mock("./storage/chroma-memory-index", () => ({
	isRawMessageChromaEnabled: () => false,
	searchRawMessagesWithChroma: vi.fn(async () => []),
	upsertRawMessagesToChroma: vi.fn(async () => undefined),
}));

vi.mock("./storage/raw-message-store", () => ({
	isRawMessageStorageAvailable: () => false,
	createRawMessageStore: vi.fn(() => ({
		getManager: vi.fn(async () => ({})),
		close: transportHarness.closeRawStore,
	})),
}));

vi.mock("./storage/sqlite-raw-message-store", () => ({
	resolveSQLiteRawMessageDbPath: vi.fn(() => "memory-test.db"),
	lexicalSearchRawMessages: vi.fn(async () => []),
}));

beforeEach(() => {
	vi.clearAllMocks();
	transportHarness.httpFetch = undefined;
	transportHarness.mcpTools.clear();
});

function createKnowledgeRecorder(calls: unknown[]): NonNullable<UnifiedSearchDeps["searchKnowledge"]> {
	return async (input) => {
		calls.push(input);
		return [];
	};
}

const hostileApplicabilityPayload = {
	applicabilityContexts: [{ scope: "project", key: "attacker-selected-project" }],
	applicabilityAt: 0,
};

describe("public transport applicability boundary", () => {
	it("ignores applicability fields in an HTTP /v1/search body", async () => {
		const calls: unknown[] = [];
		const server = await startHttpServer({
			port: 0,
			unified: { searchKnowledge: createKnowledgeRecorder(calls) },
		});
		const fetch = transportHarness.httpFetch;
		expect(fetch).toBeTypeOf("function");

		const response = await fetch?.(
			new Request("http://127.0.0.1/v1/search", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "u1",
					query: "project status",
					tiers: ["knowledge"],
					sources: ["knowledge"],
					...hostileApplicabilityPayload,
				}),
			}),
		);

		expect(response?.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toHaveProperty("applicabilityContexts");
		expect(calls[0]).not.toHaveProperty("applicabilityAt");
		await server.stop();
	});

	it("omits applicability from the MCP schema and ignores forged handler arguments", async () => {
		const calls: unknown[] = [];
		await startMcpServer({
			unified: { searchKnowledge: createKnowledgeRecorder(calls) },
		});
		const registration = transportHarness.mcpTools.get("memory.search");

		expect(registration).toBeDefined();
		expect(registration?.config.inputSchema).not.toHaveProperty("applicabilityContexts");
		expect(registration?.config.inputSchema).not.toHaveProperty("applicabilityAt");
		await registration?.handler({
			userId: "u1",
			query: "project status",
			tiers: ["knowledge"],
			sources: ["knowledge"],
			...hostileApplicabilityPayload,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toHaveProperty("applicabilityContexts");
		expect(calls[0]).not.toHaveProperty("applicabilityAt");
	});
});
