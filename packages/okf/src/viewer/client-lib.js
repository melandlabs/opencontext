/**
 * OKF viewer — shared helpers.
 *
 * No upstream branding: every helper below is original to opencontext /
 * OKF v0.2 and carries no third-party strings.
 *
 * `node_radius(size, is_anchor)` etc. are exposed in `snake_case` to match
 * the rest of OKF's published JSON schema (which is `snake_case`), so the
 * same field names appear in graph.json and in the renderer's helpers.
 */

/**
 * Node sphere colors, keyed by draw order. Saturated enough to hold their
 * hue as lit 3D spheres (pale pastels blow out to white under the scene
 * lighting); the legend swatches reuse these same values.
 */
export const PALETTE = [
	"#22d3ee", // cyan-400
	"#a3e635", // lime-400
	"#fb7185", // rose-400
	"#a78bfa", // violet-400
	"#fb923c", // orange-400
	"#34d399", // emerald-400
	"#facc15", // yellow-400
	"#60a5fa", // blue-400
];

const HTML_ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

/**
 * Escape the HTML-significant characters in a string before it is inserted
 * into the DOM. This is the sole XSS gate for wiki-sourced text.
 */
export function escapeHtml(value) {
	return String(value).replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Map each distinct node type to a palette color by its position in the
 * list, so the graph and legend agree on colors and they stay stable
 * across reloads.
 */
export function colorsForTypes(types, palette = PALETTE) {
	const colors = {};
	types.forEach((type, i) => {
		colors[type] = palette[i % palette.length];
	});
	return colors;
}

/**
 * Convert a `#RRGGBB` hex color plus an alpha into an `rgba(...)` string,
 * for canvas glow fills and dimming. A non-6-digit input is returned
 * unchanged.
 */
export function hexA(hex, alpha) {
	const c = (hex || "").replace("#", "");
	if (c.length !== 6) return hex;
	const channel = (i) => Number.parseInt(c.slice(i, i + 2), 16);
	return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

/**
 * Node circle radius in graph units, scaled by body size and capped, with
 * a bonus for the entry (anchor) page so it reads as the starting point.
 */
export function node_radius(size, is_anchor) {
	return 4 + Math.min(7, (size || 0) / 480) + (is_anchor ? 4 : 0);
}

/**
 * Whether a node survives the active search text and type filter. An
 * empty query or empty type matches everything.
 */
export function matches_filter(node, query, type) {
	const haystack = `${node.title} ${node.id} ${(node.tags ?? []).join(" ")}`;
	const matchesQuery = !query || haystack.toLowerCase().includes(query);
	const matchesType = !type || node.type === type;
	return matchesQuery && matchesType;
}

/**
 * A stable fingerprint of the graph's topology (its node ids and
 * directed edges). When it is unchanged across a reload, the scene can
 * be left untouched so the layout and viewport do not snap.
 */
export function signature(graph) {
	const nodes = graph.nodes
		.map((n) => n.id)
		.sort()
		.join("|");
	const edges = graph.edges
		.map((e) => `${e.source}>${e.target}`)
		.sort()
		.join("|");
	return `${nodes}::${edges}`;
}

/**
 * Strip a leading YAML front-matter block from a markdown body before it
 * is rendered in the reader. A body without front-matter is returned
 * unchanged.
 */
export function strip_frontmatter(body) {
	if (!body || !body.startsWith("---")) return body;
	const end = body.indexOf("\n---", 3);
	return end === -1 ? body : body.slice(body.indexOf("\n", end + 1) + 1);
}

/**
 * Resolve a relative link (`rel`) against a page's directory (`baseDir`)
 * into a normalized path, collapsing `.` and `..` segments. Used to turn
 * in-page markdown links into node ids for in-app navigation.
 */
export function normalize(baseDir, rel) {
	const parts = (baseDir ? baseDir.split("/") : []).concat(rel.split("/"));
	const out = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

/**
 * Strip the `.md` suffix and any `index` tail from a node id so the
 * sidebar list shows the slug only.
 */
export function display_id(id) {
	return id.replace(/\.md$/, "").replace(/\/index$/, "/");
}
