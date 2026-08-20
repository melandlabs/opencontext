import type { ContextHit, ContextQuery, ContextSource } from "./shared";

/**
 * Backend port for the "knowledge" side of the unified context layer.
 *
 * The default adapter wraps the host's RAG service
 * (`searchSimilarChunks` or equivalent) so callers do not need to know about
 * LangChain or pgvector directly.
 */
export interface KnowledgeBackendPort {
	readonly source: ContextSource;

	search(query: ContextQuery): Promise<ContextHit[]>;
}
