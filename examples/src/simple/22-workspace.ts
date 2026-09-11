/**
 * demo: @melandlabs/workspace — folder indexing + cross-file hybrid search.
 *
 * `@melandlabs/workspace` indexes a local folder of Markdown / TXT / PDF /
 * DOCX / Pages files into a SQLite-backed knowledge space. It exposes
 * three core APIs:
 *
 *   - `updateWorkspaceContext` — scan + chunk + index a folder
 *   - `searchWorkspaceContext` — lexical / semantic / hybrid / cross-file
 *   - `listWorkspaceResources` — enumerate indexed resources
 *
 * `EMBEDDING_PROVIDER` defaults to `local` here (384-dim
 * `Xenova/all-MiniLM-L6-v2`, runs in-process via `@huggingface/transformers`).
 * No `OPENROUTER_API_KEY` needed. Override with `EMBEDDING_PROVIDER=cloud`
 * for the 1536-dim OpenRouter path.
 *
 * First-run cost: ~30 MB of ONNX weights are pulled from HuggingFace and
 * cached globally. Subsequent runs reuse the cache.
 *
 * This demo also exercises the workspace CLI surface end-to-end
 * (`opencontext workspace update/search/list`) via the same JS API so
 * the printed JSON envelope mirrors what the CLI prints.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
	RuntimeContext,
	SearchWorkspaceContextResult,
	UpdateWorkspaceContextResult,
	WorkspaceSearchHit,
} from "@melandlabs/opencontext";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

const WORKSPACE_ID = "demo-workspace";
const USER_ID = "demo-user";
const SETTLE_MS = 15_000; // give the embedding queue time to drain on first run

// Earlier demos in the suite may have poked `process.env.EMBEDDING_PROVIDER`
// (e.g. `examples/src/simple/14-local-embedding.ts` toggles it for the
// factory routing check). Force `local` here so the workspace demo never
// accidentally rides a stray env value into the cloud path.
const PREVIOUS_PROVIDER_ENV = process.env.EMBEDDING_PROVIDER;
process.env.EMBEDDING_PROVIDER = "local";

// Workspace value imports are pulled in dynamically so the smoke test
// (which pulls @melandlabs/opencontext from npm without the optional
// @melandlabs/workspace peer) can skip this demo cleanly instead of
// crashing the bootstrap with `ERR_MODULE_NOT_FOUND`.
type WorkspaceModule = {
	closeSQLiteWorkspaceStore: () => Promise<void>;
	getSQLiteWorkspaceStore: (options: { dbPath: string }) => Promise<unknown>;
	listWorkspaceResources: (
		ctx: RuntimeContext,
		store: unknown,
		input: { workspace_id: string },
	) => Promise<{ resources: unknown[]; total: number }>;
	resolveWorkspaceDbPath: (override?: string) => string;
	searchWorkspaceContext: (
		ctx: RuntimeContext,
		store: unknown,
		input: {
			workspace_id: string;
			query: string;
			strategy: string;
			options?: Record<string, unknown>;
		},
	) => Promise<SearchWorkspaceContextResult>;
	updateWorkspaceContext: (
		ctx: RuntimeContext,
		store: unknown,
		input: { workspace_id: string; source: string; path: string },
	) => Promise<UpdateWorkspaceContextResult>;
};

let _workspaceCache: WorkspaceModule | undefined;
async function loadWorkspace(): Promise<WorkspaceModule | null> {
	if (_workspaceCache) return _workspaceCache;
	try {
		// @ts-expect-error -- optional workspace subpath; may be absent
		// (e.g. in the npm-installed smoke test environment).
		const mod = (await import("@melandlabs/workspace")) as WorkspaceModule;
		_workspaceCache = mod;
		return mod;
	} catch {
		return null;
	}
}

function makeRuntimeContext(): RuntimeContext {
	return {
		user_id: USER_ID,
		employee_id: "demo-employee",
		session_id: "demo-session",
		request_id: randomUUID(),
	};
}

// Fixture lives on disk at examples/fixtures/workspace-wiki/. The demo
// copies each file into a tmp directory before running so every run starts
// from a clean slate — the same fixtures also back the workspace tutorial.
const FIXTURE_FILES = ["a.md", "b.md", "law-clause.md"] as const;

function resolveFixtureDir(): string {
	// examples/src/simple/22-workspace.ts → examples/fixtures/workspace-wiki
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..", "..", "fixtures", "workspace-wiki");
}

async function buildFixture(dir: string): Promise<void> {
	const wikiDir = join(dir, "wiki");
	await mkdir(wikiDir, { recursive: true });
	const sourceDir = resolveFixtureDir();
	for (const name of FIXTURE_FILES) {
		await copyFile(join(sourceDir, name), join(wikiDir, name));
	}
}

async function settleEmbeddings(): Promise<void> {
	// The embedding queue runs in the same process; sleeping is the
	// simplest portable way to let it drain before we issue the hybrid /
	// cross-file search. The lexical pass doesn't need to wait at all.
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function topHit(result: SearchWorkspaceContextResult): WorkspaceSearchHit | undefined {
	return result.hits[0];
}

export default async function demoWorkspace() {
	await runSection("demo: @melandlabs/workspace (folder indexing + cross-file search)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/workspace");

		const ws = await loadWorkspace();
		if (!ws) {
			skip(
				"@melandlabs/workspace is installed",
				"optional peer dep — npm-installed smoke test environment skips this demo",
			);
			return;
		}

		// Restore whatever was in EMBEDDING_PROVIDER before this demo so
		// subsequent demos don't see `local` stuck on.
		const restoreEnv = () => {
			if (PREVIOUS_PROVIDER_ENV === undefined) {
				// biome-ignore lint/performance/noDelete: env-reset pattern
				delete process.env.EMBEDDING_PROVIDER;
			} else {
				process.env.EMBEDDING_PROVIDER = PREVIOUS_PROVIDER_ENV;
			}
		};

		await withTmp("workspace", async (dir) => {
			await buildFixture(dir);

			const dbPath = join(dir, "workspace.db");
			const store = await ws.getSQLiteWorkspaceStore({ dbPath });
			const ctx = makeRuntimeContext();

			// 1. updateWorkspaceContext — synchronous chunking + async fan-out.
			let update: UpdateWorkspaceContextResult;
			try {
				update = await ws.updateWorkspaceContext(ctx, store, {
					workspace_id: WORKSPACE_ID,
					source: "okf_folder",
					path: join(dir, "wiki"),
				});
			} catch (err) {
				check("updateWorkspaceContext runs without throwing", false, (err as Error).message);
				return;
			}

			check(
				"updateWorkspaceContext returns ok with files_scanned ≥ 3",
				update.filesScanned >= 3,
				`filesScanned=${update.filesScanned}, filesAdded=${update.filesAdded}`,
			);
			check(
				"updateWorkspaceContext flags the 3 new files as added",
				update.filesAdded >= 3,
				`filesAdded=${update.filesAdded}`,
			);
			check("updateWorkspaceContext returns a positive jobId", update.jobId > 0, `jobId=${update.jobId}`);
			info(
				"demo/workspace",
				`updateWorkspaceContext → jobId=${update.jobId}, status=${update.status}, ` +
					`scanned=${update.filesScanned}, added=${update.filesAdded}, modified=${update.filesModified}`,
			);

			// 2. listWorkspaceResources — every fixture file appears.
			const listed = await ws.listWorkspaceResources(ctx, store, {
				workspace_id: WORKSPACE_ID,
			});
			check(
				"listWorkspaceResources returns ≥ 3 resources for the fixture folder",
				listed.resources.length >= 3,
				`total=${listed.total}, resources=${listed.resources.map((r) => r.canonical_key).join(", ")}`,
			);

			// 3. Lexical search — works synchronously, FTS5 was filled in
			//    during the sync chunk phase. This is the only strategy
			//    that is guaranteed to work even before embeddings finish.
			const lexicalResult = await ws.searchWorkspaceContext(ctx, store, {
				workspace_id: WORKSPACE_ID,
				query: "limitation",
				strategy: "lexical",
				options: { limit: 5 },
			});
			check(
				"lexical search for 'limitation' returns ≥ 1 hit",
				lexicalResult.hits.length >= 1,
				`total=${lexicalResult.total}`,
			);
			check(
				"lexical search marks strategy as 'lexical'",
				lexicalResult.strategy === "lexical",
				lexicalResult.strategy,
			);
			info(
				"demo/workspace",
				`lexical[0] → ${topHit(lexicalResult)?.resource_title} (score=${topHit(lexicalResult)?.score.toFixed(4)})`,
			);

			// 4. Give the embedding queue a moment to drain, then try
			//    semantic + cross-file. If the local model fails to load
			//    (no network, fresh CI runner) the queue ends in `partial`
			//    and we skip those checks instead of failing.
			await settleEmbeddings();

			let semanticResult: SearchWorkspaceContextResult | undefined;
			try {
				semanticResult = await ws.searchWorkspaceContext(ctx, store, {
					workspace_id: WORKSPACE_ID,
					query: "what is the cap on liability",
					strategy: "semantic",
					options: { limit: 3 },
				});
			} catch (err) {
				const message = (err as Error).message.split("\n")[0];
				// biome-ignore lint/suspicious/noConsole: surface the failure on stderr for debugging
				console.error(`[demo/workspace] semantic search failed: ${message}`);
				skip("semantic search runs", "embedding provider failed: " + message);
			}
			if (semanticResult !== undefined) {
				if (semanticResult.hits.length === 0) {
					skip(
						"semantic search returns hits once embeddings have been written",
						"embedding queue drained with 0 rows (network or model load failure?)",
					);
				} else {
					check(
						"semantic search returns ≥ 1 hit once embeddings are written",
						semanticResult.hits.length >= 1,
						`total=${semanticResult.total}`,
					);
					check(
						"semantic search marks strategy as 'semantic'",
						semanticResult.strategy === "semantic",
						semanticResult.strategy,
					);
					info(
						"demo/workspace",
						`semantic[0] → ${topHit(semanticResult)?.resource_title} (score=${topHit(semanticResult)?.score.toFixed(4)})`,
					);
				}
			}

			// 5. Cross-file — hybrid + 1-hop BFS over cites edges. Expect
			//    hits from both `a.md` and the `b.md` it cites.
			let crossFileResult: SearchWorkspaceContextResult | undefined;
			try {
				crossFileResult = await ws.searchWorkspaceContext(ctx, store, {
					workspace_id: WORKSPACE_ID,
					query: "limitation",
					strategy: "cross-file",
					options: { limit: 5, hops: 1 },
				});
			} catch (err) {
				const message = (err as Error).message.split("\n")[0];
				// biome-ignore lint/suspicious/noConsole: surface the failure on stderr for debugging
				console.error(`[demo/workspace] cross-file search failed: ${message}`);
				skip("cross-file search runs", "embedding provider failed: " + message);
			}
			if (crossFileResult !== undefined) {
				if (crossFileResult.hits.length === 0) {
					skip(
						"cross-file search returns hits",
						"no hits — embeddings never finished (network or model load failure)",
					);
				} else {
					const titles = new Set(crossFileResult.hits.map((h) => h.resource_title));
					check(
						"cross-file search returns ≥ 2 hits (seed + 1-hop cite neighbour)",
						crossFileResult.hits.length >= 2,
						`total=${crossFileResult.total}, titles=${[...titles].join(", ")}`,
					);
					check(
						"cross-file expansion surfaces both `a` and `b` via the cites edge",
						titles.has("a") && titles.has("b"),
						`titles=${[...titles].join(", ")}`,
					);
					const hitsWithEdges = crossFileResult.hits.filter((h) => h.reference_edges.length > 0);
					check(
						"at least one cross-file hit carries reference_edges (cites graph)",
						hitsWithEdges.length >= 1,
						`${hitsWithEdges.length} hit(s) with edges`,
					);
					info(
						"demo/workspace",
						`cross-file → ${crossFileResult.total} hits across ${titles.size} files: ${[...titles].join(", ")}`,
					);
				}
			}

			// 6. Re-run update — every file should now be `unchanged`.
			const reUpdate = await ws.updateWorkspaceContext(ctx, store, {
				workspace_id: WORKSPACE_ID,
				source: "okf_folder",
				path: join(dir, "wiki"),
			});
			check(
				"re-running update reports every file as `unchanged` (sha256 dedup)",
				reUpdate.filesUnchanged >= 3 && reUpdate.filesAdded === 0,
				`unchanged=${reUpdate.filesUnchanged}, added=${reUpdate.filesAdded}`,
			);

			// 7. resolveWorkspaceDbPath defaults to ~/.opencontext/memory/store.db
			//    and the override here is honoured.
			check(
				"resolveWorkspaceDbPath returns the path we passed in",
				ws.resolveWorkspaceDbPath(dbPath) === dbPath,
				ws.resolveWorkspaceDbPath(dbPath),
			);

			await ws.closeSQLiteWorkspaceStore().catch(() => undefined);
			restoreEnv();
		});
	});
}
