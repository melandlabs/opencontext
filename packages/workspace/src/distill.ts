/**
 * `@melandlabs/workspace/distill` — resource-level distillation.
 *
 * Given one workspace page, ask an injected LLM which other pages in the
 * workspace it relates to and how. Returns a list of `DistilledEdgeProposal`
 * records the caller can review before calling `upsertReferenceEdges`.
 *
 * Why a separate primitive from `memory-store/distill.ts`?
 *   - `distillRawMessage` extracts entities from a single raw message.
 *   - `distillResource` extracts *cross-page edges* from a workspace
 *     resource's body + front-matter, with the existing workspace as
 *     the candidate target set. Edges have provenance so they can be
 *     reconciled later via `reconcileResourceEdges`.
 *
 * The LLM extractor is host-injected — opencontext never bundles a model.
 * When no extractor is configured the function short-circuits with a
 * warning (mirroring `distillRawMessage`'s degraded-mode pattern).
 */
import type { EdgeProvenance, WorkspaceEdgeType } from "./types";

export interface DistillResourceInput {
	workspace_id: string;
	user_id: string;
	resource_id: number;
	/**
	 * Optional explicit target page list. Defaults to every other
	 * resource in the workspace. Constraining candidates protects
	 * against LLM-hallucinated page references.
	 */
	candidateTargets?: Array<{
		canonical_key: string;
		title: string;
		resource_type: string;
		excerpt?: string;
	}>;
	/**
	 * Host-injected LLM edge extractor. Receives the source body and
	 * the bounded candidate set; returns proposed edges.
	 */
	edgeExtractor?: (input: {
		source: { canonical_key: string; title: string; body: string };
		candidates: DistillResourceInput["candidateTargets"];
	}) => Promise<DistilledEdgeProposal[]>;
	/** Identifier used in edge provenance (`run_id`). */
	runId: string;
	/**
	 * When true, immediately write the proposals via
	 * `upsertReferenceEdges`. Default false — most callers want to
	 * review / diff the proposals before persisting.
	 */
	autoUpsert?: boolean;
}

export interface DistilledEdgeProposal {
	source_resource_id: number;
	source_version_id: number | null;
	target_resource_id: number;
	target_version_id: number | null;
	edge_type: WorkspaceEdgeType;
	quote?: string;
	confidence?: number;
	rationale?: string;
	/**
	 * `canonical_key` of the target — captured for human review and
	 * cross-checking against the candidate list. Not stored on the edge
	 * itself (edges resolve to `target_resource_id` only).
	 */
	target_canonical_key?: string;
}

export interface DistillResourceOutput {
	proposals: DistilledEdgeProposal[];
	/** Number of proposals that resolved to a known resource_id. */
	resolved: number;
	/** Number of proposals that could not be matched to a candidate. */
	unresolved: number;
	warnings: Array<{ code: string; message: string }>;
}

/**
 * Resolve a `DistillResourceInput` into proposals. The function does
 * not throw — every failure mode degrades into a warning so the caller
 * can still ship best-effort output.
 *
 * The function is pure with respect to the SQLite store: it reads but
 * only writes when `autoUpsert: true`. Returns the same shape
 * regardless so callers can pipe through a manual review UI.
 */
export async function distillResource(
	store: import("./sqlite").SqliteWorkspaceStore,
	input: DistillResourceInput,
): Promise<DistillResourceOutput> {
	const warnings: Array<{ code: string; message: string }> = [];

	const resource = store.findResourceByCanonicalKey({
		workspace_id: input.workspace_id,
		canonical_key: "__nonexistent__",
	});
	// The above is a trick — findResourceByCanonicalKey takes a key. We
	// actually want to look up by resource_id; use the low-level
	// `__testDb` for that, then read body chunks separately.
	void resource;
	const db = (store as unknown as { __testDb?: unknown }).__testDb;
	if (!db) {
		warnings.push({
			code: "distill_resource_store_handle_unavailable",
			message: "Internal handle for reading resource body is unavailable in this build.",
		});
		return { proposals: [], resolved: 0, unresolved: 0, warnings };
	}

	const { workspace_id, resource_id, runId } = input;

	// 1. Read source resource metadata.
	const resourceRow = (db as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } })
		.prepare(
			`SELECT id, canonical_key, title, current_version_id, resource_type
         FROM workspace_resources WHERE workspace_id = ? AND id = ?`,
		)
		.get(workspace_id, resource_id) as
		| {
				id: number;
				canonical_key: string;
				title: string;
				current_version_id: number | null;
				resource_type: string;
		  }
		| undefined;
	if (!resourceRow) {
		warnings.push({
			code: "distill_resource_not_found",
			message: `resource_id ${resource_id} not found in workspace ${workspace_id}`,
		});
		return { proposals: [], resolved: 0, unresolved: 0, warnings };
	}

	// 2. Concatenate the current version's chunks into a body string.
	const chunkRows = (db as { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } })
		.prepare(
			`SELECT content FROM workspace_chunks WHERE resource_id = ? AND version_id = ?
         ORDER BY chunk_index ASC`,
		)
		.all(resource_id, resourceRow.current_version_id) as Array<{ content: string }>;
	const body = chunkRows.map((c) => c.content).join("\n\n");

	// 3. Build candidate target list (unless caller supplied one).
	const candidates = input.candidateTargets ?? buildDefaultCandidates(store, workspace_id, resource_id);

	if (!input.edgeExtractor) {
		warnings.push({
			code: "distill_extractor_not_configured",
			message: "No `edgeExtractor` wired into the call; returning an empty proposal list.",
		});
		return { proposals: [], resolved: 0, unresolved: 0, warnings };
	}

	// 4. Run the LLM.
	let rawProposals: DistilledEdgeProposal[];
	try {
		rawProposals = await input.edgeExtractor({
			source: {
				canonical_key: resourceRow.canonical_key,
				title: resourceRow.title,
				body,
			},
			candidates,
		});
	} catch (error) {
		warnings.push({
			code: "distill_extractor_failed",
			message: (error as Error).message ?? "edge extractor threw",
		});
		return { proposals: [], resolved: 0, unresolved: 0, warnings };
	}

	// 5. Normalize: drop unknown edge_type, drop targets that aren't in
	// the candidate set (closes the LLM-hallucination loophole), drop
	// proposals that point at the source itself.
	const validEdges: ReadonlySet<WorkspaceEdgeType> = new Set(["cites", "supersedes", "amends", "relates-to"]);
	const candidateKeys = new Set(candidates.map((c) => c.canonical_key));
	const candidatesByKey = new Map(candidates.map((c) => [c.canonical_key, c]));

	const normalized: DistilledEdgeProposal[] = [];
	let unresolved = 0;
	for (const p of rawProposals) {
		if (!p || !validEdges.has(p.edge_type)) continue;
		if (p.target_canonical_key && !candidateKeys.has(p.target_canonical_key)) {
			unresolved += 1;
			continue;
		}
		if (!p.target_canonical_key) {
			unresolved += 1;
			continue;
		}
		const targetMeta = candidatesByKey.get(p.target_canonical_key);
		if (!targetMeta) {
			unresolved += 1;
			continue;
		}
		normalized.push(p);
	}

	const output: DistillResourceOutput = {
		proposals: normalized,
		resolved: normalized.length,
		unresolved,
		warnings,
	};

	if (input.autoUpsert && normalized.length > 0) {
		// Resolve canonical_keys → resource_ids via the store.
		const resolvedEdges = normalized.flatMap((p) => {
			const targetResourceId = findResourceIdByCanonicalKey(store, workspace_id, p.target_canonical_key!);
			if (targetResourceId === null) return [];
			const provenance: EdgeProvenance = {
				source: "llm_distill",
				run_id: runId,
				extractor_model: input.edgeExtractor?.name,
				confidence: p.confidence,
				rationale: p.rationale,
				resolved_at: Math.floor(Date.now() / 1000),
			};
			return [
				{
					source_resource_id: resourceRow.id,
					source_version_id: resourceRow.current_version_id,
					target_resource_id: targetResourceId,
					target_version_id: null,
					edge_type: p.edge_type,
					quote: p.quote ?? null,
					provenance,
				},
			];
		});
		if (resolvedEdges.length > 0) {
			store.upsertReferenceEdges({
				workspace_id,
				edges: resolvedEdges,
			});
		}
	}

	return output;
}

function buildDefaultCandidates(
	store: import("./sqlite").SqliteWorkspaceStore,
	workspace_id: string,
	resource_id: number,
): Array<{ canonical_key: string; title: string; resource_type: string; excerpt?: string }> {
	const result = store.listResources({ workspace_id, limit: 200, offset: 0 });
	return result.resources
		.filter((r) => r.id !== resource_id)
		.map((r) => ({
			canonical_key: r.canonical_key,
			title: r.title,
			resource_type: r.resource_type,
		}));
}

function findResourceIdByCanonicalKey(
	store: import("./sqlite").SqliteWorkspaceStore,
	workspace_id: string,
	canonical_key: string,
): number | null {
	const found = store.findResourceByCanonicalKey({ workspace_id, canonical_key });
	return found?.id ?? null;
}
