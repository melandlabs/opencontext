/**
 * tools-summary — Session summary and memory consolidation tools.
 *
 * These tools allow agents to generate and manage session summaries,
 * consolidating scattered interactions into higher-level memories.
 */

import type { OpenContextBackend } from "./backend.js";
import type { ResolvedConfig } from "./config.js";
import { type ToolResult, classifyBackendError, toolError, toolOk } from "./errors.js";
import { containsSecret } from "./secrets.js";

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

// Shared output definition for summary tools
const SUMMARY_OUTPUT = {
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
	return { ...spec, output: spec.output ?? SUMMARY_OUTPUT };
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
 * Create the session summary tool
 */
function createSessionSummaryTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return defineTool({
		name: "oc_session_summary",
		kind: "read",
		description:
			"Generate and store a summary of the current session. Use this at natural breakpoints (task completion, context switches).",
		parameters: {
			summary: {
				type: "string",
				required: true,
				description: "The session summary text",
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Optional tags for categorization (e.g. ['task-complete', 'decision-made'])",
			},
			metadata: {
				type: "object",
				additionalProperties: true,
				description: "Optional metadata (e.g. { project: 'X', milestone: 'Y' })",
			},
		},
		execute: async (args, ctx) =>
			runTool(async () => {
				const summary = String(args.summary ?? "").trim();
				if (!summary) return toolError("invalid_arguments", "summary is required");
				if (containsSecret(summary)) return toolError("secret_rejected", "summary looks like a secret");

				const { scopeId, userId } = asScopeConfig(ctx, config);

				const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [];

				const result = await backend.remember(
					{
						content: summary,
						sourceType: "session-summary",
						metadata: {
							...asRecord(args.metadata),
							tags,
							ts: Date.now(),
						},
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				const id = result.ids?.[0] ?? "";
				return toolOk({ id });
			}),
	});
}

/**
 * Create the task outcome tool
 */
function createTaskOutcomeTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return defineTool({
		name: "oc_task_outcome",
		kind: "read",
		description:
			"Record a task outcome or achievement. Use this when a task is completed, a decision is made, or a deliverable is produced.",
		parameters: {
			outcome: {
				type: "string",
				required: true,
				description: "Description of the outcome or achievement",
			},
			taskName: { type: "string", description: "Optional task name" },
			status: {
				type: "string",
				description: "Status: completed, failed, blocked, or in-progress (default: completed)",
			},
			metadata: {
				type: "object",
				additionalProperties: true,
				description: "Optional metadata",
			},
		},
		execute: async (args, ctx) =>
			runTool(async () => {
				const outcome = String(args.outcome ?? "").trim();
				if (!outcome) return toolError("invalid_arguments", "outcome is required");
				if (containsSecret(outcome)) return toolError("secret_rejected", "outcome looks like a secret");

				const { scopeId, userId } = asScopeConfig(ctx, config);

				const taskName = typeof args.taskName === "string" ? args.taskName.trim() : undefined;
				const status = String(args.status ?? "completed").toLowerCase();

				const result = await backend.remember(
					{
						content: outcome,
						sourceType: "task-outcome",
						metadata: {
							...asRecord(args.metadata),
							taskName,
							status,
							ts: Date.now(),
						},
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				const id = result.ids?.[0] ?? "";
				return toolOk({ id });
			}),
	});
}

/**
 * Create the recent summaries tool
 */
function createRecentSummariesTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return defineTool({
		name: "oc_recent_summaries",
		kind: "read",
		description: "List recent session summaries and task outcomes",
		parameters: {
			limit: {
				type: "number",
				description: "Maximum items to return (default 20, max 100).",
			},
			sourceTypes: {
				type: "array",
				items: { type: "string" },
				description: "Filter by source type (e.g. ['session-summary', 'task-outcome'])",
			},
		},
		execute: async (args, ctx) =>
			runTool(async () => {
				const { scopeId, userId } = asScopeConfig(ctx, config);

				// Use list with source type filter
				const items = await backend.list(
					{
						limit: coerceLimit(args.limit, 20, 100),
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				// Filter by source types if provided
				let filtered = items;
				if (Array.isArray(args.sourceTypes) && args.sourceTypes.length > 0) {
					const sourceTypes = new Set(args.sourceTypes.map((s) => String(s)));
					filtered = items.filter((item) => sourceTypes.has(item.platform || ""));
				}

				// Only return summaries and outcomes
				const summaryTypes = new Set(["session-summary", "task-outcome", "turn-summary"]);
				filtered = filtered.filter((item) => summaryTypes.has(item.platform || ""));

				return toolOk({
					items: filtered.map((item) => ({
						id: item.id,
						content: item.content,
						sourceType: item.platform || "unknown",
						timestamp: item.timestamp ?? Date.now(),
						metadata: item.metadata ?? {},
					})),
				});
			}),
	});
}

export function makeSummaryTools(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition[] {
	return [
		createSessionSummaryTool(backend, config),
		createTaskOutcomeTool(backend, config),
		createRecentSummariesTool(backend, config),
	];
}

export function registerSummaryTools(
	ctx: { tools: { register: (tool: unknown) => () => void } },
	runtime: { backend: OpenContextBackend; config: ResolvedConfig },
	defineTool: (definition: Record<string, unknown>) => unknown,
): () => void {
	const tools = makeSummaryTools(runtime.backend, runtime.config);
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
