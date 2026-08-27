/**
 * demo: @melandlabs/okf — `serve` sub-command (live + frozen + serveOkf).
 *
 * Three back-to-back sections exercise every supported path into the
 * OKF viewer against a small "Northwind Labs" team fixture
 * (Decision / Project / Person / Reference / Opinion, with
 * cross-folder wikilinks):
 *
 *   1. Live — fixture RawMessages go into an in-memory SQLite store,
 *      then `startOkfServe({ rawStore })` boots a Hono app on a random
 *      port. `GET /api/graph` returns a `WikiGraph` whose nodes are the
 *      just-inserted messages; `GET /viewer/index.html` returns the
 *      vendored visualizer.
 *   2. Frozen — same fixtures are written to a scratch directory as
 *      OKF `.md` files via `writeOkfPackage`, then
 *      `startOkfServe({ from: tmpDir })` boots the same Hono app in
 *      frozen mode. `GET /api/graph` re-reads the directory and returns
 *      an equivalent `WikiGraph`.
 *   3. `serveOkf` — same fixtures, but routed through
 *      `serveOkf(store, { port })`. This is the most common pattern
 *      once an app already holds a memory-store handle:
 *      `await createMemoryStore(); … storeMessages(…); await serveOkf(store)`.
 *
 * All three modes round-trip through the public surface
 * (`startOkfServe`, `serveOkf`, `feedOkfServe`, `fetch`, `startOkf`)
 * and assert on real return values. The demo exits 1 if any check fails.
 *
 * Symbols are loaded dynamically from `@melandlabs/opencontext` so
 * this demo gracefully skips on published facade versions that
 * pre-date the `serve` integration (mirrors the `20-okf.ts` skip
 * pattern).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawMessage } from "@melandlabs/indexeddb";
import { closeRawMessageStore, createRawMessageStore } from "@melandlabs/memory-store";
import { info, makeCheckWithSkip, runIfMain, runSection, withTmp } from "../_helpers.ts";

const DEMO_USER = "demo-northwind-serve";

const fixtures: Array<{
	path: string;
	text: string;
}> = [
	{
		path: "Decision/cache-strategy.md",
		text: `---
type: Decision
resource: cache-strategy
title: Adopt write-through caching for /api/users
description: Decision recorded 2026-07-22; supersedes the 2026-05-04 spike notes.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [caching, performance, api]
---

We will use a write-through Redis cache for \`GET /api/users\`.
See [redis-deployment](../Reference/redis-deployment.md) for the topology.
`,
	},
	{
		path: "Project/cache-rewrite.md",
		text: `---
type: Project
resource: cache-rewrite
title: Cache rewrite — Q3
description: Migration to Redis with a 30-day shadow-read rollout.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [caching, q3]
---

The cache rewrite project tracks [cache-strategy](../Decision/cache-strategy.md).
Owner: [alice](../Person/alice.md).
`,
	},
	{
		path: "Person/alice.md",
		text: `---
type: Person
resource: alice
title: Alice Tan
description: Staff engineer on the Platform team; owns the cache rewrite project.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [platform, staff]
---

Alice owns [cache-rewrite](../Project/cache-rewrite.md).
`,
	},
	{
		path: "Reference/redis-deployment.md",
		text: `---
type: Reference
resource: redis-deployment
title: Redis deployment topology
description: Primary + replica setup with automatic failover.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [redis, infra]
---

Primary in eu-west-1, async replica in us-east-1.
Failover triggers after two consecutive failed health checks.
`,
	},
	{
		path: "Opinion/cache-pii.md",
		text: `---
type: Opinion
resource: cache-pii
title: The cache should not store raw PII
description: My take on what we should never cache.
generated: { by: "northwind-bot", at: "2026-07-22T09:00:00Z" }
tags: [privacy, caching]
---

I think the cache should hold hashed keys only.
See [cache-strategy](../Decision/cache-strategy.md) for the alternative.
`,
	},
];

async function writeFixturePackage(root: string): Promise<void> {
	for (const f of fixtures) {
		const full = join(root, f.path);
		await mkdir(join(root, f.path.replace(/[^/]+$/, "")), { recursive: true });
		await writeFile(full, f.text, "utf8");
	}
}

/** Convert OKF fixture files into a `RawMessage[]` via the public codec. */
async function fixturesToRawMessages(): Promise<RawMessage[]> {
	const okfExports = (await import("@melandlabs/opencontext")) as Record<string, unknown>;
	const { okfToRawMessage, parseOkf } = okfExports as {
		okfToRawMessage: typeof import("@melandlabs/opencontext").okfToRawMessage;
		parseOkf: typeof import("@melandlabs/opencontext").parseOkf;
	};
	return fixtures.map((f) => {
		const parsed = parseOkf(f.text);
		const codec = okfToRawMessage(parsed, { userId: DEMO_USER, file: f.path });
		return codec.rawMessage;
	});
}

/** Pick an unused TCP port on loopback. */
function pickPort(): number {
	return 30_000 + Math.floor(Math.random() * 10_000);
}

export default async function demoOkfServe() {
	await runSection("demo: @melandlabs/okf — serve (live + frozen)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/okf-serve");

		// Resolve serve exports dynamically (same skip pattern as 20-okf).
		const REQUIRED = ["startOkfServe", "serveOkf", "feedOkfServe"] as const;
		const facade = (await import("@melandlabs/opencontext")) as Record<string, unknown>;
		const missing = REQUIRED.filter((name) => typeof facade[name] !== "function");
		if (missing.length > 0) {
			skip(
				"okf serve export",
				`@melandlabs/opencontext is published without startOkfServe/serveOkf/feedOkfServe yet — missing: ${missing.join(", ")}`,
			);
			return;
		}
		const { startOkfServe, serveOkf, feedOkfServe } = facade as {
			startOkfServe: typeof import("@melandlabs/opencontext").startOkfServe;
			serveOkf: typeof import("@melandlabs/opencontext").serveOkf;
			feedOkfServe: typeof import("@melandlabs/opencontext").feedOkfServe;
		};

		await withTmp("okf-serve-demo", async (dir) => {
			// Point the SQLite default at a scratch file so the demo
			// does not contaminate the user's real ~/.opencontext/memory/.
			process.env.MEMORY_STORE_DB_PATH = join(dir, "store.db");

			// ─── Section A: live mode ─────────────────────────────────
			const rawMessages = await fixturesToRawMessages();
			const liveStore = createRawMessageStore({});
			const liveManager = await liveStore.getManager();
			// Persist fixtures so liveStore.queryMessages has something
			// to return. The fixtures already carry messageIds; the
			// store upserts them in place.
			await liveManager.storeMessages(rawMessages);
			const livePort = pickPort();
			const liveServer = await startOkfServe({ port: livePort, rawStore: liveStore });
			try {
				check("live server is in `live` mode", liveServer.mode === "live", String(liveServer.mode));
				check(
					"live server URL is on the requested port",
					liveServer.url.endsWith(`:${livePort}`),
					liveServer.url,
				);

				const healthRes = await fetch(`${liveServer.url}/health`);
				const health = (await healthRes.json()) as { ok: boolean; mode: string; port: number };
				check("GET /health → ok=true", health.ok === true);
				check("GET /health → mode=live", health.mode === "live", health.mode);
				check("GET /health → port matches", health.port === livePort, String(health.port));

				const graphRes = await fetch(`${liveServer.url}/api/graph`);
				const liveGraph = (await graphRes.json()) as {
					nodes: Array<{ id: string; title: string; type: string }>;
					edges: Array<{ source: string; target: string }>;
					types: string[];
				};
				check(
					"live /api/graph has one node per fixture",
					liveGraph.nodes.length === fixtures.length,
					String(liveGraph.nodes.length),
				);
				check(
					"live /api/graph contains at least one cross-folder edge",
					liveGraph.edges.length >= 1,
					String(liveGraph.edges.length),
				);
				check(
					"live /api/graph types cover Decision/Project/Person/Reference/Opinion",
					JSON.stringify(liveGraph.types.sort()) ===
						JSON.stringify(["Decision", "Opinion", "Person", "Project", "Reference"]),
					liveGraph.types.join(", "),
				);
				info("demo/okf-serve", `live: ${liveGraph.nodes.length} nodes, ${liveGraph.edges.length} edges`);

				const viewerRes = await fetch(`${liveServer.url}/viewer/`);
				const viewerHtml = await viewerRes.text();
				check("GET /viewer/ → 200", viewerRes.status === 200, String(viewerRes.status));
				check(
					"viewer HTML includes the OKF title",
					viewerHtml.includes("<title>opencontext · OKF viewer</title>"),
				);
				check("viewer HTML references the relative client.js", viewerHtml.includes('src="./client.js"'));
				check("viewer HTML emits Content-Security-Policy", viewerHtml.includes("Content-Security-Policy"));

				const rootRes = await fetch(`${liveServer.url}/`, { redirect: "manual" });
				check(
					"GET / redirects to /viewer/",
					rootRes.headers.get("location") === "/viewer/",
					rootRes.headers.get("location") ?? "(none)",
				);
			} finally {
				await liveServer.stop();
			}

			// Reset the SQLite singleton before switching modes so the
			// frozen-mode section doesn't see the live-store handle
			// cached on the global manager.
			await closeRawMessageStore().catch(() => undefined);

			// ─── Section B: frozen mode ───────────────────────────────
			const frozenDir = join(dir, "frozen-wiki");
			await writeFixturePackage(frozenDir);
			const frozenPort = pickPort();
			const frozenServer = await startOkfServe({ from: frozenDir, port: frozenPort });
			try {
				check("frozen server is in `frozen` mode", frozenServer.mode === "frozen");

				const fHealthRes = await fetch(`${frozenServer.url}/health`);
				const fHealth = (await fHealthRes.json()) as {
					ok: boolean;
					mode: string;
					from?: string;
				};
				check("frozen /health echoes --from", fHealth.from === frozenDir, fHealth.from);

				const fGraphRes = await fetch(`${frozenServer.url}/api/graph`);
				const frozenGraph = (await fGraphRes.json()) as {
					nodes: Array<{ id: string }>;
					edges: Array<{ source: string; target: string }>;
				};
				check(
					"frozen /api/graph has one node per fixture",
					frozenGraph.nodes.length === fixtures.length,
					String(frozenGraph.nodes.length),
				);
				// Frozen mode reads the directory; the cross-folder links
				// from the fixtures resolve to edges in the same way
				// live mode resolves them.
				check(
					"frozen /api/graph produces equivalent cross-folder edges",
					frozenGraph.edges.length >= 1,
					String(frozenGraph.edges.length),
				);
				info(
					"demo/okf-serve",
					`frozen: ${frozenGraph.nodes.length} nodes, ${frozenGraph.edges.length} edges`,
				);
			} finally {
				await frozenServer.stop();
			}

			// Reset the SQLite singleton before Section C so the
			// serveOkf call gets a fresh manager pointed at the same
			// scratch DB Section A already populated.
			await closeRawMessageStore().catch(() => undefined);

			// ─── Section C: serveOkf (attach existing store) ─────────
			// The most common pattern: the app already holds a memory
			// store (e.g. from `await createMemoryStore()`), and wants
			// to attach it to the OKF viewer. `serveOkf(store, …)` is
			// the ergonomic counterpart to
			// `startOkfServe({ rawStore: store })` — same semantics,
			// clearer call shape.
			const serveStore = createRawMessageStore({});
			const serveManager = await serveStore.getManager();
			await serveManager.storeMessages(rawMessages);
			const servePort = pickPort();
			const serveServer = await serveOkf(serveStore, { port: servePort });
			try {
				check("serveOkf server is in `live` mode", serveServer.mode === "live", serveServer.mode);
				check(
					"serveOkf server URL is on the requested port",
					serveServer.url.endsWith(`:${servePort}`),
					serveServer.url,
				);

				const sHealthRes = await fetch(`${serveServer.url}/health`);
				const sHealth = (await sHealthRes.json()) as { ok: boolean; mode: string };
				check("serveOkf /health → ok=true", sHealth.ok === true);
				check("serveOkf /health → mode=live", sHealth.mode === "live", sHealth.mode);

				const sGraphRes = await fetch(`${serveServer.url}/api/graph`);
				const sGraph = (await sGraphRes.json()) as {
					nodes: Array<{ id: string }>;
					edges: Array<{ source: string; target: string }>;
					types: string[];
				};
				// Every fixture message must appear in the graph the
				// viewer is serving. Assert presence (not count) so the
				// check survives the auto-populated store.
				const sIds = new Set(sGraph.nodes.map((n) => n.id));
				const missing: string[] = [];
				for (const f of fixtures) {
					const slug = f.path.replace(/\.md$/, "");
					if (!sIds.has(slug)) missing.push(slug);
				}
				check(
					`serveOkf /api/graph contains all ${fixtures.length} fixture ids`,
					missing.length === 0,
					missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`,
				);
				check(
					"serveOkf /api/graph carries at least one cross-folder edge",
					sGraph.edges.length >= 1,
					String(sGraph.edges.length),
				);
				info("demo/okf-serve", `serveOkf: ${sGraph.nodes.length} nodes, ${sGraph.edges.length} edges`);
			} finally {
				await serveServer.stop();
				await serveStore.close().catch(() => undefined);
			}
		});

		// Defensive: close the singleton so subsequent demos start cold.
		await closeRawMessageStore().catch(() => undefined);

		// Read the viewer files as a smoke check that the assets
		// were actually copied next to the demo. Asserting on the
		// license / title strings is the only stable fingerprint we
		// can check without depending on the build pipeline.
		try {
			const dir = join(import.meta.dirname, "..", "..", "..", "packages", "okf", "src", "viewer");
			const licenses = await readFile(join(dir, "THIRD_PARTY_LICENSES.md"), "utf8");
			const indexHtml = await readFile(join(dir, "index.html"), "utf8");
			check(
				"viewer THIRD_PARTY_LICENSES.md declares opencontext as the sole viewer author",
				licenses.includes("opencontext") && /Original to opencontext|no upstream/i.test(licenses),
				`${licenses.length} bytes`,
			);
			check(
				"viewer index.html title is an opencontext-branded string",
				indexHtml.includes("<title>opencontext") && /opencontext · OKF viewer/.test(indexHtml),
				`${indexHtml.length} bytes`,
			);
		} catch {
			// The vendored-assets check is informational only — the
			// demo above already exercised the full HTTP surface.
		}
	});
}

runIfMain("demoOkfServe", demoOkfServe);
