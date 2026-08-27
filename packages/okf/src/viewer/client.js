/**
 * OKF viewer client.
 *
 * Self-contained — no upstream branding, no third-party JS bundled.
 * Reads `/api/graph` from the live serve endpoint, renders a 3D
 * force-directed canvas via the CDN-pinned `force-graph` lib, plus a
 * sidebar index and a markdown detail pane rendered through `marked`
 * + `DOMPurify`.
 *
 * Persisted UI state (split width, collapsed graph, theme, last
 * selected node) lives under the `okf-viewer:*` localStorage prefix.
 */
import {
	colorsForTypes,
	display_id,
	escapeHtml,
	hexA,
	matches_filter,
	node_radius,
	normalize,
	signature,
	strip_frontmatter,
} from "./client-lib.js";

// ─── State ──────────────────────────────────────────────────────────────

/** Full graph payload, last fetched from `/api/graph`. */
let graph = { root: "", generatedAt: "", types: [], nodes: [], edges: [] };

/** Per-type fill colors, rebuilt on every load. */
let color_for_type = {};

/** Live `ForceGraph3D` instance, or `null` before first render. */
let G = null;

/** Id of the selected node (drives the highlight), or `null`. */
let current = null;

/** Id of the page shown in the reader pane, or `null`. */
let reader_id = null;

/** Id of the entry (anchor) page, drawn larger and always labelled. */
let anchor_id = null;

/** Topology signature of the last render — skip redundant re-layouts. */
let last_sig = "";

/** Persisted render-node objects keyed by id, reused across reloads. */
const nodeById = new Map();

/** Nodes currently emphasised (selection / hover neighbourhood). */
const highlight_nodes = new Set();

/** Links currently emphasised (edges within the highlighted neighbourhood). */
const highlight_links = new Set();

// ─── DOM helpers ────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const byId = (id) => graph.nodes.find((n) => n.id === id);
const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const labelColor = () => cssVar("--node-label");
const edgeColor = () => cssVar("--edge");
const graphBg = () => cssVar("--graph-bg");

const is_anchor = (n) => n.id === anchor_id;

const EMPTY_HTML = $("#detail").innerHTML;

// ─── Persistence ────────────────────────────────────────────────────────

const KEY_WIDTH = "okf-viewer:graph-width";
const KEY_COLLAPSED = "okf-viewer:graph-collapsed";
const KEY_THEME = "okf-viewer:theme";

function loadJSON(key, fallback) {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : JSON.parse(v);
	} catch {
		return fallback;
	}
}
function saveJSON(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* quota / private-mode — ignore */
	}
}

// ─── Rendering: legend + sidebar ────────────────────────────────────────

function render_legend() {
	const el = $("#legend");
	el.innerHTML = "";
	for (const type of graph.types) {
		const item = document.createElement("div");
		item.className = "item";
		const swatch = document.createElement("span");
		swatch.className = "swatch";
		swatch.style.background = color_for_type[type] || "#888";
		const label = document.createElement("span");
		label.textContent = type;
		item.append(swatch, label);
		el.appendChild(item);
	}
	const total = document.createElement("div");
	total.className = "item total";
	total.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
	el.appendChild(total);
}

function render_sidebar() {
	const root = $("#sidebar");
	root.innerHTML = "";

	const head = document.createElement("div");
	head.className = "sb-head";
	head.innerHTML = `<span class="sb-title">Pages</span><span class="sb-count">${graph.nodes.length}</span>`;
	root.appendChild(head);

	// Group nodes by type, render each as its own sub-list.
	const byType = new Map();
	for (const n of graph.nodes) {
		const list = byType.get(n.type) ?? [];
		list.push(n);
		byType.set(n.type, list);
	}
	for (const type of graph.types) {
		const list = byType.get(type) ?? [];
		if (list.length === 0) continue;

		const group = document.createElement("div");
		group.className = "sb-group";

		const ghead = document.createElement("div");
		ghead.className = "sb-group-head";
		const swatch = document.createElement("span");
		swatch.className = "swatch";
		swatch.style.background = color_for_type[type] || "#888";
		ghead.append(swatch, document.createTextNode(type));
		const count = document.createElement("span");
		count.className = "count";
		count.textContent = String(list.length);
		ghead.appendChild(count);
		group.appendChild(ghead);

		// Sort by title for stable, alphabetical browsing.
		const sorted = [...list].sort((a, b) => a.title.localeCompare(b.title));
		for (const n of sorted) {
			const btn = document.createElement("button");
			btn.className = "nav-item";
			btn.dataset.nodeId = n.id;

			const head = document.createElement("div");
			head.className = "nav-head";
			const swatch = document.createElement("span");
			swatch.className = "swatch";
			swatch.style.background = color_for_type[type] || "#888";
			swatch.title = type;
			const title = document.createElement("span");
			title.className = "nm";
			title.textContent = n.title;
			head.append(swatch, title);

			const snippet = document.createElement("div");
			snippet.className = "nav-snippet";
			// Prefer description, fall back to the first non-heading body line.
			const description =
				n.description?.trim() ||
				(n.body || "")
					.split(/\r?\n/)
					.map((l) => l.trim())
					.find((l) => l && !l.startsWith("#")) ||
				"";
			snippet.textContent = description;

			const foot = document.createElement("div");
			foot.className = "nav-foot";
			const size = document.createElement("span");
			size.className = "size";
			size.textContent = `${n.size.toLocaleString()} ch`;
			const tags = (n.tags || []).slice(0, 3).map((t) => {
				const c = document.createElement("span");
				c.className = "t-chip";
				c.textContent = `#${t}`;
				return c;
			});
			if (tags.length === 0) {
				// Pad with an empty placeholder so flex justify-between still works.
				const spacer = document.createElement("span");
				spacer.className = "spacer";
				foot.append(size, spacer);
			} else {
				const tagWrap = document.createElement("span");
				tagWrap.className = "tag-wrap";
				tagWrap.append(...tags);
				foot.append(size, tagWrap);
			}

			btn.append(head, snippet, foot);
			btn.addEventListener("click", () => open_node(n.id));
			group.appendChild(btn);
		}
		root.appendChild(group);
	}
}

function mark_active_nav(id) {
	$$(".nav-item").forEach((el) => {
		el.classList.toggle("active", el.dataset.nodeId === id);
	});
}
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ─── Rendering: detail pane ─────────────────────────────────────────────

function render_detail() {
	const root = $("#detail");
	const node = reader_id ? byId(reader_id) : null;
	if (!node) {
		root.innerHTML = EMPTY_HTML;
		return;
	}

	const md = window.marked.parse(strip_frontmatter(node.body || ""), {
		mangle: false,
		headerIds: true,
	});
	const safe = window.DOMPurify.sanitize(md, {
		ADD_ATTR: ["class", "id", "data-node-id"],
	});

	const tags_html = (node.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");

	const links_html = (node.links || []).length
		? `<div class="backlinks"><span class="eyebrow">Links</span>${(node.links || [])
				.map((l) => `<button class="chip" data-link="${escapeHtml(l)}">${escapeHtml(display_id(l))}</button>`)
				.join("")}</div>`
		: "";

	const backlinks_html = (node.backlinks || []).length
		? `<div class="backlinks"><span class="eyebrow">Backlinks</span>${(node.backlinks || [])
				.map((l) => `<button class="chip" data-link="${escapeHtml(l)}">${escapeHtml(display_id(l))}</button>`)
				.join("")}</div>`
		: "";

	root.innerHTML = `
		<div class="eyebrow">${escapeHtml(node.type)}</div>
		<h1 class="doc-title">${escapeHtml(node.title)}</h1>
		${node.description ? `<p class="desc">${escapeHtml(node.description)}</p>` : ""}
		${tags_html ? `<div class="tags">${tags_html}</div>` : ""}
		<hr class="rule" />
		<div class="md">${safe}</div>
		${links_html}
		${backlinks_html}
	`;

	// Wikilink chips navigate in-app rather than reloading the page.
	$$(".chip[data-link]").forEach((el) => {
		el.addEventListener("click", () => open_node(el.dataset.link));
	});

	// Rendered markdown links to other nodes open in-app.
	$$(".md a[href]").forEach((a) => {
		const href = a.getAttribute("href") || "";
		if (!href.endsWith(".md") && !href.startsWith("http")) return;
		a.classList.add("wikilink");
		a.addEventListener("click", (ev) => {
			if (href.startsWith("http")) return;
			ev.preventDefault();
			const target = normalize(dirname(node.id), href).replace(/\.md$/, "");
			open_node(target);
		});
	});

	// Re-run mermaid blocks after the markdown is in the DOM.
	if (window.mermaid?.run) {
		const blocks = root.querySelectorAll(".md pre code.language-mermaid, .md pre.mermaid, .md .mermaid");
		blocks.forEach((b) => {
			try {
				const pre = b.closest("pre");
				const src = b.textContent || "";
				const host = document.createElement("div");
				host.className = "mermaid";
				host.textContent = src;
				if (pre) pre.replaceWith(host);
				else b.replaceWith(host);
				window.mermaid.run({ nodes: [host] });
			} catch (_err) {}
		});
	}
}

function dirname(p) {
	const i = p.lastIndexOf("/");
	return i === -1 ? "" : p.slice(0, i);
}

// ─── Graph: 3D force-directed canvas ────────────────────────────────────

function render_graph() {
	const container = $("#graph");
	container.innerHTML = "";
	if (!graph.nodes.length) {
		container.textContent = "No nodes yet.";
		return;
	}

	// Reuse ForceGraph; the lib mutates `node` in place to add x/y/vx/vy.
	const nodes = graph.nodes.map((n) => {
		const prev = nodeById.get(n.id);
		return prev ? Object.assign(prev, n) : { ...n };
	});
	for (const n of nodes) nodeById.set(n.id, n);

	const links = graph.edges.map((e) => ({ source: e.source, target: e.target }));

	const FG = window.ForceGraph3D || window.ForceGraph;
	if (!FG) {
		return;
	}

	G = FG()(container)
		.graphData({ nodes, links })
		.backgroundColor(graphBg())
		.nodeRelSize(6)
		.nodeLabel((n) => `${n.title}\n${n.type}`)
		.nodeColor((n) => color_for_type[n.type] || "#888")
		.nodeVal((n) => node_radius(n.size, is_anchor(n)))
		.linkColor(() => edgeColor())
		.linkWidth(1)
		.linkDirectionalParticles(0)
		.onNodeHover((n) => {
			highlight_nodes.clear();
			highlight_links.clear();
			if (n) {
				highlight_nodes.add(n);
				(n.links || []).forEach((l) => {
					highlight_links.add(l);
					highlight_nodes.add(l.source);
					highlight_nodes.add(l.target);
				});
			}
			update_highlight();
		})
		.onNodeClick((n) => {
			if (!n) return;
			open_node(n.id);
			const dist = (G.cameraPosition && 80) || 80;
			G.cameraPosition({ x: n.x + dist / 2, y: n.y + dist / 2, z: n.z + dist }, n, 600);
		})
		.linkDirectionalArrowLength(4)
		.linkDirectionalArrowRelPos(0.95);

	apply_text_paint();
}

function apply_text_paint() {
	if (!G) return;
	try {
		G.nodeCanvasObject((n, ctx, scale) => {
			const radius = node_radius(n.size, is_anchor(n));
			const color = color_for_type[n.type] || "#888";

			// Dim unselected / unhighlighted nodes.
			const dim = highlight_nodes.size > 0 && !highlight_nodes.has(n);
			ctx.globalAlpha = dim ? 0.18 : 1;

			// Glow ring.
			ctx.beginPath();
			ctx.arc(n.x, n.y, radius * 1.6, 0, 2 * Math.PI);
			ctx.fillStyle = hexA(color, 0.18);
			ctx.fill();

			// Solid sphere.
			ctx.beginPath();
			ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			// Label only for selected, hovered, or anchor nodes.
			const show_label = current === n.id || highlight_nodes.has(n) || is_anchor(n) || scale > 1.5;
			if (show_label) {
				const fontSize = 12 / scale;
				ctx.font = `${fontSize}px Inter, sans-serif`;
				ctx.fillStyle = labelColor();
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillText(n.title, n.x, n.y + radius + 2);
			}
			ctx.globalAlpha = 1;
		});
	} catch (_err) {}
}

function update_highlight() {
	if (!G) return;
	G.linkColor((l) => {
		const hit = highlight_links.has(l);
		if (!hit && highlight_links.size > 0) return hexA(edgeColor(), 0.18);
		return edgeColor();
	});
	apply_text_paint();
	G.refresh();
}

// ─── Selection ──────────────────────────────────────────────────────────

function open_node(id) {
	const n = byId(id);
	if (!n) return;
	current = id;
	reader_id = id;
	render_detail();
	mark_active_nav(id);
	apply_text_paint();
	G?.refresh();
}

// ─── Splitter drag ──────────────────────────────────────────────────────

function wire_splitter() {
	const splitter = $("#splitter");
	const main = $("#main");
	let dragging = false;
	const onDown = (e) => {
		dragging = true;
		main.classList.add("dragging");
		e.preventDefault();
	};
	const onMove = (e) => {
		if (!dragging) return;
		const rect = main.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const ratio = Math.max(0.15, Math.min(0.85, x / rect.width));
		$("#graph").style.flex = `0 0 ${ratio * 100}%`;
		saveJSON(KEY_WIDTH, ratio);
	};
	const onUp = () => {
		if (!dragging) return;
		dragging = false;
		main.classList.remove("dragging");
	};
	splitter.addEventListener("mousedown", onDown);
	window.addEventListener("mousemove", onMove);
	window.addEventListener("mouseup", onUp);
}

function restore_split_width() {
	const ratio = loadJSON(KEY_WIDTH, 0.5);
	if (typeof ratio === "number") {
		$("#graph").style.flex = `0 0 ${ratio * 100}%`;
	}
}

function wire_collapse() {
	const btn = $("#toggle-graph");
	const main = $("#main");
	const collapsed = loadJSON(KEY_COLLAPSED, false);
	if (collapsed) {
		main.classList.add("graph-hidden");
		btn.classList.add("active");
		btn.textContent = "◳";
	}
	btn.addEventListener("click", () => {
		const is_hidden = main.classList.toggle("graph-hidden");
		btn.classList.toggle("active", is_hidden);
		btn.textContent = is_hidden ? "◳" : "⛶";
		saveJSON(KEY_COLLAPSED, is_hidden);
		if (!is_hidden) {
			G?.cameraPosition?.({ x: 0, y: 0, z: 120 }, { x: 0, y: 0, z: 0 }, 600);
		}
	});
}

// ─── Theme toggle ───────────────────────────────────────────────────────

function wire_theme() {
	const stored = loadJSON(KEY_THEME, "light");
	document.documentElement.dataset.theme = stored === "dark" ? "dark" : "light";
	const btn = $("#theme");
	btn.addEventListener("click", () => {
		const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
		document.documentElement.dataset.theme = next;
		saveJSON(KEY_THEME, next);
		// Re-paint the canvas so it picks up new CSS variables.
		if (G) {
			G.backgroundColor(graphBg());
			apply_text_paint();
			G.refresh();
		}
	});
}

// ─── Search / filter ────────────────────────────────────────────────────

function wire_search() {
	const input = $("input.search");
	const select = $("select.filter");
	input?.addEventListener("input", () => {
		const q = input.value.toLowerCase();
		$$(".nav-item").forEach((el) => {
			const id = el.dataset.nodeId;
			const node = byId(id);
			el.classList.toggle("hidden", !matches_filter(node || {}, q, select?.value || ""));
		});
	});
	select?.addEventListener("change", () => {
		input?.dispatchEvent(new Event("input"));
	});

	// Populate the type filter once the graph is loaded.
	const refreshFilter = () => {
		if (!select) return;
		const prev = select.value;
		select.innerHTML = `<option value="">All types</option>${graph.types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}`;
		select.value = prev;
	};
	const observer = new MutationObserver(refreshFilter);
	observer.observe($("#sidebar"), { childList: true });
}

// ─── Bootstrap ──────────────────────────────────────────────────────────

async function load_graph() {
	const res = await fetch("/api/graph", { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`GET /api/graph → ${res.status}`);
	const next = await res.json();
	const sig = signature(next);
	if (sig === last_sig && G) {
		// Topology unchanged — refresh in-place without rebuilding the scene.
		return;
	}
	graph = next;
	last_sig = sig;
	color_for_type = colorsForTypes(graph.types);
	anchor_id = graph.root || null;
	render_legend();
	render_sidebar();
	render_graph();
	if (reader_id && byId(reader_id)) {
		render_detail();
	}
}

(async function main() {
	wire_splitter();
	wire_collapse();
	wire_theme();
	wire_search();
	restore_split_width();
	if (window.marked) window.marked.setOptions({ gfm: true, breaks: false });
	if (window.mermaid?.initialize) {
		try {
			window.mermaid.initialize({
				startOnLoad: false,
				theme: document.documentElement.dataset.theme === "light" ? "default" : "dark",
				securityLevel: "strict",
			});
		} catch (_err) {}
	}
	try {
		await load_graph();
	} catch (err) {
		$("#detail").innerHTML =
			`<div class="empty">Failed to load /api/graph: ${escapeHtml(String(err.message || err))}</div>`;
	}
})();
