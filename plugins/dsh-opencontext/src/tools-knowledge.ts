/**
 * tools-knowledge — Knowledge/RAG search and document management tools.
 *
 * OpenContext's RAG capabilities allow agents to search uploaded documents
 * and knowledge bases. These tools expose document search and upload.
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
		render: string;
		presentationMeta?: Record<string, unknown>;
	};
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult<unknown>>;
};

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

function runTool<T>(fn: () => Promise<ToolResult<T> | T>): Promise<ToolResult<T>> {
	return fn()
		.then((value) => {
			if (value && typeof value === "object" && "ok" in value) {
				return value as ToolResult<T>;
			}
			return toolOk(value as T);
		})
		.catch((error: unknown) => {
			const cls = classifyBackendError(error);
			return toolError(cls.code, cls.message);
		});
}

function asScopeConfig(ctx: ToolContext, config: ResolvedConfig): { scopeId: string; userId: string } {
	const scopeId = ctx.scopeId || config.scopeId || "local:default";
	const userId = ctx.userId || scopeId;
	return { scopeId, userId };
}

/**
 * Create the knowledge search tool
 */
function createKnowledgeSearchTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return {
		name: "oc_knowledge_search",
		kind: "search",
		description:
			"Search uploaded documents and knowledge bases using RAG (Retrieval-Augmented Generation). Returns relevant document chunks.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Search query for document contents",
			},
			documentIds: {
				type: "array",
				items: { type: "string" },
				description: "Optional list of document IDs to search within",
			},
			limit: {
				type: "number",
				description: "Maximum chunks to return (default 5, max 20).",
			},
			threshold: {
				type: "number",
				description: "Minimum similarity threshold (0-1, default 0.6)",
			},
		},
		output: {
			schema: {
				chunks: {
					type: "array",
					items: {
						id: { type: "string" },
						content: { type: "string" },
						documentId: { type: "string" },
						documentName: { type: "string" },
						score: { type: "number" },
						metadata: { type: "object" },
					},
				},
			},
			render(args: unknown, value: unknown) {
				return value;
			},
		},
		execute: async (args, ctx) =>
			runTool<{
				chunks: Array<{
					id: string;
					content: string;
					documentId?: string;
					documentName?: string;
					score: number;
					metadata: Record<string, unknown>;
				}>;
			}>(async () => {
				const query = String(args.query ?? "").trim();
				if (!query) return toolError("invalid_arguments", "query is required");

				const { scopeId, userId } = asScopeConfig(ctx, config);

				// Parse document IDs if provided
				let documentIds: string[] | undefined;
				if (Array.isArray(args.documentIds)) {
					documentIds = args.documentIds.map((id) => String(id));
				}

				// Call backend
				const result = await (backend as any).searchKnowledge?.(
					{
						query,
						documentIds,
						limit: coerceLimit(args.limit, 5, 20),
						threshold: typeof args.threshold === "number" ? args.threshold : 0.6,
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				if (!result) {
					return toolOk({
						chunks: [],
						note: "Knowledge search not yet available in this backend mode",
					});
				}

				return toolOk({
					chunks: (result.chunks ?? []).map((chunk: any) => ({
						id: chunk.id,
						content: chunk.content,
						documentId: chunk.documentId,
						documentName: chunk.documentName,
						score: chunk.score ?? 0,
						metadata: chunk.metadata ?? {},
					})),
				});
			}),
	};
}

/**
 * Create the document upload tool
 */
function createDocumentUploadTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return {
		name: "oc_document_upload",
		kind: "read",
		description:
			"Upload a document to the knowledge base for later RAG search. The document will be chunked and indexed.",
		parameters: {
			content: {
				type: "string",
				required: true,
				description: "Document content (text)",
			},
			filename: {
				type: "string",
				required: true,
				description: "Document filename (e.g. 'spec.pdf' or 'notes.md')",
			},
			mimeType: {
				type: "string",
				description: "MIME type (e.g. 'application/pdf', 'text/plain')",
			},
			metadata: {
				type: "object",
				additionalProperties: true,
				description: "Optional metadata (e.g. { category: 'spec', version: '1.0' })",
			},
		},
		output: {
			schema: {
				documentId: { type: "string" },
				chunks: { type: "number" },
			},
			render(args: unknown, value: unknown) {
				return value;
			},
		},
		execute: async (args, ctx) =>
			runTool<{ documentId: string; chunks: number }>(async () => {
				const content = String(args.content ?? "");
				if (!content) return toolError("invalid_arguments", "content is required");

				const filename = String(args.filename ?? "").trim();
				if (!filename) return toolError("invalid_arguments", "filename is required");

				if (containsSecret(content)) return toolError("secret_rejected", "content looks like a secret");

				const { scopeId, userId } = asScopeConfig(ctx, config);

				const result = await (backend as any).uploadDocument?.(
					{
						content,
						filename,
						mimeType: typeof args.mimeType === "string" ? args.mimeType : "text/plain",
						metadata: asRecord(args.metadata),
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				if (!result) {
					return toolError("backend_unavailable", "Document upload not yet available in this backend mode");
				}

				return toolOk({
					documentId: result.documentId ?? "",
					chunks: result.chunks ?? 0,
				});
			}),
	};
}

/**
 * Create the document list tool
 */
function createDocumentListTool(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition {
	return {
		name: "oc_document_list",
		kind: "read",
		description: "List all documents in the knowledge base for the current scope",
		parameters: {
			limit: {
				type: "number",
				description: "Maximum documents to return (default 50, max 200).",
			},
		},
		output: {
			schema: {
				documents: {
					type: "array",
					items: {
						id: { type: "string" },
						filename: { type: "string" },
						mimeType: { type: "string" },
						uploadedAt: { type: "number" },
						chunks: { type: "number" },
						metadata: { type: "object" },
					},
				},
			},
			render: "text/json",
		},
		execute: async (args, ctx) =>
			runTool<{
				documents: Array<{
					id: string;
					filename: string;
					mimeType: string;
					uploadedAt: number;
					chunks: number;
					metadata: Record<string, unknown>;
				}>;
			}>(async () => {
				const { scopeId, userId } = asScopeConfig(ctx, config);

				const result = await (backend as any).listDocuments?.(
					{
						limit: coerceLimit(args.limit, 50, 200),
						scopeId,
						userId,
					},
					{ signal: ctx.signal, timeoutMs: config.timeoutMs },
				);

				if (!result) {
					return toolOk({
						documents: [],
						note: "Document listing not yet available in this backend mode",
					});
				}

				return toolOk({
					documents: (result.documents ?? []).map((doc: any) => ({
						id: doc.id,
						filename: doc.filename,
						mimeType: doc.mimeType,
						uploadedAt: doc.uploadedAt ?? Date.now(),
						chunks: doc.chunks ?? 0,
						metadata: doc.metadata ?? {},
					})),
				});
			}),
	};
}

export function makeKnowledgeTools(backend: OpenContextBackend, config: ResolvedConfig): ToolDefinition[] {
	return [
		createKnowledgeSearchTool(backend, config),
		createDocumentUploadTool(backend, config),
		createDocumentListTool(backend, config),
	];
}

export function registerKnowledgeTools(
	ctx: { tools: { register: (tool: unknown) => () => void } },
	backend: OpenContextBackend,
	config: ResolvedConfig,
): () => void {
	const tools = makeKnowledgeTools(backend, config);
	const disposers: Array<() => void> = [];
	for (const tool of tools) {
		disposers.push(ctx.tools.register(tool));
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
