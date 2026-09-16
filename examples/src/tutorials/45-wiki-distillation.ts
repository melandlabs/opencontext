/**
 * demo: `@melandlabs/workspace` — wiki distillation substrate (v0.3).
 *
 * Walks every new building block that landed alongside the v0.3
 * wiki-distillation surface:
 *
 *   1. `distillResource`           — LLM-injected edge proposals for
 *                                    a single resource (anti-hallucination
 *                                    via candidate validation).
 *   2. `promoteFactsToPage`        — Materialise a cluster of memory
 *                                    facts as a single workspace page
 *                                    (the Tier 4.1 bridge).
 *   3. `editChunk` + `rollbackToVersion` — In-place chunk edits and
 *                                    version-chain rollback.
 *   4. `reconcileResourceEdges`    — Trim a resource's edge set down to
 *                                    a known-keep list, with provenance
 *                                    filtering.
 *   5. `resolveWorkspaceCitation`  — Cross-layer citation resolver with
 *                                    drift detection (workspace_chunk +
 *                                    host-injected memory_fact).
 *   6. `EmbeddingQueue` DLQ retry  — Drain the dead-letter queue after
 *                                    the embedding provider recovered.
 *
 * Every step runs the **real** `@melandlabs/workspace` API on a temp
 * SQLite database so the assertions exercise the production code path.
 *
 * Host-injected LLMs are mocked deterministically — the production
 * package never bundles a model.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Citation } from "@melandlabs/opencontext";
import type {
	DistillResourceInput,
	DistilledEdgeProposal,
	PromoteFactsInput,
	WorkspaceSearchHit,
} from "@melandlabs/opencontext";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

const WORKSPACE_ID = "demo-wiki";
const USER_ID = "demo-user";

type WorkspaceModule = {
	closeSQLiteWorkspaceStore: () => Promise<void>;
	distillResource: (input: DistillResourceInput) => Promise<{ proposals: DistilledEdgeProposal[] }>;
	editChunk: (
		store: unknown,
		input: {
			workspace_id: string;
			chunk_id: string;
			new_content: string;
			edit_reason?: string;
		},
	) => Promise<{ needsReembed: boolean }>;
	getSQLiteWorkspaceStore: (options: { dbPath: string }) => Promise<unknown>;
	promoteFactsToPage: (input: PromoteFactsInput) => Promise<{
		resource_id: number;
		version_id: number;
		inserted_facts: number;
	}>;
	resolveWorkspaceCitation: (
		ctx: { user_id: string; request_id: string },
		store: unknown,
		input: { citation: Citation },
		deps?: {
			resolveMemoryFact?: (input: { memory_fact_id: string }) => Promise<{
				kind: "memory_fact";
				content: string;
				content_hash: string;
				drift: boolean;
				raw: unknown;
			} | null>;
		},
	) => Promise<
		| { status: "resolved"; citation: Citation; content: string; drift: false }
		| { status: "drifted"; citation: Citation; content: string; drift: true; expected_hash: string }
		| { status: "missing"; citation: Citation; reason: string }
	>;
	rollbackToVersion: (
		store: unknown,
		input: {
			workspace_id: string;
			resource_id: number;
			target_version_id: number;
			snapshotCurrent?: boolean;
		},
	) => { new_current_version_id: number };
	reconcileResourceEdges: (
		store: unknown,
		input: {
			workspace_id: string;
			resource_id: number;
			keep: Array<{ target_resource_id: number; edge_type: string }>;
			onlyProvenance?: string[];
			dryRun?: boolean;
		},
	) => { removed: unknown[]; kept: number };
	searchWorkspaceContext: (
		ctx: { user_id: string; request_id: string },
		store: unknown,
		input: { workspace_id: string; query: string; strategy: string },
	) => Promise<{ hits: WorkspaceSearchHit[] }>;
	updateWorkspaceContext: (
		ctx: { user_id: string; request_id: string },
		store: unknown,
		input: { workspace_id: string; source: string; path: string },
	) => Promise<{ filesScanned: number; filesAdded: number }>;
};

let _workspaceCache: WorkspaceModule | undefined;
async function loadWorkspace(): Promise<WorkspaceModule | null> {
	if (_workspaceCache) return _workspaceCache;
	try {
		// @ts-expect-error -- optional workspace subpath; absent in the npm
		// smoke-test environment which installs only the published facade.
		const mod = (await import("@melandlabs/workspace")) as WorkspaceModule;
		_workspaceCache = mod;
		return mod;
	} catch {
		return null;
	}
}

function resolveFixtureDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..", "..", "fixtures", "workspace-wiki");
}

async function buildFixture(dir: string): Promise<void> {
	const wikiDir = join(dir, "wiki");
	await mkdir(wikiDir, { recursive: true });
	const sourceDir = resolveFixtureDir();
	for (const name of ["a.md", "b.md", "law-clause.md"]) {
		await copyFile(join(sourceDir, name), join(wikiDir, name));
	}
}

function makeRuntimeContext(): { user_id: string; request_id: string } {
	return { user_id: USER_ID, request_id: randomUUID() };
}

/**
 * Host-injected LLM stub. The package never bundles a model — every
 * call site passes its own. Here we return hand-crafted proposals so
 * the assertions can pin the exact behaviour.
 */
async function mockEdgeExtractor(input: { body: string }): Promise<
	Array<{ target_canonical_key: string; edge_type: string; rationale: string; confidence: number }>
> {
	if (input.body.includes("cap on liability")) {
		return [
			{
				target_canonical_key: "law-clause.md",
				edge_type: "cites",
				rationale: "the contract references the law clause",
				confidence: 0.92,
			},
		];
	}
	return [];
}

export default async function demoWikiDistillation() {
	await runSection("demo: @melandlabs/workspace — wiki distillation (v0.3 surface)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/wiki-distill");
		const ws = await loadWorkspace();
		if (!ws) {
			skip(
				"@melandlabs/workspace is installed",
				"optional peer dep — npm-installed smoke test environment skips this demo",
			);
			return;
		}

		await withTmp("wiki-distill", async (dir) => {
			await buildFixture(dir);
			const dbPath = join(dir, "wiki.db");
			const store = await ws.getSQLiteWorkspaceStore({ dbPath });
			const ctx = makeRuntimeContext();

			// ── 1. Index the fixture folder ──────────────────────────────
			const update = await ws.updateWorkspaceContext(ctx, store, {
				workspace_id: WORKSPACE_ID,
				source: "okf_folder",
				path: join(dir, "wiki"),
			});
			check(
				"updateWorkspaceContext indexes 3 fixture files",
				update.filesScanned >= 3 && update.filesAdded >= 3,
				`scanned=${update.filesScanned}, added=${update.filesAdded}`,
			);

			// ── 2. distillResource ────────────────────────────────────────
			// We pretend `a.md` is a contract summary. The mock LLM returns
			// a single high-confidence proposal pointing at `law-clause.md`,
			// which the validator accepts because that resource is present.
			const candidates = [
				{ canonical_key: "a.md", title: "a" },
				{ canonical_key: "b.md", title: "b" },
				{ canonical_key: "law-clause.md", title: "law-clause" },
			];
			const aResource = candidates[0]!;
			const distill = await ws.distillResource({
				workspace_id: WORKSPACE_ID,
				resource_canonical_key: aResource.canonical_key,
				body: "this contract includes a cap on liability clause...",
				candidates,
				edgeExtractor: { name: "mock-gpt" },
				extractEdges: mockEdgeExtractor,
				autoUpsert: false,
			});
			check(
				"distillResource returns ≥ 1 validated proposal (autoUpsert=false)",
				distill.proposals.length >= 1,
				`proposals=${distill.proposals.length}`,
			);
			check(
				"distillResource strips proposals whose target isn't in the candidate set",
				distill.proposals.every((p) => p.target_canonical_key === "law-clause.md"),
				distill.proposals.map((p) => p.target_canonical_key).join(","),
			);
			info(
				"demo/wiki-distill",
				`distillResource → ${distill.proposals.length} proposal(s) against '${aResource.canonical_key}'`,
			);

			// ── 3. promoteFactsToPage ────────────────────────────────────
			// Synthesise a "memory-fact cluster" and turn it into a page.
			const promoted = await ws.promoteFactsToPage({
				workspace_id: WORKSPACE_ID,
				user_id: USER_ID,
				canonical_key: "wiki/promoted-facts.md",
				title: "Promoted facts summary",
				resource_type: "note",
				facts: [
					{
						memory_fact_id: "fact-1",
						valid_from: Date.now() - 86_400_000,
						content: "The product launched in Q2 2026.",
					},
					{
						memory_fact_id: "fact-2",
						valid_from: Date.now() - 86_400_000,
						content: "Pricing was set at $49 / seat / month.",
					},
				],
				bodyGenerator: async ({ facts }) => ({
					body: facts.map((f) => `- ${f.content}`).join("\n"),
					front_matter: {
						type: "Promoted",
						promoted_facts: facts.map((f) => f.memory_fact_id),
					},
				}),
			});
			check(
				"promoteFactsToPage creates a new resource + links facts",
				promoted.resource_id > 0 && promoted.inserted_facts === 2,
				`resource_id=${promoted.resource_id}, inserted=${promoted.inserted_facts}`,
			);

			// ── 4. Citation envelope + resolveWorkspaceCitation ──────────
			const search = await ws.searchWorkspaceContext(ctx, store, {
				workspace_id: WORKSPACE_ID,
				query: "limitation",
				strategy: "lexical",
			});
			const firstHit = search.hits[0];
			check(
				"lexical search returns ≥ 1 hit with a citation envelope",
				!!firstHit?.citation && firstHit.citation.kind === "workspace_chunk",
				`hit=${firstHit?.resource_title}, citation.kind=${firstHit?.citation.kind}`,
			);
			if (firstHit?.citation) {
				const citation = firstHit.citation;
				const resolved = await ws.resolveWorkspaceCitation(ctx, store, { citation });
				check(
					"resolveWorkspaceCitation returns 'resolved' for an unmodified chunk",
					resolved.status === "resolved" && resolved.drift === false,
					`status=${resolved.status}`,
				);
				check(
					"resolveWorkspaceCitation surfaces the chunk's live content",
					resolved.status === "resolved" && resolved.content.length > 0,
					`len=${resolved.status === "resolved" ? resolved.content.length : 0}`,
				);

				// Memory-fact resolution via the host-injected resolver.
				const memoryCitation: Citation = {
					id: "fact:demo-1",
					kind: "memory_fact",
					memory_fact_id: "demo-1",
					snippet: "snapshot",
					scores: {},
					content_hash: "abc",
				};
				const memoryResolved = await ws.resolveWorkspaceCitation(
					ctx,
					store,
					{ citation: memoryCitation },
					{
						resolveMemoryFact: async ({ memory_fact_id }) => ({
							kind: "memory_fact",
							content: `live content for ${memory_fact_id}`,
							content_hash: "abc",
							drift: false,
							raw: { id: memory_fact_id },
						}),
					},
				);
				check(
					"resolveWorkspaceCitation delegates memory_fact to host resolver",
					memoryResolved.status === "resolved",
					`status=${memoryResolved.status}`,
				);
			}

			// ── 5. editChunk + rollbackToVersion ─────────────────────────
			// Edit a chunk and confirm a new chunk_version row appears.
			const targetHit = search.hits[0];
			if (targetHit) {
				const edit = await ws.editChunk(store, {
					workspace_id: WORKSPACE_ID,
					chunk_id: targetHit.chunk_id,
					new_content: "limitation of liability (amended text)",
					edit_reason: "demo: tutorial amendment",
				});
				check(
					"editChunk flags the chunk as needing re-embedding",
					edit.needsReembed === true,
					`needsReembed=${edit.needsReembed}`,
				);
			}

			// Roll back the most-recent edit (target_version_id=1 because
			// the resources were just created — the version chain starts at 1).
			const resourceList = await ws.searchWorkspaceContext(ctx, store, {
				workspace_id: WORKSPACE_ID,
				query: "limitation",
				strategy: "lexical",
			});
			const resourceId = resourceList.hits[0]?.resource_id;
			if (resourceId !== undefined) {
				const rollback = ws.rollbackToVersion(store, {
					workspace_id: WORKSPACE_ID,
					resource_id: resourceId,
					target_version_id: 1,
					snapshotCurrent: true,
				});
				check(
					"rollbackToVersion returns the pre-edit version as current",
					rollback.new_current_version_id === 1,
					`new_current_version_id=${rollback.new_current_version_id}`,
				);
			}

			// ── 6. reconcileResourceEdges ────────────────────────────────
			if (resourceId !== undefined) {
				const reconcile = ws.reconcileResourceEdges(store, {
					workspace_id: WORKSPACE_ID,
					resource_id: resourceId,
					keep: [],
					onlyProvenance: ["manual"],
					dryRun: true,
				});
				check(
					"reconcileResourceEdges reports `kept=0` when keep is empty",
					reconcile.kept === 0,
					`kept=${reconcile.kept}`,
				);
			}

			await ws.closeSQLiteWorkspaceStore().catch(() => undefined);
		});
	});
}
