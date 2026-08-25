/**
 * `distill` primitive — extract `EntityEdge`s from a single raw message.
 *
 * The host wires in an LLM extractor via `UnifiedSearchDeps.entityExtractor`.
 * When the dep is absent, the primitive short-circuits with a
 * `distill_extractor_not_configured` warning — matching the
 * `memory_iterative_planner_not_configured` precedent so callers can
 * detect the degraded mode uniformly.
 *
 * Persistence is intentionally the host's responsibility: the SDK
 * surfaces the edges plus an optional `persist` callback that the
 * caller supplies on the input. This keeps the memory-store decoupled
 * from any entity-store schema and lets hosts reuse their existing
 * graph nodes / SQLite tables / Loop-engine queues without an extra
 * migration.
 *
 * The module is intentionally pure (no I/O of its own beyond calling
 * the extractor and `persist`). That keeps it unit-testable with a
 * fake extractor and a counter on `persist`.
 */

import { type EntityEdge, isEntityKind } from "@melandlabs/contracts/entity-edge";
import type { UnifiedSearchDeps } from "../config";

export interface DistillInput {
	userId: string;
	messageId: string;
	content: string;
	/**
	 * Optional host-side persistence callback. Invoked exactly once
	 * with the extracted edges when an extractor is wired in. Hosts
	 * that want to batch-distill should call `distillRawMessage` in a
	 * loop and persist themselves.
	 */
	persist?: (edges: EntityEdge[]) => Promise<void>;
}

export interface DistillWarning {
	code: string;
	message: string;
}

export interface DistillOutput {
	edges: EntityEdge[];
	warnings: DistillWarning[];
}

/**
 * Run the entity extractor over a single raw message.
 *
 *   - No extractor configured → `{ edges: [], warnings: [...] }`.
 *   - Extractor configured → call it, await `persist` if provided,
 *     return the edges. Errors in the extractor (or the persist
 *     callback) are surfaced as warnings and the function never
 *     throws — distill is best-effort by design.
 */
export async function distillRawMessage(
	deps: Pick<UnifiedSearchDeps, "entityExtractor">,
	input: DistillInput,
	logger: Pick<Console, "warn"> = console,
): Promise<DistillOutput> {
	const warnings: DistillWarning[] = [];

	if (typeof deps.entityExtractor !== "function") {
		warnings.push({
			code: "distill_extractor_not_configured",
			message: "No `entityExtractor` is wired into the unified search deps; returning an empty entity list.",
		});
		return { edges: [], warnings };
	}

	let edges: EntityEdge[];
	try {
		edges = await deps.entityExtractor({
			userId: input.userId,
			messageId: input.messageId,
			content: input.content,
		});
	} catch (error) {
		logger.warn?.("[memory-store/distill] extractor threw:", error);
		warnings.push({
			code: "distill_extractor_failed",
			message: (error as Error).message ?? "entity extractor failed",
		});
		return { edges: [], warnings };
	}

	if (!Array.isArray(edges)) {
		warnings.push({
			code: "distill_extractor_returned_invalid_shape",
			message: `entityExtractor returned ${typeof edges}; expected EntityEdge[]`,
		});
		return { edges: [], warnings };
	}

	// Normalize: drop entries missing required fields or carrying an unknown
	// `kind` value (the contract is a closed enum — see
	// `contracts/entity-edge.ts`). Fill in `extractedAt` if absent.
	const normalized: EntityEdge[] = [];
	const now = Date.now();
	for (const edge of edges) {
		if (
			!edge ||
			typeof edge.label !== "string" ||
			edge.label.length === 0 ||
			typeof edge.kind !== "string" ||
			!isEntityKind(edge.kind) ||
			typeof edge.relation !== "string" ||
			typeof edge.sourceMessageId !== "string"
		) {
			continue;
		}
		normalized.push({
			...edge,
			label: edge.label.trim().toLowerCase(),
			extractedAt: typeof edge.extractedAt === "number" ? edge.extractedAt : now,
		});
	}

	if (input.persist && normalized.length > 0) {
		try {
			await input.persist(normalized);
		} catch (error) {
			logger.warn?.("[memory-store/distill] persist callback threw:", error);
			warnings.push({
				code: "distill_persist_failed",
				message: (error as Error).message ?? "distill persist failed",
			});
		}
	}

	return { edges: normalized, warnings };
}
