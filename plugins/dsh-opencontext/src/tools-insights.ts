/**
 * tools-insights — Insights search and management tools.
 *
 * OpenContext's insights API provides structured, extracted insights
 * from historical conversations. These tools expose that capability
 * to DSH agents.
 */

import { containsSecret } from "./secrets.js";
import { toolError, toolOk, type ToolResult, classifyBackendError } from "./errors.js";
import type { OpenContextBackend } from "./backend.js";
import type { ResolvedConfig } from "./config.js";

export type ToolContext = {
	signal?: AbortSignal;
	cwd?: string;
	scopeId?: string;
	userId?: string;
};

export type ToolDefinition = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	kind?: "search" | "read";
	output?: {
		schema: Record<string, unknown>;
		render: (args: Record<string, unknown>, value: ToolResult) => Array<{ type: string; text: string }>;
	};
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult<unknown>>;
};

// Shared output definition for insights tools
const INSIGHTS_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: { type: "boolean" },
			code: { type: "string" },
			message: { type: "string" },
			data: {
				type: "object",
				additionalProperties: true,
			},
		},
	},
	render(_args: Record<string, unknown>, value: ToolResult) {
		return [{ type: "text", text: JSON.stringify(value) }];
	},
};

function defineTool(spec: ToolDefinition): ToolDefinition {
	return { ...spec, output: spec.output ?? INSIGHTS_OUTPUT };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function coerceLimit(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(max, Math.floor(value)));
}

async function runTool<T>(fn: () => Promise<ToolResult<T> | T>): Promise<ToolResult<T>> {
	try {
		const value = await fn();
		if (value && typeof value === "object" && "ok" in value) {
			return value as ToolResult<T>;
		}
		return toolOk(value as T);
	} catch (error: unknown) {
		const cls = classifyBackendError(error);
		return toolError(cls.code, cls.message) as ToolResult<T>;
	}
}

function asScopeConfig(ctx: ToolContext, config: ResolvedConfig): { scopeId: string; userId: string } {
	const scopeId = ctx.scopeId || config.scopeId || "local:default";
	const userId = ctx.userId || scopeId;
	return { scopeId, userId };
}

/**
 * Insight categories supported by OpenContext
 */
const INSIGHT_CATEGORIES = [
	"decision",
	"preference",
	"outcome",
	"fact",
	"opinion",
	"plan",
	"question",
	"answer",
] as const;

/**
 * Create the insights search tool
 */
function createInsightsSearchTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return defineTool({
		name: "oc_insights_search",
		kind: "search",
		description:
			"Search structured insights extracted from historical conversations. Insights are higher-level abstractions like decisions, preferences, and outcomes.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Search query for insights",
			},
			categories: {
				type: "array",
				items: { type: "string" },
				description: `Filter by insight categories. Valid: ${INSIGHT_CATEGORIES.join(", ")}`,
			},
			limit: {
				type: "number",
				description: "Maximum insights to return (default 10, max 50).",
			},
			since: {
				type: "number",
				description: "Only return insights after this epoch ms timestamp.",
			},
		},
		execute: async (args, ctx) =>
			runTool(async () => {
				const query = String(args.query ?? "").trim();
				if (!query) return toolError("invalid_arguments", "query is required");

				const { scopeId, userId } = asScopeConfig(ctx, config);

				// Validate categories if provided
				let categories: string[] | undefined;
				if (Array.isArray(args.categories)) {
					categories = args.categories
						.map((c) => String(c).toLowerCase())
						.filter((c): c is (typeof INSIGHT_CATEGORIES)[number] =>
							(INSIGHT_CATEGORIES as readonly string[]).includes(c),
						);
				}

				// Call backend - this will be implemented in backend-extended
				const result = await backend.searchInsights?.(
					{
						query,
						categories,
						limit: coerceLimit(args.limit, 10, 50),
						scopeId,
						userId,
					} as unknown as Parameters<NonNullable<OpenContextBackend["searchInsights"]>>[0],
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				if (!result) {
					// Fallback if backend doesn't support insights yet
					return toolOk({
						insights: [],
						note: "Insights search is not available because the backend does not expose an insights store.",
					});
				}

				return toolOk({
					insights: (result.insights ?? []).map((insight) => ({
						id: insight.id,
						content: insight.content,
						category: insight.category,
						score: insight.score ?? 0,
						timestamp: insight.timestamp,
						metadata: insight.metadata ?? {},
					})),
				});
			}),
	});
}

/**
 * Create the insight capture tool
 */
function createInsightCaptureTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return defineTool({
		name: "oc_insight_capture",
		kind: "read",
		description:
			"Capture a structured insight. Use this when the conversation reveals a high-level abstraction like a decision, preference, or outcome.",
		parameters: {
			content: {
				type: "string",
				required: true,
				description: "The insight text to store",
			},
			category: {
				type: "string",
				description: `Insight category. Valid: ${INSIGHT_CATEGORIES.join(", ")}`,
			},
			metadata: {
				type: "object",
				additionalProperties: true,
				description: "Optional metadata (e.g. { relatedTo: 'project-X' })",
			},
		},
		execute: async (args, ctx) =>
			runTool(async () => {
				const content = String(args.content ?? "").trim();
				if (!content) return toolError("invalid_arguments", "content is required");
				if (containsSecret(content)) return toolError("secret_rejected", "content looks like a secret");

				const category = String(args.category ?? "fact").toLowerCase();
				if (!(INSIGHT_CATEGORIES as readonly string[]).includes(category)) {
					return toolError("invalid_arguments", `category must be one of: ${INSIGHT_CATEGORIES.join(", ")}`);
				}

				const { scopeId, userId } = asScopeConfig(ctx, config);

				const result = await backend.captureInsight?.(
					{
						content,
						category,
						metadata: asRecord(args.metadata),
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				if (!result) {
					return toolError(
						"backend_unavailable",
						"Insight capture is not available because the backend does not expose an insights store.",
					);
				}

				return toolOk({ id: result.id });
			}),
	});
}

export function makeInsightsTools(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition[] {
	return [createInsightsSearchTool(backend, config), createInsightCaptureTool(backend, config)];
}

export function registerInsightsTools(
	ctx: { tools: { register: (tool: unknown) => () => void } },
	runtime: { backend: OpenContextBackend; config: ResolvedConfig },
	defineTool: (definition: Record<string, unknown>) => unknown,
): () => void {
	const tools = makeInsightsTools(runtime.backend, runtime.config);
	const disposers: Array<() => void> = [];
	for (const tool of tools) {
		disposers.push(ctx.tools.register(defineTool(tool)));
	}
	return () => {
		for (const dispose of disposers) {
			try {
				dispose();
			} catch {
				// ignore
			}
		}
	};
}
