/**
 * `@melandlabs/workspace` — OKF folder backend.
 *
 * Wires the multi-format text extractor to `SqliteWorkspaceStore.indexResource`
 * and the OKF graph builder to `SqliteWorkspaceStore.upsertReferenceEdges`.
 *
 * Only `cites` edges are written (the markdown-link resolver in
 * `buildGraphFromDir`). `supersedes` / `amends` / `relates-to` are
 * reserved in the schema enum but never produced here.
 */

import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { extname } from "node:path";
import { type WikiGraph, type WikiNode, buildGraphFromDir } from "@melandlabs/okf";
import { extractText } from "./parsers-adapter";
import type { SqliteWorkspaceStore } from "./sqlite";
import type { OkfFolderResource, UpdateWorkspaceContextResult, WorkspaceEdgeType } from "./types";

const SUPPORTED_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt",
	".pdf",
	".docx",
	".xlsx",
	".xls",
	".numbers",
	".pages",
]);

async function walk(dir: string): Promise<string[]> {
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
				stack.push(full);
			} else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
				out.push(full);
			}
		}
	}
	return out;
}

function resourceTypeForExtension(ext: string): string {
	switch (ext) {
		case ".md":
		case ".markdown":
			return "note";
		case ".txt":
			return "note";
		case ".pdf":
			return "document";
		case ".docx":
			return "document";
		case ".xlsx":
		case ".xls":
		case ".numbers":
			return "spreadsheet";
		case ".pages":
			return "document";
		default:
			return "document";
	}
}

/**
 * List every supported file under `dir`, parse it, and return the
 * `OkfFolderResource[]` shape that `indexResource` consumes. Errors
 * per-file are swallowed (logged via stderr) so one broken file doesn't
 * abort the whole scan.
 */
export async function listOkfFolderResources(dir: string): Promise<OkfFolderResource[]> {
	const files = await walk(dir);
	const results: OkfFolderResource[] = [];
	for (const absolute of files) {
		try {
			const extracted = await extractText(absolute);
			const ext = extname(absolute).toLowerCase();
			const canonical = relative(dir, absolute).split(sep).join("/");
			const statResult = await stat(absolute);
			const resourceType = ext === ".md" || ext === ".markdown" ? "note" : resourceTypeForExtension(ext);
			results.push({
				canonical_key: canonical,
				absolute_path: absolute,
				title: canonical.replace(/\.[^.]+$/, ""),
				resource_type: resourceType,
				body: extracted.text,
				size_bytes: statResult.size,
			});
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
			console.warn(`[workspace/okf] failed to read ${absolute}:`, error);
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
 */
export async function indexOkfFolder(
	store: SqliteWorkspaceStore,
	input: {
		workspace_id: string;
		user_id: string;
		path: string;
		enqueueEmbedding: (input: { resource_id: number; version_id: number; jobId?: number }) => Promise<void>;
	},
): Promise<UpdateWorkspaceContextResult> {
	const resources = await listOkfFolderResources(input.path);
	const job = store.createJob({ workspace_id: input.workspace_id, kind: "index", total: resources.length });
	store.updateJobTotal(job.id, resources.length);

	const presentKeys = new Set<string>();
	let filesAdded = 0;
	let filesModified = 0;
	let filesUnchanged = 0;

	const indexedIds: Array<{ resource_id: number; version_id: number; canonical_key: string }> = [];

	for (const resource of resources) {
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
		await input.enqueueEmbedding({
			resource_id: result.resource_id,
			version_id: result.version_id,
			jobId: job.id,
		});
	}

	// Edge pass: rebuild cites edges from the on-disk graph so a rename /
	// delete in the OKF folder immediately reflects in the index.
	let graph: WikiGraph;
	try {
		graph = await buildGraphFromDir(input.path);
	} catch (error) {
		// biome-ignore lint/suspicious/noConsole: server-side warning surfaced to ops
		console.warn(`[workspace/okf] buildGraphFromDir failed for ${input.path}:`, error);
		graph = { nodes: [], edges: [], types: [], generatedAt: new Date().toISOString(), root: input.path };
	}
	const idByCanonical = new Map<string, number>();
	const canonicalByResourceId = new Map<number, string>();
	for (const indexed of indexedIds) {
		idByCanonical.set(indexed.canonical_key, indexed.resource_id);
		canonicalByResourceId.set(indexed.resource_id, indexed.canonical_key);
	}
	const wikiEdges: Array<{
		source_resource_id: number;
		target_resource_id: number;
		edge_type: WorkspaceEdgeType;
	}> = [];
	for (const edge of graph.edges) {
		const sourceCanonical = `${edge.source}.md`;
		const targetCanonical = `${edge.target}.md`;
		const sourceId = idByCanonical.get(sourceCanonical);
		const targetId = idByCanonical.get(targetCanonical);
		if (sourceId === undefined || targetId === undefined) continue;
		wikiEdges.push({ source_resource_id: sourceId, target_resource_id: targetId, edge_type: "cites" });
	}
	if (wikiEdges.length > 0) {
		store.upsertReferenceEdges({
			workspace_id: input.workspace_id,
			edges: wikiEdges.map((edge) => ({ ...edge, source_version_id: null, target_version_id: null })),
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
		filesScanned: resources.length,
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
