import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
	type OpenContextReadiness,
	checkOpenContextReadiness,
	formatOpenContextReadiness,
} from "../opencontext/readiness";
import type { OpenContextToolContext } from "./index";

function toStructuredContent(readiness: OpenContextReadiness): Record<string, unknown> {
	return { ...readiness };
}

export function registerStatusTools(server: McpServer, context: OpenContextToolContext): void {
	server.registerTool(
		"opencontext_status",
		{
			title: "OpenContext Status",
			description: "Check whether the local OpenContext Desktop API and MCP token authentication are ready.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async () => {
			const readiness = await checkOpenContextReadiness({
				authToken: context.authToken,
				preferredBaseUrl: context.client.baseUrl,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: formatOpenContextReadiness(readiness),
					},
				],
				structuredContent: toStructuredContent(readiness),
			};
		},
	);

	server.registerTool(
		"opencontext_setup",
		{
			title: "OpenContext Setup",
			description:
				"Run first-use OpenContext MCP setup checks and return the exact next step when Desktop, API, token, or auth is not ready.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async () => {
			const readiness = await checkOpenContextReadiness({
				authToken: context.authToken,
				preferredBaseUrl: context.client.baseUrl,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: formatOpenContextReadiness(readiness),
					},
				],
				structuredContent: toStructuredContent(readiness),
			};
		},
	);
}
