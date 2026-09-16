/**
 * OKF → WikiGraph adapter.
 *
 * Builds the `WikiGraph` JSON shape served at `GET /api/graph` and
 * consumed by the opencontext viewer (`src/viewer/`). The shape is
 * the canonical OKF knowledge-graph contract — every OKF viewer
 * implementation can read it.
 *
 * Two entry points:
 *   - `buildGraphFromMessages` — live mode: query `RawMessage`s from
 *     the memory store and build the graph in-memory.
 *   - `buildGraphFromDir` — frozen mode: read a previously-emitted
 *     OKF package directory (Knowledge Package) and build the
 *     same graph.
 *
 * Both produce a `WikiGraph` that lists every node, its type,
 * outgoing links (resolved against known node ids), and incoming
 * backlinks (filled in a single reverse pass to avoid O(N²)).
 */

import { sep } from "node:path";
import type { RawMessage } from "@melandlabs/indexeddb";
import { rawMessageToOkf } from "./codec.js";
import { readOkfPackage } from "./package.js";

/** A single page, as one node in the graph. */
export interface WikiNode {
	id: string;
	title: string;
	type: string;
	description: string;
	tags: string[];
	body: string;
	size: number;
	links: string[];
	backlinks: string[];
}

/** A directed link from one page to another. */
export interface WikiEdge {
	source: string;
	target: string;
	/**
	 * Optional edge type from the OKF front-matter `links:` block
	 * (defaults to `cites` when absent). Front-matter-resolved edges
	 * are tagged with this so `WorkspaceReferenceEdge` can preserve
	 * `supersedes` / `amends` / `relates-to` intent across ingestion.
	 */
	edge_type?: "cites" | "supersedes" | "amends" | "relates-to";
	/** Optional quote / context for the link, sourced from front-matter. */
	quote?: string;
}

/** The complete in-memory graph served at `/api/graph`. */
export interface WikiGraph {
	/** Basename of the wiki root directory, shown in the page header. */
	root: string;
	/** ISO-8601 timestamp of when this graph was built. */
	generatedAt: string;
	/** All distinct node types present, sorted, for the legend. */
	types: string[];
	/** Every page in the wiki. */
	nodes: WikiNode[];
	/** Every resolved directed link between pages. */
	edges: WikiEdge[];
}

const MARKDOWN_LINK = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;

/** Pull relative markdown link targets `[label](target.md)` from a body. */
function extractMarkdownLinkTargets(body: string): string[] {
	return [...body.matchAll(MARKDOWN_LINK)].map((match) => match[1]);
}

/** Sanitise an OKF `type` into a traversal-safe folder name. */
function sanitizeTypeFolder(type: string): string {
	const segment = type.split(/[\\/]/).pop() ?? "";
	const cleaned = segment.replace(/^\.+/, "");
	return cleaned.length > 0 ? cleaned.slice(0, 128) : "Reference";
}

/** Strip the leading `# title` heading line from a body. */
function stripTitleHeading(body: string): string {
	const m = body.match(/^#\s+(.+?)\s*\n/);
	return m ? body.slice(m[0].length).replace(/^\n+/, "") : body;
}

/**
 * Build a single node from a `RawMessage`, deriving `title` /
 * `type` / `description` / `tags` / `body` via `rawMessageToOkf`
 * so the graph mirrors what `okf emit` writes to disk.
 */
function buildNodeFromMessage(message: RawMessage): WikiNode {
	const { document, body, title: codecTitle } = rawMessageToOkf(message);
	const fm = document.frontMatter;
	const type = (fm.type as string) ?? "Reference";
	const id = `${sanitizeTypeFolder(type)}/${message.messageId}`;
	const strippedBody = stripTitleHeading(body);
	const resolvedTitle = codecTitle ?? (typeof fm.title === "string" ? fm.title : message.messageId);
	return {
		id,
		title: resolvedTitle,
		type,
		description: typeof fm.description === "string" ? fm.description : "",
		tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
		body: strippedBody,
		size: strippedBody.length,
		links: [],
		backlinks: [],
	};
}

/**
 * Resolve each node's outgoing links against known ids; populate
 * `links[]` and `backlinks[]` in place; return the resulting
 * deduplicated edge list.
 *
 * Two sources of edges:
 *   1. In-body markdown links of the form `[label](./path.md)`.
 *   2. Front-matter `links:` blocks of the form:
 *        links:
 *          - target: ./other.md
 *            type: cites
 *            quote: "see also ..."
 *
 * Edges from both sources flow through the same dedup / resolution
 * pipeline; front-matter edges take precedence on `edge_type` /
 * `quote` when both sources agree on the same `source → target`.
 */
function resolveLinks(
	nodes: WikiNode[],
	frontMatterLinks: Map<string, Array<{ target: string; edge_type?: WikiEdge["edge_type"]; quote?: string }>>,
): WikiEdge[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const edges: WikiEdge[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		const lastSlash = node.id.lastIndexOf("/");
		const fileDir = lastSlash >= 0 ? node.id.slice(0, lastSlash) : "";

		// 1. In-body markdown links.
		for (const target of extractMarkdownLinkTargets(node.body)) {
			const resolved = resolveRelative(fileDir, target);
			const targetId = resolved.replace(/\.md$/, "");
			const targetNode = byId.get(targetId);
			const key = `${node.id}\n${targetId}`;
			if (!targetNode || targetId === node.id || seen.has(key)) continue;
			seen.add(key);
			edges.push({ source: node.id, target: targetId });
			node.links.push(targetId);
			targetNode.backlinks.push(node.id);
		}

		// 2. Front-matter `links:` block.
		const fmLinks = frontMatterLinks.get(node.id) ?? [];
		for (const link of fmLinks) {
			const target = link.target.replace(/^\.\//, "");
			const resolved = resolveRelative(fileDir, target);
			const targetId = resolved.replace(/\.md$/, "");
			const targetNode = byId.get(targetId);
			if (!targetNode || targetId === node.id) continue;
			const key = `${node.id}\n${targetId}`;
			const edgeType = link.edge_type ?? "cites";
			if (seen.has(key)) {
				// Edge already exists via body link — upgrade its
				// edge_type / quote when front-matter declares them.
				const existing = edges.find((e) => e.source === node.id && e.target === targetId);
				if (existing) {
					existing.edge_type = edgeType;
					if (link.quote) existing.quote = link.quote;
				}
				continue;
			}
			seen.add(key);
			edges.push({ source: node.id, target: targetId, edge_type: edgeType, quote: link.quote });
			node.links.push(targetId);
			targetNode.backlinks.push(node.id);
		}
	}
	return edges;
}

/**
 * Resolve `rel` (a `.md` link) against `baseDir` (a slash-separated
 * path with no `.md` suffix), collapsing `.` / `..` segments.
 * Mirrors `client-lib.js:normalize` on the browser side.
 */
function resolveRelative(baseDir: string, rel: string): string {
	const parts = (baseDir ? baseDir.split("/") : []).concat(rel.split("/"));
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

export interface BuildGraphOptions {
	/** Override the `root` field (basename shown in the viewer header). */
	root?: string;
}

/**
 * Build a `WikiGraph` from a list of `RawMessage`s (live mode).
 *
 * Each message becomes one node; outgoing links are derived from
 * `[label](target.md)` patterns inside the body. Backlinks are
 * filled in a single reverse pass.
 */
export function buildGraphFromMessages(
	messages: readonly RawMessage[],
	options: BuildGraphOptions = {},
): WikiGraph {
	const nodes = messages.map(buildNodeFromMessage);
	const edges = resolveLinks(nodes, new Map());
	const root = options.root ?? "opencontext";
	const generatedAt = new Date().toISOString();
	const types = [...new Set(nodes.map((n) => n.type))].sort();
	return { root, generatedAt, types, nodes, edges };
}

/**
 * Build a `WikiGraph` from an already-emitted OKF package directory
 * (frozen mode). Each `.md` file becomes one node; the same link /
 * backlink resolution as `buildGraphFromMessages` runs over them,
 * with the additional front-matter `links:` block.
 */
export async function buildGraphFromDir(dir: string, options: BuildGraphOptions = {}): Promise<WikiGraph> {
	const pkg = await readOkfPackage(dir);
	const nodes: WikiNode[] = pkg.files.map((file) => {
		const fm = file.document.frontMatter as Record<string, unknown>;
		const type = (fm.type as string) ?? "Reference";
		// `readOkfPackage` already returns paths relative to the
		// package root with forward slashes, so we can use `file.path`
		// directly (stripping the `.md` suffix). We also normalise
		// separator characters defensively in case a future caller
		// passes a `package.ts` that has a different convention.
		const id = file.path.replace(/\\/g, "/").replace(/\.md$/, "");
		const body = stripTitleHeading(file.document.body);
		const codecTitle = typeof fm.title === "string" ? (fm.title as string) : undefined;
		const resolvedTitle = codecTitle ?? id.split("/").pop() ?? id;
		return {
			id,
			title: resolvedTitle,
			type,
			description: typeof fm.description === "string" ? fm.description : "",
			tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
			body,
			size: body.length,
			links: [],
			backlinks: [],
		};
	});
	// Index front-matter `links:` blocks per source node id.
	const frontMatterLinks = new Map<
		string,
		Array<{ target: string; edge_type?: WikiEdge["edge_type"]; quote?: string }>
	>();
	for (const file of pkg.files) {
		const fm = file.document.frontMatter as Record<string, unknown>;
		const linksRaw = fm.links;
		if (!Array.isArray(linksRaw)) continue;
		const id = file.path.replace(/\\/g, "/").replace(/\.md$/, "");
		const list: Array<{ target: string; edge_type?: WikiEdge["edge_type"]; quote?: string }> = [];
		for (const item of linksRaw) {
			if (!item || typeof item !== "object") continue;
			const obj = item as Record<string, unknown>;
			if (typeof obj.target !== "string") continue;
			const edgeType =
				obj.type === "cites" ||
				obj.type === "supersedes" ||
				obj.type === "amends" ||
				obj.type === "relates-to"
					? obj.type
					: undefined;
			list.push({
				target: obj.target,
				edge_type: edgeType,
				quote: typeof obj.quote === "string" ? obj.quote : undefined,
			});
		}
		if (list.length > 0) frontMatterLinks.set(id, list);
	}
	const edges = resolveLinks(nodes, frontMatterLinks);
	const root = options.root ?? dir.split(sep).pop() ?? "wiki";
	const generatedAt = new Date().toISOString();
	const types = [...new Set(nodes.map((n) => n.type))].sort();
	return { root, generatedAt, types, nodes, edges };
}
