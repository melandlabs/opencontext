import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { OpenContextClient, type OpenContextClientOptions } from "./opencontext/client";
import { type OpenContextAuthToken, readOpenContextAuthToken } from "./opencontext/token";
import { registerOpenContextTools } from "./tools";

const DEFAULT_SERVER_NAME = "@melandlabs/mcp";
const DEFAULT_SERVER_VERSION = "0.1.0";

export interface CreateOpenContextMcpServerOptions extends OpenContextClientOptions {
	name?: string;
	version?: string;
}

export async function createOpenContextMcpServer(
	options: CreateOpenContextMcpServerOptions = {},
): Promise<McpServer> {
	const tokenResult = options.token
		? ({ token: options.token, source: "env" } satisfies OpenContextAuthToken)
		: await readOpenContextAuthToken();
	const client = new OpenContextClient({
		...options,
		token: tokenResult.token ?? undefined,
	});
	const server = new McpServer({
		name: options.name ?? DEFAULT_SERVER_NAME,
		version: options.version ?? DEFAULT_SERVER_VERSION,
	});

	registerOpenContextTools(server, { client, authToken: tokenResult });

	return server;
}

export async function runOpenContextMcpStdioServer(
	options: CreateOpenContextMcpServerOptions = {},
): Promise<McpServer> {
	const server = await createOpenContextMcpServer(options);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	return server;
}
