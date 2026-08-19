/**
 * Tutorial: generic HTTP client helpers from `@melandlabs/api`.
 *
 * This example demonstrates the public surface of the API package:
 *
 *   - `get` — perform a typed GET request.
 *   - `post` — perform a typed POST request with a JSON body.
 *   - `ApiError` — error thrown when the response status is not OK.
 *
 * To keep the demo fully self-contained and avoid real external HTTP calls, a
 * tiny local Node HTTP server is spawned and the client is pointed at it. The
 * server returns predictable JSON so the example can assert on the parsed
 * responses.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/34-api-example.ts
 */

import { type Server, createServer } from "node:http";
import { ApiError, get, post } from "@melandlabs/api";
import { runIfMain } from "../_helpers.ts";

async function startMockServer(): Promise<{ server: Server; baseUrl: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");

			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				res.setHeader("Content-Type", "application/json");

				if (url.pathname === "/health" && req.method === "GET") {
					res.writeHead(200);
					res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
					return;
				}

				if (url.pathname === "/users" && req.method === "POST") {
					const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
					res.writeHead(201);
					res.end(JSON.stringify({ id: "user-42", ...parsed }));
					return;
				}

				if (url.pathname === "/error" && req.method === "GET") {
					res.writeHead(500);
					res.end(JSON.stringify({ error: "Something went wrong" }));
					return;
				}

				res.writeHead(404);
				res.end(JSON.stringify({ error: "Not found" }));
			});
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("Mock server did not bind to a port");
			}
			resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
		});
	});
}

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- get is callable: ${typeof get === "function"}`);
	console.log(`- post is callable: ${typeof post === "function"}`);
	console.log(`- ApiError is constructible: ${typeof ApiError === "function"}`);

	// ---- Start local mock server ----
	console.log("\n--- Mock HTTP server ---");
	const { server, baseUrl } = await startMockServer();
	console.log(`mock server listening at ${baseUrl}`);

	try {
		// ---- GET request ----
		console.log("\n--- GET /health ---");
		const health = await get<{ status: string; timestamp: number }>(`${baseUrl}/health`);
		console.log(`response: ${JSON.stringify(health)}`);
		if (health.status !== "ok" || typeof health.timestamp !== "number") {
			throw new Error("Unexpected GET /health response shape");
		}

		// ---- POST request ----
		console.log("\n--- POST /users ---");
		const created = await post<{ id: string; name: string }>(`${baseUrl}/users`, {
			name: "Tutorial User",
		});
		console.log(`response: ${JSON.stringify(created)}`);
		if (created.id !== "user-42" || created.name !== "Tutorial User") {
			throw new Error("Unexpected POST /users response shape");
		}

		// ---- ApiError handling ----
		console.log("\n--- ApiError on 500 ---");
		try {
			await get(`${baseUrl}/error`);
			throw new Error("Expected GET /error to throw ApiError");
		} catch (error) {
			if (!(error instanceof ApiError)) {
				throw new Error(`Expected an ApiError, got ${typeof error}`);
			}
			console.log(`caught ApiError: status=${error.status}, message=${error.message}`);
			if (error.status !== 500) {
				throw new Error("Expected ApiError status to be 500");
			}
		}
	} finally {
		server.close();
		console.log("\nmock server closed");
	}

	console.log("\n[OK] API tutorial completed");
}

export default main;

runIfMain("API tutorial", main, import.meta.url);
