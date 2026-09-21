/**
 * `@melandlabs/workspace` — OKF folder backend.
 *
 * Wires the multi-format text extractor to `SqliteWorkspaceStore.indexResource`
 * and the OKF graph builder to `SqliteWorkspaceStore.upsertReferenceEdges`.
 *
 * Edge sources (v2):
 *   1. In-body `[label](./target.md)` markdown links  → provenance
 *      `{ source: "okf_link_resolver", run_id }`, edge_type `cites`.
 *   2. Front-matter `links:` blocks (cites/supersedes/amends/relates-to)
 *      → provenance `{ source: "okf_frontmatter", run_id }`, edge_type
 *      carried through from the YAML.
 *
 * Both pass through `upsertReferenceEdges`, so manual edge edits and
 * later LLM-distilled edges don't conflict on import runs.
 */

import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { extname } from "node:path";
import { type WikiGraph, type WikiNode, buildGraphFromDir } from "@melandlabs/okf";
import { extractText } from "./parsers-adapter";
import type { SqliteWorkspaceStore } from "./sqlite";
import type { OkfFolderResource, UpdateWorkspaceContextResult, WorkspaceEdgeType } from "./types";

/**
 * Lightweight markdown link extractor for extracted text bodies.
 * Mirrors what `buildGraphFromDir` does for raw .md files: find every
 * `[label](./relative/path.md)` style reference and resolve it to a
 * canonical key relative to the source file's directory.
 */
function extractMarkdownLinksFromText(
	text: string,
	sourceCanonical: string,
): Array<{ source: string; target: string }> {
	const links: Array<{ source: string; target: string }> = [];
	const re = /\]\(\.\/([^)\s]+\.md)(?:#[^)]*)?\)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const sourceDir = sourceCanonical.includes("/")
			? sourceCanonical.slice(0, sourceCanonical.lastIndexOf("/"))
			: "";
		const targetCanonical = sourceDir ? `${sourceDir}/${match[1]}` : match[1];
		links.push({ source: sourceCanonical, target: targetCanonical });
	}
	return links;
}

/**
 * File extensions the bulk folder walk indexes. Exported so live
 * watchers (e.g. alloomi's project watcher) can gate on exactly the set
 * the walk will reconcile against — a file the walk never sees is
 * soft-deleted at the next reconcile's present-key check.
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
	".md",
	".markdown",
	".txt",
	".html",
	".htm",
	".csv",
	".pdf",
	".docx",
	".xlsx",
	".xls",
	".numbers",
	".pages",
	".keynote",
]);

/**
 * Non-hidden directory names the bulk walk never descends into —
 * dependency / cache trees whose text files (README.md, LICENSE.txt, …)
 * would otherwise drown the workspace index in noise.
 */
export const DEFAULT_IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	"__pycache__",
	"venv",
]);

/**
 * Maximum source-file size the bulk walk will attempt to extract. Files
 * larger than this are skipped with a warning — parsing a multi-hundred-MB
 * document dominates reconcile cost and blows up memory for zero useful
 * recall. Skipped files never enter the reconcile's `presentKeys`, so a
 * file that was indexed before it grew past the cap is soft-deleted on
 * the next reconcile; shrink it back under the cap and a later reconcile
 * resurrects it.
 */
export const OKF_MAX_EXTRACT_BYTES = 32 * 1024 * 1024;

export interface OkfFolderWalkOptions {
	/**
	 * Extra directory names to skip at every level, on top of the
	 * dot-directory rule (always applied) and
	 * {@link DEFAULT_IGNORED_DIR_NAMES}.
	 */
	ignoreDirNames?: ReadonlySet<string>;
}

/**
 * One walkable candidate file: absolute path plus the stat fields the
 * reconcile fast path compares against the store. Produced by
 * {@link walkOkfFolderEntries} without any text extraction.
 */
export interface OkfFolderWalkEntry {
	absolute: string;
	canonicalKey: string;
	size: number;
	mtimeMs: number;
}

function isSkippedWalkDir(name: string, options?: OkfFolderWalkOptions): boolean {
	if (name.startsWith(".")) return true;
	if (DEFAULT_IGNORED_DIR_NAMES.has(name)) return true;
	return options?.ignoreDirNames?.has(name) ?? false;
}

async function walk(dir: string, options?: OkfFolderWalkOptions): Promise<string[]> {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const head = stack.pop();
		if (!head) break;
		let entries: import("node:fs").Dirent[];
		try {
			entries = (await readdir(head, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(head, entry.name);
			if (entry.isDirectory()) {
				if (!isSkippedWalkDir(entry.name, options)) stack.push(full);
			} else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
				out.push(full);
			}
		}
	}
	return out;
}

/**
 * Walk `dir` and stat every supported file WITHOUT extracting text.
 * Returns the candidate entries (`walk` + `stat` only) so reconciles can
 * compare mtime/size against the store before paying for extraction.
 * Files over {@link OKF_MAX_EXTRACT_BYTES} are skipped here with a
 * warning, as are files that vanish between `readdir` and `stat`.
 */
async function walkOkfFolderEntries(
	dir: string,
	options?: OkfFolderWalkOptions,
): Promise<OkfFolderWalkEntry[]> {
	const files = await walk(dir, options);
	const entries: OkfFolderWalkEntry[] = [];
	for (const absolute of files) {
		try {
			const statResult = await stat(absolute);
			if (statResult.size > OKF_MAX_EXTRACT_BYTES) {
				// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
				console.warn(
					`[workspace/okf] skipping ${absolute}: ${statResult.size} bytes exceeds OKF_MAX_EXTRACT_BYTES (${OKF_MAX_EXTRACT_BYTES})`,
				);
				continue;
			}
			const canonicalKey = relative(dir, absolute).split(sep).join("/");
			entries.push({ absolute, canonicalKey, size: statResult.size, mtimeMs: statResult.mtimeMs });
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
			console.warn(`[workspace/okf] failed to stat ${absolute}:`, error);
		}
	}
	return entries;
}

/**
 * Resource-type tag stamped onto `workspace_resources.resource_type`,
 * keyed by lower-cased extension. Exported so live watchers stamp the
 * same vocabulary the bulk walk writes.
 */
export function resourceTypeForExtension(ext: string): string {
	switch (ext) {
		case ".md":
		case ".markdown":
		case ".txt":
		case ".csv":
			return "note";
		case ".html":
		case ".htm":
			return "html";
		case ".pdf":
		case ".docx":
			return "document";
		case ".xlsx":
		case ".xls":
		case ".numbers":
			return "spreadsheet";
		case ".pages":
		case ".keynote":
			return "document";
		default:
			return "document";
	}
}

/**
 * List every supported file under `dir`, parse it, and return the
 * `OkfFolderResource[]` shape that `indexResource` consumes. Errors
 * per-file are swallowed (logged via stderr) so one broken file doesn't
 * abort the whole scan. Dot-directories, dependency dirs
 * ({@link DEFAULT_IGNORED_DIR_NAMES}), and any `ignoreDirNames` are not
 * descended into.
 */
export async function listOkfFolderResources(
	dir: string,
	options?: OkfFolderWalkOptions,
): Promise<OkfFolderResource[]> {
	const entries = await walkOkfFolderEntries(dir, options);
	const results: OkfFolderResource[] = [];
	for (const entry of entries) {
		try {
			const extracted = await extractText(entry.absolute);
			const ext = extname(entry.absolute).toLowerCase();
			const resourceType = ext === ".md" || ext === ".markdown" ? "note" : resourceTypeForExtension(ext);
			results.push({
				canonical_key: entry.canonicalKey,
				absolute_path: entry.absolute,
				title: entry.canonicalKey.replace(/\.[^.]+$/, ""),
				resource_type: resourceType,
				body: extracted.text,
				size_bytes: entry.size,
				source_mtime: entry.mtimeMs,
			});
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
			console.warn(`[workspace/okf] failed to read ${entry.absolute}:`, error);
		}
	}
	return results;
}

/**
 * Walk an OKF folder, index every file, then build the `cites` edge
 * graph from the markdown-link resolver and persist it.
 *
 * The job id is created up-front so the embedding queue can attach
 * completion / failure to it.
 *
 * Reconcile fast path: files whose stored `source_mtime` + `size_bytes`
 * match the on-disk stat skip `extractText` entirely — the previous
 * implementation re-extracted every file on every reconcile, which made
 * boot reconcile of large folders (thousands of files / hundreds of MB)
 * dominate startup. An mtime+size hit is trusted the way git / rsync
 * trust it: a content edit that deliberately preserves both (e.g.
 * same-length rewrite with a reset mtime) is NOT detected until the
 * file's mtime or size changes. Live watcher writes still go through
 * per-file sha256 dedup in `indexResource`, so their semantics are
 * unchanged.
 */
export async function indexOkfFolder(
	store: SqliteWorkspaceStore,
	input: {
		workspace_id: string;
		user_id: string;
		path: string;
		enqueueEmbedding: (input: { resource_id: number; version_id: number; jobId?: number }) => Promise<void>;
		/** Extra directory names for the walk to skip (see {@link OkfFolderWalkOptions}). */
		ignoreDirNames?: ReadonlySet<string>;
	},
): Promise<UpdateWorkspaceContextResult> {
	const entries = await walkOkfFolderEntries(input.path, {
		ignoreDirNames: input.ignoreDirNames,
	});
	const freshness = store.getOkfSourceFreshness({ workspace_id: input.workspace_id });

	const presentKeys = new Set<string>();
	let filesAdded = 0;
	let filesModified = 0;
	let filesUnchanged = 0;

	// Fast-path split: entries whose canonical key, size, and mtime all
	// match the store are known-unchanged — count them, mark them present,
	// and skip extraction + indexing + embedding enqueue. Soft-deleted
	// rows are absent from the freshness map (see getOkfSourceFreshness),
	// so a file that returns after being deleted always takes the full
	// path and gets resurrected by indexResource.
	const toIndex: OkfFolderWalkEntry[] = [];
	for (const entry of entries) {
		const fresh = freshness.get(entry.canonicalKey);
		if (fresh && fresh.size_bytes === entry.size && fresh.source_mtime === entry.mtimeMs) {
			filesUnchanged += 1;
			presentKeys.add(entry.canonicalKey);
			continue;
		}
		toIndex.push(entry);
	}

	const job = store.createJob({ workspace_id: input.workspace_id, kind: "index", total: toIndex.length });

	const indexedIds: Array<{ resource_id: number; version_id: number; canonical_key: string }> = [];

	// Map of canonical_key → extracted body for non-.md files so we
	// can mine markdown links from extracted text. (.md files are
	// already covered by buildGraphFromDir below.) Only newly extracted
	// bodies appear here: fast-path files are unchanged by definition,
	// so their mined edges are already persisted from an earlier run.
	const bodyByCanonical = new Map<string, string>();

	let indexedCount = 0;
	for (const entry of toIndex) {
		let body: string;
		try {
			body = (await extractText(entry.absolute)).text;
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
			console.warn(`[workspace/okf] failed to read ${entry.absolute}:`, error);
			continue;
		}
		const ext = extname(entry.absolute).toLowerCase();
		const resource: OkfFolderResource = {
			canonical_key: entry.canonicalKey,
			absolute_path: entry.absolute,
			title: entry.canonicalKey.replace(/\.[^.]+$/, ""),
			resource_type: ext === ".md" || ext === ".markdown" ? "note" : resourceTypeForExtension(ext),
			body,
			size_bytes: entry.size,
			source_mtime: entry.mtimeMs,
		};
		presentKeys.add(resource.canonical_key);
		const result = await store.indexResource({
			workspace_id: input.workspace_id,
			user_id: input.user_id,
			resource,
		});
		indexedIds.push({
			resource_id: result.resource_id,
			version_id: result.version_id,
			canonical_key: resource.canonical_key,
		});
		if (result.change_kind === "created") filesAdded += 1;
		else if (result.change_kind === "modified") filesModified += 1;
		else filesUnchanged += 1;
		indexedCount += 1;
		await input.enqueueEmbedding({
			resource_id: result.resource_id,
			version_id: result.version_id,
			jobId: job.id,
		});
		if (ext !== ".md") bodyByCanonical.set(resource.canonical_key, body);
	}
	// Extraction failures above never reach indexResource, so the job
	// total tracks successfully indexed files (matches pre-fast-path
	// semantics where listOkfFolderResources had already swallowed them).
	store.updateJobTotal(job.id, indexedCount);

	// Edge pass: rebuild cites edges from BOTH the on-disk markdown
	// graph (via buildGraphFromDir) AND from markdown links inside
	// extracted text bodies of non-.md files (PDF / DOCX / XLSX).
	let graph: WikiGraph;
	try {
		graph = await buildGraphFromDir(input.path);
	} catch (error) {
		// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
		console.warn(`[workspace/okf] buildGraphFromDir failed for ${input.path}:`, error);
		graph = { nodes: [], edges: [], types: [], generatedAt: new Date().toISOString(), root: input.path };
	}
	// Resource ids for edge endpoints come from BOTH the freshness map
	// (fast-path files) and this run's indexResource results — an
	// unchanged .md file's outgoing links must still resolve.
	const idByCanonical = new Map<string, number>();
	for (const entry of entries) {
		const fresh = freshness.get(entry.canonicalKey);
		if (fresh) idByCanonical.set(entry.canonicalKey, fresh.resource_id);
	}
	const canonicalByResourceId = new Map<number, string>();
	for (const indexed of indexedIds) {
		idByCanonical.set(indexed.canonical_key, indexed.resource_id);
		canonicalByResourceId.set(indexed.resource_id, indexed.canonical_key);
	}

	const wikiEdges: Array<{
		source_resource_id: number;
		target_resource_id: number;
		edge_type: WorkspaceEdgeType;
		quote?: string | null;
		provenance: import("./types").EdgeProvenance;
	}> = [];
	const seen = new Set<string>();
	const runId = `okf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const resolvedAt = Math.floor(Date.now() / 1000);
	const addEdge = (
		sourceId: number,
		targetId: number,
		edgeType: WorkspaceEdgeType,
		provenance: import("./types").EdgeProvenance,
		quote?: string,
	) => {
		const key = `${sourceId}->${targetId}->${edgeType}`;
		if (seen.has(key)) return;
		seen.add(key);
		wikiEdges.push({
			source_resource_id: sourceId,
			target_resource_id: targetId,
			edge_type: edgeType,
			quote: quote ?? null,
			provenance,
		});
	};

	// (a) Links discovered by buildGraphFromDir on raw .md files —
	// both in-body markdown links AND front-matter `links:` blocks.
	for (const edge of graph.edges) {
		const sourceCanonical = `${edge.source}.md`;
		const targetCanonical = `${edge.target}.md`;
		const sourceId = idByCanonical.get(sourceCanonical);
		const targetId = idByCanonical.get(targetCanonical);
		if (sourceId === undefined || targetId === undefined) continue;
		const edgeType: WorkspaceEdgeType = edge.edge_type ?? "cites";
		// Determine provenance by inspecting whether the edge came from
		// body or front-matter. We can't tell at this point, so default
		// to link_resolver; callers that need frontmatter-level
		// distinction should pass edge metadata in via WikiGraph.
		const provenance: import("./types").EdgeProvenance = {
			source: "okf_link_resolver",
			run_id: runId,
			resolved_at: resolvedAt,
		};
		addEdge(sourceId, targetId, edgeType, provenance, edge.quote);
	}

	// (b) Links discovered inside extracted text of non-.md files
	// (PDF / DOCX / XLSX). These are always in-body links, never
	// front-matter — provenance remains `okf_link_resolver`.
	for (const [sourceCanonical, body] of bodyByCanonical) {
		const sourceId = idByCanonical.get(sourceCanonical);
		if (sourceId === undefined) continue;
		for (const link of extractMarkdownLinksFromText(body, sourceCanonical)) {
			const targetId = idByCanonical.get(link.target);
			if (targetId === undefined) continue;
			addEdge(sourceId, targetId, "cites", {
				source: "okf_link_resolver",
				run_id: runId,
				resolved_at: resolvedAt,
			});
		}
	}

	if (wikiEdges.length > 0) {
		store.upsertReferenceEdges({
			workspace_id: input.workspace_id,
			edges: wikiEdges.map((edge) => ({
				...edge,
				source_version_id: null,
				target_version_id: null,
			})),
		});
	}

	// Soft-delete detection: any canonical key not in `presentKeys` and
	// not already marked `deleted_at` is flipped to soft-deleted.
	const deleted = store.softDeleteMissingResources({
		workspace_id: input.workspace_id,
		presentKeys,
	});

	return {
		jobId: job.id,
		triggered: true,
		status: "pending",
		filesScanned: entries.length,
		filesAdded,
		filesModified,
		filesUnchanged,
		filesDeleted: deleted.length,
	};
}

/**
 * Cheap helper used by callers that only need the wiki node titles
 * (e.g. the indexer's title enrichment). Mirrors `buildGraphFromDir`'s
 * node shape but stops short of the full edge / backlink pass.
 */
export async function readOkfFolderTitles(dir: string): Promise<WikiNode[]> {
	const graph = await buildGraphFromDir(dir);
	return graph.nodes;
}
