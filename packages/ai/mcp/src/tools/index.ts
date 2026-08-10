import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenContextClient } from "../opencontext/client";
import type { OpenContextAuthToken } from "../opencontext/token";
import { registerConnectorTools } from "./connectors";
import { registerLoopTools } from "./loop";
import { registerMemoryTools } from "./memory";
import { registerStatusTools } from "./status";

export interface OpenContextToolContext {
	client: OpenContextClient;
	authToken: OpenContextAuthToken;
}

export function registerOpenContextTools(server: McpServer, context: OpenContextToolContext): void {
	registerStatusTools(server, context);
	registerMemoryTools(server, context);
	registerConnectorTools(server, context);
	registerLoopTools(server, context);
}
