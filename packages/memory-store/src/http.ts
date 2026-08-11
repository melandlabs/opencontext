/**
 * @melandlabs/memory-store/http — HTTP server entry.
 *
 * Usage:
 *   import { startHttpServer } from "@melandlabs/memory-store/http";
 *   const { url, stop } = await startHttpServer({
 *     port: 7421,
 *     db: { getDb: () => drizzleDb() },
 *   });
 *
 * Endpoints (all POST, JSON in/out):
 *   GET  /health            → { ok: true }
 *   POST /v1/search         → UnifiedMemorySearchOutput
 *   POST /v1/raw-messages   → upsert raw messages (returns count)
 *   GET  /v1/raw-messages/:id  → single raw message
 *
 * The HTTP server speaks only to the raw-message + vector layers; it does
 * not expose RAG/insights cross-source search (callers wire those up
 * server-side or use the MCP server with a fully-wired store).
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { MemoryStoreConfig } from "./index";
import { createUnifiedSearch } from "./search/unified-search";
import { upsertRawMessagesToChroma } from "./storage/chroma-memory-index";
import { createRawMessageStore } from "./storage/raw-message-store";

export interface StartHttpServerOptions extends MemoryStoreConfig {
	/** Port to bind. Defaults to 7421. */
	port?: number;
	/** Bind address. Defaults to 127.0.0.1 (loopback only — change to 0.0.0.0 for LAN). */
	host?: string;
}

export interface StartedHttpServer {
	url: string;
	port: number;
	stop(): Promise<void>;
}

export async function startHttpServer(options: StartHttpServerOptions = {}): Promise<StartedHttpServer> {
	const port = options.port ?? Number.parseInt(process.env.MEMORY_HTTP_PORT ?? "7421", 10);
	const host = options.host ?? process.env.MEMORY_HTTP_HOST ?? "127.0.0.1";

	const rawStore = createRawMessageStore({
		env: options.env,
	});
	const search = createUnifiedSearch(options.unified);

	const app = new Hono();

	app.get("/health", (c) => c.json({ ok: true, store: "memory", ts: Date.now() }));

	app.post("/v1/search", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const userId = typeof body.userId === "string" ? body.userId : null;
		const query = typeof body.query === "string" ? body.query : "";
		if (!userId || !query) {
			return c.json({ error: "userId and query are required" }, 400);
		}
		const result = await search.searchUnifiedMemory({
			userId,
			query,
			sources: body.sources,
			limit: body.limit,
			threshold: body.threshold,
			botIds: body.botIds,
			documentIds: body.documentIds,
			includeArchivedInsights: body.includeArchivedInsights,
			authToken: body.authToken,
		});
		return c.json(result);
	});

	app.post("/v1/raw-messages", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		if (!Array.isArray(body.messages) || !body.userId) {
			return c.json({ error: "userId and messages[] required" }, 400);
		}
		const manager = await rawStore.getManager();
		const result = await (
			manager as unknown as {
				upsertRawMessages?: (input: {
					userId: string;
					messages: unknown[];
				}) => Promise<unknown>;
			}
		).upsertRawMessages?.({
			userId: body.userId,
			messages: body.messages,
		});
		try {
			await upsertRawMessagesToChroma(body.messages as never);
		} catch (error) {
			console.warn("[memory-store/http] chroma upsert failed:", error);
		}
		return c.json({ ok: true, result });
	});

	app.get("/v1/raw-messages/:id", async (c) => {
		const id = c.req.param("id");
		const userId = c.req.query("userId");
		if (!userId) return c.json({ error: "userId query param required" }, 400);
		const manager = await rawStore.getManager();
		const row = await (
			manager as unknown as {
				getMessageById?: (messageId: string) => Promise<unknown>;
			}
		).getMessageById?.(id);
		if (!row) return c.json({ error: "not found" }, 404);
		return c.json({ message: row });
	});

	const server = serve({ fetch: app.fetch, port, hostname: host });

	return {
		url: `http://${host}:${port}`,
		port,
		async stop() {
			await rawStore.close();
			server.close();
		},
	};
}

export type { MemoryStoreConfig };
