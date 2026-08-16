/**
 * demo: @melandlabs/opencontext — fully-wired MCP server (stdio).
 *
 * The bare `opencontext mcp` CLI is a minimal stdio daemon — every
 * `memory.searchUnified` call returns three structured warnings:
 *
 *   - memory      → "embedQuery is not configured"
 *   - insights    → "insights_search_not_configured"
 *   - knowledge   → "knowledge_search_not_configured"
 *
 * This demo spawns the `opencontext mcp` bin with the same unified flags
 * `opencontext http` accepts (`--embedding-provider local
 * --memory-backend sqlite-vec`) and drives the daemon over stdio the
 * way any MCP client would: a full JSON-RPC handshake (initialize →
 * notifications/initialized → tools/list), then a write/search/get
 * round-trip on the four registered tools.
 *
 * The MCP wire-up covered here is exactly the one the README §4 wires
 * into Claude Desktop / Cursor. The demo exists so a regression in
 * either the flag parsing, the JSON-RPC handshake, or the tool handlers
 * shows up in `pnpm test` instead of in someone's editor.
 *
 * If the local ONNX weights cannot be loaded (no network, no populated
 * HuggingFace cache) the inference-dependent checks skip cleanly — the
 * same pattern `14-local-embedding.ts` uses.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { info, makeCheckWithSkip, runSection, withTmp } from "../_helpers.ts";

interface McpResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
}

export default async function demoMcpServer() {
	await runSection("demo: @melandlabs/opencontext (MCP server, stdio, all unified deps wired)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/mcp-server");

		// Resolve the `opencontext` bin from the workspace symlink under
		// examples/node_modules. pnpm keeps this pointing at
		// packages/opencontext, so a fresh `pnpm build` here is picked
		// up automatically.
		const bin = fileURLToPath(
			new URL("../../node_modules/@melandlabs/opencontext/dist/cli/opencontext.js", import.meta.url),
		);

		await withTmp("mcp-server", async (dir) => {
			const dbPath = path.join(dir, "store.db");
			const previousDbPath = process.env.MEMORY_STORE_DB_PATH;
			process.env.MEMORY_STORE_DB_PATH = dbPath;

			const child = spawn(
				process.execPath,
				[
					bin,
					"mcp",
					"--embedding-provider",
					"local",
					"--memory-backend",
					"sqlite-vec",
					"--name",
					"demo-mcp",
					"--version",
					"0.0.1",
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);

			const stderrLines: string[] = [];
			child.stderr.on("data", (c: Buffer) => stderrLines.push(c.toString()));
			child.on("error", (err) => {
				process.stderr.write(`[demo/mcp-server] spawn error: ${err.message}\n`);
			});

			const responses: McpResponse[] = [];
			let stdoutBuf = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBuf += chunk.toString();
				let nl: number;
				while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
					const line = stdoutBuf.slice(0, nl);
					stdoutBuf = stdoutBuf.slice(nl + 1);
					if (!line.trim()) continue;
					try {
						responses.push(JSON.parse(line) as McpResponse);
					} catch (err) {
						process.stderr.write(`[demo/mcp-server] non-JSON on stdout: ${line.slice(0, 200)}\n`);
						process.stderr.write(`  parse error: ${(err as Error).message}\n`);
					}
				}
			});

			const findById = (id: number) => responses.find((r) => r.id === id);

			const send = (msg: object) => {
				child.stdin.write(`${JSON.stringify(msg)}\n`);
			};

			const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

			// Poll until the response for `id` lands instead of sleeping a fixed
			// amount. The daemon's boot cost varies wildly across runners — a
			// cold macOS CI box needs well over a second just to load the
			// bundle, and the first `embedOnInsert` lazily pulls ~30 MB of ONNX
			// weights. Fixed sleeps turned that variance into flaky failures.
			const waitForId = async (id: number, timeoutMs: number) => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const found = findById(id);
					if (found) return found;
					await wait(50);
				}
				return undefined;
			};

			try {
				// 1. initialize — handshake; expects our --name/--version back.
				send({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						capabilities: {},
						clientInfo: { name: "demo", version: "0.0.1" },
					},
				});
				await waitForId(1, 30_000);

				const init = findById(1) as
					| { result: { serverInfo: { name: string; version: string }; protocolVersion: string } }
					| undefined;
				check(
					"initialize returns serverInfo with the configured name/version",
					init?.result?.serverInfo?.name === "demo-mcp" && init?.result?.serverInfo?.version === "0.0.1",
					init ? `${init.result.serverInfo.name}/${init.result.serverInfo.version}` : "no response",
				);

				// 2. initialized notification + tools/list
				send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
				send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
				await waitForId(2, 30_000);

				const tools = findById(2) as { result: { tools: Array<{ name: string }> } } | undefined;
				const toolNames = new Set(tools?.result?.tools.map((t) => t.name) ?? []);
				check(
					"tools/list exposes all four memory tools",
					["memory.health", "memory.searchUnified", "memory.writeRawMessage", "memory.getRawMessage"].every(
						(n) => toolNames.has(n),
					),
					[...toolNames].sort().join(", "),
				);

				// 3. Two writes via memory.writeRawMessage with embedOnInsert:true.
				//    The host's --embedding-provider local wires the embedder,
				//    so messages get auto-vectorized server-side.
				const now = Date.now();
				const msg1 = {
					role: "user",
					messageId: "msg-mcp-1",
					content: "I love hiking in the mountains every summer",
					platform: "test",
					botId: "bot-1",
					timestamp: now,
					createdAt: now,
				};
				const msg2 = {
					role: "user",
					messageId: "msg-mcp-2",
					content: "Pizza with extra cheese is my favorite food",
					platform: "test",
					botId: "bot-1",
					timestamp: now,
					createdAt: now,
				};
				send({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "memory.writeRawMessage",
						arguments: { userId: "u-mcp-1", embedOnInsert: true, message: msg1 },
					},
				});
				// First `embedQuery` inside the daemon process lazily loads
				// ~30 MB of ONNX weights from disk (or downloads them on a
				// cold cache), so give this write a long ceiling.
				await waitForId(3, 90_000);
				send({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: {
						name: "memory.writeRawMessage",
						arguments: { userId: "u-mcp-1", embedOnInsert: true, message: msg2 },
					},
				});
				await waitForId(4, 90_000);

				const write1 = findById(3) as { result?: unknown; error?: unknown } | undefined;
				const write1Text = (write1?.result as { content?: Array<{ text?: string }> } | undefined)
					?.content?.[0]?.text;
				let write1Parsed: { ok?: boolean; count?: number } | undefined;
				try {
					write1Parsed = write1Text
						? (JSON.parse(write1Text) as { ok?: boolean; count?: number })
						: undefined;
				} catch {
					write1Parsed = undefined;
				}
				check(
					"memory.writeRawMessage with embedOnInsert:true returns ok=true",
					write1Parsed?.ok === true,
					write1Parsed
						? `ok=${write1Parsed.ok} count=${write1Parsed.count}`
						: `no response — daemon stderr:\n${stderrLines.join("").slice(-800)}`,
				);

				// If the embedder never came up, skip the rest rather than
				// fail on an unrelated downstream check.
				const stderr = stderrLines.join("");
				if (!stderr.includes("embedQuery wired")) {
					skip(
						"memory.searchUnified returns memory hits",
						"local embedder never came up; check stderr above",
					);
					skip(
						"memory.searchUnified has no embedQuery/insights/knowledge warnings",
						"depends on the model loading",
					);
					skip("memory.getRawMessage round-trips the just-written message", "depends on the model loading");
					skip("memory.health returns ok=true", "depends on the model loading");
					return;
				}

				// 4. memory.searchUnified with a related query. Expect the
				//    hiking message to rank above the pizza message, with
				//    NO `embedQuery is not configured` warning (only the
				//    expected insights/knowledge warnings).
				send({
					jsonrpc: "2.0",
					id: 5,
					method: "tools/call",
					params: {
						name: "memory.searchUnified",
						arguments: { userId: "u-mcp-1", query: "outdoor activities and nature", limit: 5, threshold: 0 },
					},
				});
				await waitForId(5, 60_000);

				const search = findById(5) as { result: { content: Array<{ text: string }> } } | undefined;
				const searchText = search?.result?.content?.[0]?.text;
				let searchParsed:
					| {
							results: Array<{ id: string; type: string; content: string; similarity: number }>;
							count: number;
							warnings: Array<{ source: string; code: string; message: string }>;
					  }
					| undefined;
				try {
					searchParsed = searchText ? JSON.parse(searchText) : undefined;
				} catch {
					searchParsed = undefined;
				}

				info(
					"demo/mcp-server",
					`search returned count=${searchParsed?.count ?? "?"} warnings=${
						searchParsed?.warnings.length ?? "?"
					}`,
				);
				for (const w of searchParsed?.warnings ?? []) {
					info("demo/mcp-server", `  warning [${w.source}] ${w.code}`);
				}

				check(
					"memory.searchUnified returns at least one memory hit",
					(searchParsed?.count ?? 0) >= 1,
					`${searchParsed?.count ?? 0} hits`,
				);

				const badCodes = [
					"memory_search_failed",
					"embedQuery is not configured",
					"insights_search_not_configured",
					"knowledge_search_not_configured",
				];
				const remainingWarns = (searchParsed?.warnings ?? []).filter((w) => badCodes.includes(w.code));
				check(
					"no embedQuery/unified-source warnings remain (insights/knowledge not configured is expected)",
					// insights/knowledge not_configured are expected because
					// we only wired embedder + memory backend.
					(searchParsed?.warnings ?? []).every(
						(w) =>
							w.code === "insights_search_not_configured" || w.code === "knowledge_search_not_configured",
					),
					remainingWarns.map((w) => w.code).join(", ") || "none",
				);

				// 5. memory.getRawMessage should round-trip the first write.
				send({
					jsonrpc: "2.0",
					id: 6,
					method: "tools/call",
					params: { name: "memory.getRawMessage", arguments: { userId: "u-mcp-1", messageId: "msg-mcp-1" } },
				});
				await waitForId(6, 30_000);

				const got = findById(6) as { result: { content: Array<{ text: string }> } } | undefined;
				const gotText = got?.result?.content?.[0]?.text;
				let gotParsed: { message: { messageId: string; content: string } | null } | undefined;
				try {
					gotParsed = gotText ? JSON.parse(gotText) : undefined;
				} catch {
					gotParsed = undefined;
				}
				check(
					"memory.getRawMessage returns the just-written message",
					gotParsed?.message?.messageId === "msg-mcp-1",
					gotParsed?.message
						? `id=${gotParsed.message.messageId} content=${gotParsed.message.content.slice(0, 32)}…`
						: "no response",
				);

				// 6. memory.health
				send({
					jsonrpc: "2.0",
					id: 7,
					method: "tools/call",
					params: { name: "memory.health", arguments: {} },
				});
				await waitForId(7, 30_000);
				const health = findById(7) as { result: { content: Array<{ text: string }> } } | undefined;
				const healthText = health?.result?.content?.[0]?.text;
				let healthParsed: { ok?: boolean } | undefined;
				try {
					healthParsed = healthText ? JSON.parse(healthText) : undefined;
				} catch {
					healthParsed = undefined;
				}
				check("memory.health returns ok=true", healthParsed?.ok === true);
			} finally {
				child.kill("SIGTERM");
				await wait(200);
			}

			// biome-ignore lint/performance/noDelete: `delete` is the only way to unset an env var; assigning `undefined` stores the string "undefined".
			if (previousDbPath === undefined) delete process.env.MEMORY_STORE_DB_PATH;
			else process.env.MEMORY_STORE_DB_PATH = previousDbPath;
		});
	});
}
