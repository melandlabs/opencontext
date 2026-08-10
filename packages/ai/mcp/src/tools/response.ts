import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { OpenContextApiError, OpenContextClient } from "../opencontext/client";
import { checkOpenContextReadiness, formatOpenContextReadiness } from "../opencontext/readiness";
import type { OpenContextToolContext } from "./index";

const MAX_TEXT_RESULT_LENGTH = 12000;

export type OpenContextToolResult = CallToolResult;

function toStructuredContent(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return { data: value };
}

function stringifyForText(value: unknown): string {
	const text = JSON.stringify(value, null, 2) ?? String(value);
	if (text.length <= MAX_TEXT_RESULT_LENGTH) {
		return text;
	}

	return `${text.slice(0, MAX_TEXT_RESULT_LENGTH)}\n...truncated`;
}

export function jsonToolResult(
	title: string,
	value: unknown,
	structuredContent: Record<string, unknown> = toStructuredContent(value),
): OpenContextToolResult {
	return {
		content: [
			{
				type: "text",
				text: `${title}\n\n${stringifyForText(value)}`,
			},
		],
		structuredContent,
	};
}

export function apiErrorToolResult(title: string, error: unknown): OpenContextToolResult {
	if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
		const message = "Request timed out before OpenContext responded.";
		return {
			content: [{ type: "text", text: `${title}: ${message}` }],
			structuredContent: {
				error: {
					kind: "timeout",
					message,
				},
			},
			isError: true,
		};
	}

	if (error instanceof OpenContextApiError) {
		return {
			content: [
				{
					type: "text",
					text: `${title}: OpenContext API request failed (${error.status})\n\n${stringifyForText(
						error.body,
					)}`,
				},
			],
			structuredContent: {
				error: {
					message: error.message,
					status: error.status,
					body: error.body,
				},
			},
			isError: true,
		};
	}

	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `${title}: ${message}` }],
		structuredContent: {
			error: { message },
		},
		isError: true,
	};
}

export async function requireReadyOpenContextClient(
	context: OpenContextToolContext,
): Promise<{ ready: true; client: OpenContextClient } | { ready: false; result: OpenContextToolResult }> {
	const readiness = await checkOpenContextReadiness({
		authToken: context.authToken,
		preferredBaseUrl: context.client.baseUrl,
	});

	if (!readiness.ready) {
		return {
			ready: false,
			result: {
				content: [
					{
						type: "text",
						text: formatOpenContextReadiness(readiness),
					},
				],
				structuredContent: { readiness: { ...readiness } },
				isError: true,
			},
		};
	}

	return {
		ready: true,
		client: new OpenContextClient({
			baseUrl: readiness.baseUrl ?? context.client.baseUrl,
			token: context.authToken.token ?? undefined,
		}),
	};
}

export async function withReadyOpenContextClient(
	context: OpenContextToolContext,
	title: string,
	run: (client: OpenContextClient) => Promise<OpenContextToolResult>,
): Promise<OpenContextToolResult> {
	const ready = await requireReadyOpenContextClient(context);
	if (!ready.ready) {
		return ready.result;
	}

	try {
		return await run(ready.client);
	} catch (error) {
		return apiErrorToolResult(title, error);
	}
}
