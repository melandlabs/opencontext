/**
 * Integration tests for `startOkfServe`. Each test boots a real
 * Hono app on a random high port, makes fetch calls against it,
 * and shuts it down with `stop()`.
 *
 * A fake `RawMessageStoreLike` is supplied via the `rawStore`
 * test seam so tests don't depend on `createRawMessageStore`
 * being available (which would force the @melandlabs/memory-store
 * runtime into the unit test sandbox).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawMessage } from "@melandlabs/indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StartedOkfServe } from "./serve.js";
import { startOkfServe } from "./serve.js";

/** Build a minimal `RawMessage` for the fake store. */
function message(overrides: Partial<RawMessage> & Pick<RawMessage, "messageId" | "content">): RawMessage {
	return {
		messageId: overrides.messageId,
		userId: overrides.userId ?? "u-1",
		botId: overrides.botId ?? "okf-import",
		platform: overrides.platform ?? "okf",
		timestamp: overrides.timestamp ?? Date.parse("2026-08-19T10:00:00Z"),
		createdAt: overrides.createdAt ?? Date.parse("2026-08-19T10:00:00Z"),
		content: overrides.content,
		factType: overrides.factType ?? "world",
		metadata: overrides.metadata ?? { okfType: "Reference" },
	};
}

/** Build a stub `RawMessageStoreLike` that returns a fixed message set. */
function fakeStore(rows: RawMessage[]) {
	let open = true;
	return {
		async getManager() {
			if (!open) throw new Error("store closed");
			return {
				async queryMessages(_input: Record<string, unknown>) {
					return rows;
				},
			};
		},
		async close() {
			open = false;
		},
	};
}

/** Pick an unused TCP port on loopback. */
function pickPort(): number {
	return 30_000 + Math.floor(Math.random() * 10_000);
}

let tmpDir: string;
let active: StartedOkfServe | undefined;

beforeEach(async () => {
	tmpDir = await join(tmpdir(), `okf-serve-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
	if (active) {
		await active.stop();
		active = undefined;
	}
	await rm(tmpDir, { recursive: true, force: true });
});

describe("startOkfServe (live mode)", () => {
	it("GET /health returns mode + port", async () => {
		const port = pickPort();
		active = await startOkfServe({ port, rawStore: fakeStore([]) });
		const res = await fetch(`${active.url}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; mode: string; port: number };
		expect(body.ok).toBe(true);
		expect(body.mode).toBe("live");
		expect(body.port).toBe(port);
	});

	it("GET /api/graph returns a WikiGraph built from the supplied store", async () => {
		const port = pickPort();
		active = await startOkfServe({
			port,
			rawStore: fakeStore([
				message({ messageId: "alpha", content: "# Alpha\n\nbody" }),
				message({ messageId: "beta", content: "# Beta\n\nbody" }),
			]),
		});
		const res = await fetch(`${active.url}/api/graph`);
		expect(res.headers.get("content-type")).toMatch(/application\/json/);
		const graph = (await res.json()) as { nodes: Array<{ id: string }>; edges: unknown[]; types: string[] };
		expect(graph.nodes).toHaveLength(2);
		expect(graph.types).toEqual(["Reference"]);
		expect(graph.edges).toEqual([]);
	});

	it("GET / redirects to /viewer/", async () => {
		active = await startOkfServe({ port: pickPort(), rawStore: fakeStore([]) });
		const res = await fetch(`${active.url}/`, { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/viewer/");
	});

	it("GET /viewer serves the opencontext index.html", async () => {
		active = await startOkfServe({ port: pickPort(), rawStore: fakeStore([]) });
		const res = await fetch(`${active.url}/viewer/`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toMatch(/<title>opencontext · OKF viewer<\/title>/);
		expect(html).toMatch(/Content-Security-Policy/);
	});

	it("GET /viewer/client.js serves the opencontext client module", async () => {
		active = await startOkfServe({ port: pickPort(), rawStore: fakeStore([]) });
		const res = await fetch(`${active.url}/viewer/client.js`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/javascript/);
		// Body must not carry any upstream brand string and must be a
		// substantive module (not a 404 page served as JS).
		const body = await res.text();
		expect(body.length).toBeGreaterThan(1000);
	});

	it("GET /viewer/styles.css serves the opencontext stylesheet", async () => {
		active = await startOkfServe({ port: pickPort(), rawStore: fakeStore([]) });
		const res = await fetch(`${active.url}/viewer/styles.css`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/css/);
	});

	it("stop() releases the port", async () => {
		const port = pickPort();
		const server = await startOkfServe({ port, rawStore: fakeStore([]) });
		await server.stop();
		// Re-bind to the same port to confirm it's free again. If
		// `stop()` were broken, this would throw EADDRINUSE.
		const rebind = await startOkfServe({ port, rawStore: fakeStore([]) });
		await rebind.stop();
	});

	it("passes user/bot/platform into the store's query", async () => {
		let lastQuery: Record<string, unknown> | undefined;
		const port = pickPort();
		active = await startOkfServe({
			port,
			user: "alice",
			bot: "okf-bot",
			platform: "demo",
			rawStore: {
				async getManager() {
					return {
						async queryMessages(input: Record<string, unknown>) {
							lastQuery = input;
							return [];
						},
					};
				},
				async close() {},
			},
		});
		await fetch(`${active.url}/api/graph`);
		expect(lastQuery).toEqual({
			userId: "alice",
			botId: "okf-bot",
			platform: "demo",
			limit: 100_000,
		});
	});
});

describe("startOkfServe (frozen mode)", () => {
	it("mode is 'frozen' when --from is set", async () => {
		const fixture = join(tmpDir, "Reference/x.md");
		await mkdir(join(tmpDir, "Reference"), { recursive: true });
		await writeFile(
			fixture,
			`---
type: Reference
title: X
generated: { by: "demo", at: "2026-08-19T10:00:00Z" }
---

x
`,
			"utf8",
		);
		active = await startOkfServe({ port: pickPort(), from: tmpDir });
		expect(active.mode).toBe("frozen");
		const res = await fetch(`${active.url}/api/graph`);
		expect(res.status).toBe(200);
		const graph = (await res.json()) as { nodes: unknown[] };
		expect(graph.nodes).toHaveLength(1);
	});

	it("/health echoes the --from directory", async () => {
		active = await startOkfServe({ port: pickPort(), from: tmpDir });
		const res = await fetch(`${active.url}/health`);
		const body = (await res.json()) as { mode: string; from?: string };
		expect(body.mode).toBe("frozen");
		expect(body.from).toBe(tmpDir);
	});
});
