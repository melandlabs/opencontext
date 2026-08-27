/**
 * `@melandlabs/okf/serve` — local HTTP server for the OKF viewer.
 *
 * Boots a Hono app with:
 *   GET  /health           → { ok, mode, port, ts }
 *   GET  /api/graph        → WikiGraph JSON (live / frozen / ephemeral)
 *   GET  /viewer/*         → opencontext static viewer (HTML/CSS/JS)
 *   GET  /                 → 302 → /viewer/
 *   GET  /viewer           → 302 → /viewer/
 *
 * Three modes:
 *   - live  (default): queries the memory store on every `/api/graph`
 *     request so a fresh fact added via `opencontext add …` shows up
 *     in the browser after a refresh (the plan calls for F5-based
 *     refresh; SSE is intentionally omitted).
 *   - frozen (`--from=<dir>`): serves a previously-emitted OKF package
 *     directory. No memory-store access; reads the directory on every
 *     request.
 *   - ephemeral (`messages: [...]`): in-memory only. The caller hands
 *     in a `RawMessage[]` and the server builds the graph from it
 *     directly — no SQLite, no storeMessages, no scratch dir. Useful
 *     for previewing a graph before committing, for tests that don't
 *     want a DB, and for demos that build data on the fly. `messages`
 *     and `from` are mutually exclusive; combining them throws.
 *
 * `startOkfServe` returns a `StartedOkfServe` whose `stop()` shuts
 * down the HTTP server (and, in live mode without a caller-supplied
 * `rawStore`, also closes the auto-loaded store). Caller is responsible
 * for any process-level signal handling.
 */

import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { serve as serveHttp } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { RawMessage } from "@melandlabs/indexeddb";
import { Hono } from "hono";
import { filterRawMessagesByOkfType } from "./codec.js";
import { type WikiGraph, buildGraphFromDir, buildGraphFromMessages } from "./graph.js";
import { registerOkfRoutes } from "./http.js";

/** Shape of the memory-store raw-message store we delegate to. */
interface RawMessageStoreLike {
	getManager(): Promise<RawMessageManagerLike>;
	close(): Promise<void>;
}

interface RawMessageManagerLike {
	queryMessages?: (input: Record<string, unknown>) => Promise<RawMessage[]>;
	queryMessagesGrouped?: (input: Record<string, unknown>) => Promise<Record<string, RawMessage[]>>;
}

/**
 * Re-declare the OKF ↔ memory-store workspace-cycle avoidance used
 * by `cli.ts` (see that file's header for the full explanation).
 * `okf` is re-exported from `index.ts` (the tsup DTS entry), so any
 * literal `await import("@melandlabs/memory-store")` here would
 * race the DTS step.
 */
const MEMORY_STORE_MODULE_ID = "@melandlabs/memory-store";

type CreateRawMessageStoreFn = (config?: Record<string, unknown>) => RawMessageStoreLike;

let cachedCreateRawMessageStore: CreateRawMessageStoreFn | undefined;
async function loadCreateRawMessageStore(): Promise<CreateRawMessageStoreFn> {
	if (!cachedCreateRawMessageStore) {
		// Indirect the module specifier through a string so tsup DTS
		// can't resolve it at type-check / declaration-emit time. The
		// runtime still hits the real module.
		const mod = (await import(/* @vite-ignore */ MEMORY_STORE_MODULE_ID)) as {
			createRawMessageStore: CreateRawMessageStoreFn;
		};
		cachedCreateRawMessageStore = mod.createRawMessageStore;
	}
	return cachedCreateRawMessageStore;
}

export interface OkfServeOptions {
	/** TCP port. Default: 4321. */
	port?: number;
	/** Bind address. Default: `127.0.0.1` (loopback only). */
	host?: string;
	/** Live-mode user filter. */
	user?: string;
	/** Live-mode bot filter. */
	bot?: string;
	/** Live-mode platform filter. */
	platform?: string;
	/**
	 * Frozen mode: serve the contents of this OKF package directory.
	 * When set, the memory store is NOT queried.
	 */
	from?: string;
	/**
	 * Ephemeral mode: serve the supplied `RawMessage[]` in memory.
	 * No memory store, no SQLite, no scratch dir — every `/api/graph`
	 * request builds the graph from this list. Mutually exclusive
	 * with `from`.
	 */
	messages?: readonly RawMessage[];
	/**
	 * Test seam: pass a pre-constructed store to avoid the workspace
	 * cycle in unit tests. When omitted, the server auto-loads the
	 * store via `createRawMessageStore({})`.
	 */
	rawStore?: RawMessageStoreLike;
	/**
	 * Test seam: override the directory served at `/viewer/`. Default
	 * resolves to `<repo>/packages/okf/src/viewer/` (dev) or
	 * `<repo>/packages/okf/dist/viewer/` (prod).
	 */
	viewerDir?: string;
}

export interface StartedOkfServe {
	/** Fully-qualified URL the server is listening on. */
	url: string;
	/** Actual bound port. */
	port: number;
	/** `live` (memory store), `frozen` (pre-emitted directory), or `ephemeral` (inline messages). */
	mode: "live" | "frozen" | "ephemeral";
	/** Stop the HTTP server and (in live mode) close the store. */
	stop(): Promise<void>;
}

/** Resolved path to the bundled viewer directory. */
function resolveViewerDir(override?: string): string {
	if (override) return resolvePath(override);
	const here = dirname(fileURLToPath(import.meta.url));
	// From src/serve.ts → src/viewer/; from dist/serve.js → dist/viewer/.
	// Probe both candidates and prefer whichever exists.
	const candidates = [resolvePath(here, "viewer"), resolvePath(here, "..", "src", "viewer")];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0] ?? candidates[1] ?? here;
}

/** Build a WikiGraph for the live mode (one query per request). */
async function buildLiveGraph(
	store: RawMessageStoreLike,
	options: { user?: string; bot?: string; platform?: string },
): Promise<WikiGraph> {
	const manager = await store.getManager();
	const query: Record<string, unknown> = { limit: 100_000 };
	if (options.user) query.userId = options.user;
	if (options.bot) query.botId = options.bot;
	if (options.platform) query.platform = options.platform;
	let rows: RawMessage[] = [];
	if (typeof manager.queryMessages === "function") {
		rows = (await manager.queryMessages(query)) as RawMessage[];
	} else if (typeof manager.queryMessagesGrouped === "function") {
		const grouped = (await manager.queryMessagesGrouped(query)) as Record<string, RawMessage[]>;
		rows = Object.values(grouped).flat();
	}
	// Live mode currently mirrors the unfiltered emit — there's no
	// `--types` flag yet. Filter helper kept here so future flags
	// slot in without re-plumbing the route.
	const filtered = filterRawMessagesByOkfType(rows, null);
	return buildGraphFromMessages(filtered);
}

/**
 * Boot the OKF viewer HTTP server. Returns the listener handle.
 * The server keeps running until `stop()` is called.
 */
export async function startOkfServe(opts: OkfServeOptions = {}): Promise<StartedOkfServe> {
	if (opts.messages !== undefined && opts.from !== undefined) {
		throw new Error("startOkfServe: `messages` and `from` are mutually exclusive");
	}
	const port = opts.port ?? 4321;
	const host = opts.host ?? "127.0.0.1";
	const mode: "live" | "frozen" | "ephemeral" =
		opts.messages !== undefined ? "ephemeral" : opts.from ? "frozen" : "live";

	const app = new Hono();

	// 1. /health — for orchestration / smoke tests.
	app.get("/health", (c) =>
		c.json({
			ok: true,
			mode,
			port,
			...(mode === "frozen" && opts.from ? { from: opts.from } : {}),
			ts: Date.now(),
		}),
	);

	// 2. /api/graph — live queries the store; frozen reads the dir;
	//    ephemeral builds from the inline messages array. The store
	//    handle is captured in the closure below so `stop()` can
	//    decide whether to close it (only when this server auto-loaded
	//    it — caller-supplied stores are owned by the caller).
	let liveStore: { store: RawMessageStoreLike; ownStore: boolean } | undefined;
	if (mode === "live") {
		const ownStore = opts.rawStore === undefined;
		const store = opts.rawStore ?? (await loadCreateRawMessageStore())({});
		liveStore = { store, ownStore };
		app.get("/api/graph", async (c) => {
			try {
				const graph = await buildLiveGraph(store, {
					user: opts.user,
					bot: opts.bot,
					platform: opts.platform,
				});
				return c.json(graph);
			} catch (err) {
				return c.json(
					{
						error: err instanceof Error ? err.message : String(err),
						code: "graph_build_failed",
					},
					500,
				);
			}
		});
		// Mount the OKF /v1/okf/* importer / exporter routes so the
		// same host can ingest a package the viewer shows. Existing
		// code in `http.ts` reads from the store only.
		registerOkfRoutes(app, store);
	} else if (mode === "frozen") {
		const fromDir = resolvePath(opts.from ?? ".");
		app.get("/api/graph", async (c) => {
			try {
				const graph = await buildGraphFromDir(fromDir);
				return c.json(graph);
			} catch (err) {
				return c.json(
					{
						error: err instanceof Error ? err.message : String(err),
						code: "graph_build_failed",
					},
					500,
				);
			}
		});
	} else {
		// ephemeral — capture the messages array in the closure.
		const inlineMessages = opts.messages ?? [];
		app.get("/api/graph", async (c) => {
			try {
				return c.json(buildGraphFromMessages([...inlineMessages]));
			} catch (err) {
				return c.json(
					{
						error: err instanceof Error ? err.message : String(err),
						code: "graph_build_failed",
					},
					500,
				);
			}
		});
	}

	// 3. Static viewer under /viewer/* with a redirect for the root.
	const viewerDir = resolveViewerDir(opts.viewerDir);
	app.use(
		"/viewer/*",
		serveStatic({
			root: viewerDir,
			rewriteRequestPath: (p) => p.replace(/^\/viewer/, ""),
		}),
	);
	// Keep the param explicitly typed for the `rewriteRequestPath`
	// overload that takes `(path, c)` in the node-server adapter.
	app.get("/", (c) => c.redirect("/viewer/"));
	app.get("/viewer", (c) => c.redirect("/viewer/"));

	const server = serveHttp({ fetch: app.fetch, port, hostname: host });

	return {
		url: `http://${host}:${port}`,
		port,
		mode,
		async stop() {
			// Order matters: close the HTTP server first and wait for
			// it to drain in-flight handlers, THEN close the store.
			// Closing the store while handlers are still calling into
			// it races sqlite / postgres destructors against active
			// queries. Mirrors the pattern in
			// `packages/memory-store/src/http.ts:519-530`.
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (liveStore?.ownStore) {
				try {
					await liveStore.store.close();
				} catch {
					// Best-effort — never let a close error mask a
					// successful HTTP-server shutdown.
				}
			}
		},
	};
}

/**
 * Options for {@link feedOkfServe} — the one-shot "store these messages
 * in a memory store, then serve the store as an OKF graph" helper.
 */
export interface FeedOkfServeOptions {
	/** The `RawMessage[]` to upsert into a fresh memory store before serving. */
	messages: readonly RawMessage[];
	/** TCP port. Default: 4321. */
	port?: number;
	/** Bind address. Default: `127.0.0.1` (loopback only). */
	host?: string;
	/** Live-mode user filter. Forwarded into `startOkfServe`. */
	user?: string;
}

/**
 * One-shot helper: auto-create a memory store, upsert the supplied
 * `RawMessage[]`, and boot the OKF viewer against that store. Collapses
 * the four-step pattern
 *
 * ```ts
 * const store = createRawMessageStore({});
 * const manager = await store.getManager();
 * await manager.storeMessages(messages);
 * const server = await startOkfServe({ port, rawStore: store });
 * ```
 *
 * into a single call. The returned handle's `stop()` shuts down the
 * HTTP server and closes the auto-created store.
 */
export async function feedOkfServe(opts: FeedOkfServeOptions): Promise<StartedOkfServe> {
	const createStore = await loadCreateRawMessageStore();
	const store = createStore({});
	const manager = await store.getManager();
	// The local `RawMessageManagerLike` interface doesn't enumerate
	// `storeMessages` (it lives in the live manager exported by
	// `@melandlabs/memory-store`), so we narrow at runtime.
	const insert = (
		manager as unknown as {
			storeMessages?: (msgs: readonly RawMessage[]) => Promise<unknown>;
		}
	).storeMessages;
	if (typeof insert !== "function") {
		// Fail fast — without this, the viewer would boot against an
		// empty store and silently drop the caller's messages.
		try {
			await store.close();
		} catch {
			// Best-effort cleanup; the error below is what callers see.
		}
		throw new Error("feedOkfServe: memory store manager does not expose storeMessages()");
	}
	await insert(opts.messages);
	const server = await startOkfServe({
		port: opts.port,
		host: opts.host,
		user: opts.user,
		rawStore: store,
	});
	// Wrap stop() so the store gets closed even though startOkfServe
	// only auto-closes stores it created itself. Mirrors the same
	// shutdown ordering as startOkfServe's own stop().
	const innerStop = server.stop;
	return {
		url: server.url,
		port: server.port,
		mode: server.mode,
		async stop() {
			await innerStop();
			try {
				await store.close();
			} catch {
				// Best-effort — never let a close error mask a
				// successful HTTP-server shutdown.
			}
		},
	};
}

/**
 * Options for {@link serveOkf} — the "attach my existing memory store
 * to the OKF viewer" helper.
 */
export interface ServeOkfOptions {
	/** TCP port. Default: 4321. */
	port?: number;
	/** Bind address. Default: `127.0.0.1` (loopback only). */
	host?: string;
	/** Live-mode user filter. */
	user?: string;
	/** Live-mode bot filter. */
	bot?: string;
	/** Live-mode platform filter. */
	platform?: string;
}

/**
 * Attach an existing memory store to the OKF viewer. This is the
 * ergonomic counterpart to `startOkfServe({ rawStore: store })` for
 * callers who already hold a store handle (the most common pattern
 * once an app has populated memory with `await messages.storeMessages(...)`):
 *
 * ```ts
 * import { createMemoryStore } from "@melandlabs/opencontext";
 * import { serveOkf } from "@melandlabs/okf";
 *
 * const store = await createMemoryStore();
 * // ... populate the store ...
 * const server = await serveOkf(store, { port: 4321 });
 * // → http://127.0.0.1:4321/viewer/  renders the graph
 * // → http://127.0.0.1:4321/api/graph  returns the WikiGraph JSON
 * ```
 *
 * The store is **not** owned by the OKF viewer — `server.stop()` only
 * shuts down the HTTP server. Closing the store remains the caller's
 * responsibility (matching the `rawStore` test seam in
 * `startOkfServe`).
 */
export async function serveOkf(
	store: RawMessageStoreLike,
	opts: ServeOkfOptions = {},
): Promise<StartedOkfServe> {
	return startOkfServe({
		port: opts.port,
		host: opts.host,
		user: opts.user,
		bot: opts.bot,
		platform: opts.platform,
		rawStore: store,
	});
}
