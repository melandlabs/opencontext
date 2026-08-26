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
 */
function resolveLinks(nodes: WikiNode[]): WikiEdge[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const edges: WikiEdge[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		// The "directory" for a node is the parent folder of its id.
		// E.g. `Reference/acronym` → `Reference/`. Cross-folder links
		// (e.g. `../Opinion/foo.md`) resolve into a sibling id.
		const lastSlash = node.id.lastIndexOf("/");
		const fileDir = lastSlash >= 0 ? node.id.slice(0, lastSlash) : "";
		for (const target of extractMarkdownLinkTargets(node.body)) {
			const resolved = resolveRelative(fileDir, target);
			// Strip the trailing `.md` if present.
			const targetId = resolved.replace(/\.md$/, "");
			const targetNode = byId.get(targetId);
			const key = `${node.id}\n${targetId}`;
			if (!targetNode || targetId === node.id || seen.has(key)) continue;
			seen.add(key);
			edges.push({ source: node.id, target: targetId });
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
	const edges = resolveLinks(nodes);
	const root = options.root ?? "opencontext";
	const generatedAt = new Date().toISOString();
	const types = [...new Set(nodes.map((n) => n.type))].sort();
	return { root, generatedAt, types, nodes, edges };
}

/**
 * Build a `WikiGraph` from an already-emitted OKF package directory
 * (frozen mode). Each `.md` file becomes one node; the same link /
 * backlink resolution as `buildGraphFromMessages` runs over them.
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
	const edges = resolveLinks(nodes);
	const root = options.root ?? dir.split(sep).pop() ?? "wiki";
	const generatedAt = new Date().toISOString();
	const types = [...new Set(nodes.map((n) => n.type))].sort();
	return { root, generatedAt, types, nodes, edges };
}
