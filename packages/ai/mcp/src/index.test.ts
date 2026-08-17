import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as mcp from "./index";

const originalEnv = { ...process.env };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textResponse(text: string, status = 200): Response {
	return new Response(text, { status });
}

describe("@melandlabs/mcp", () => {
	let tempDir: string;

	beforeEach(async () => {
		// Isolate from the caller's environment so defaults are deterministic.
		process.env = { ...originalEnv };
		process.env.OPENCONTEXT_API_URL = undefined;
		process.env.OPENCONTEXT_MCP_CONFIG_PATH = undefined;
		process.env.OPENCONTEXT_TOKEN_PATH = undefined;
		process.env.OPENCONTEXT_AUTH_TOKEN = undefined;

		tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
	});

	afterEach(async () => {
		process.env = { ...originalEnv };
		vi.unstubAllGlobals();
		vi.resetModules();
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	describe("getMcpConfigPath", () => {
		it("defaults to ~/.opencontext/mcp.json", () => {
			const configPath = mcp.getMcpConfigPath();
			expect(configPath).toMatch(/\.opencontext[/\\]mcp\.json$/);
		});

		it("respects OPENCONTEXT_MCP_CONFIG_PATH", () => {
			process.env.OPENCONTEXT_MCP_CONFIG_PATH = "/custom/mcp.json";
			expect(mcp.getMcpConfigPath()).toBe("/custom/mcp.json");
		});
	});

	describe("getOpenContextTokenPath", () => {
		it("defaults to ~/.opencontext/token", () => {
			const tokenPath = mcp.getOpenContextTokenPath();
			expect(tokenPath).toMatch(/\.opencontext[/\\]token$/);
		});

		it("respects OPENCONTEXT_TOKEN_PATH", () => {
			process.env.OPENCONTEXT_TOKEN_PATH = "/custom/token";
			expect(mcp.getOpenContextTokenPath()).toBe("/custom/token");
		});
	});

	describe("decodeStoredOpenContextToken", () => {
		it("returns an empty string unchanged", () => {
			expect(mcp.decodeStoredOpenContextToken("")).toBe("");
		});

		it("trims whitespace before decoding", () => {
			const encoded = Buffer.from("opencontext-token").toString("base64");
			expect(mcp.decodeStoredOpenContextToken(`  ${encoded}  `)).toBe("opencontext-token");
		});

		it("returns JWT-like tokens unchanged", () => {
			const jwt = "header.payload.signature";
			expect(mcp.decodeStoredOpenContextToken(jwt)).toBe(jwt);
		});

		it("decodes base64-wrapped tokens", () => {
			const encoded = Buffer.from("opencontext-token").toString("base64");
			expect(mcp.decodeStoredOpenContextToken(encoded)).toBe("opencontext-token");
		});

		it("returns the trimmed value when base64 decoding yields an empty string", () => {
			// A single space trims to an empty value, so the function returns it directly.
			expect(mcp.decodeStoredOpenContextToken(" ")).toBe("");
		});
	});

	describe("loadMcpServers", () => {
		it("returns an empty object when disabled", async () => {
			const servers = await mcp.loadMcpServers({ enabled: false });
			expect(servers).toEqual({});
		});

		it("returns an empty object when the config file is missing", async () => {
			process.env.OPENCONTEXT_MCP_CONFIG_PATH = path.join(tempDir, "missing.json");
			const servers = await mcp.loadMcpServers();
			expect(servers).toEqual({});
		});

		it("loads stdio, http, and sse server definitions", async () => {
			const configPath = path.join(tempDir, "mcp.json");
			process.env.OPENCONTEXT_MCP_CONFIG_PATH = configPath;
			await writeFile(
				configPath,
				JSON.stringify({
					mcpServers: {
						stdio: {
							command: "node",
							args: ["server.js"],
							env: { FOO: "bar" },
						},
						http: {
							type: "http",
							url: "http://example.com/mcp",
							headers: { "X-Api-Key": "secret" },
						},
						sse: {
							type: "sse",
							url: "http://example.com/sse",
						},
						defaultHttp: {
							url: "http://example.com/default",
						},
						ignored: { foo: "bar" },
					},
				}),
			);

			const servers = await mcp.loadMcpServers();
			expect(servers).toEqual({
				stdio: {
					type: "stdio",
					command: "node",
					args: ["server.js"],
					env: { FOO: "bar" },
				},
				http: {
					type: "http",
					url: "http://example.com/mcp",
					headers: { "X-Api-Key": "secret" },
				},
				sse: {
					type: "sse",
					url: "http://example.com/sse",
				},
				defaultHttp: {
					type: "http",
					url: "http://example.com/default",
				},
			});
		});

		it("supports a top-level mcpServers object without nesting", async () => {
			const configPath = path.join(tempDir, "mcp.json");
			process.env.OPENCONTEXT_MCP_CONFIG_PATH = configPath;
			await writeFile(
				configPath,
				JSON.stringify({
					stdio: { command: "node", args: ["top.js"] },
				}),
			);

			const servers = await mcp.loadMcpServers();
			expect(servers).toEqual({
				stdio: { type: "stdio", command: "node", args: ["top.js"] },
			});
		});
	});

	describe("readOpenContextAuthToken", () => {
		it("prefers OPENCONTEXT_AUTH_TOKEN over the file", async () => {
			// Use a JWT-shaped value so decodeStoredOpenContextToken leaves it unchanged.
			process.env.OPENCONTEXT_AUTH_TOKEN = "env.header.payload";
			process.env.OPENCONTEXT_TOKEN_PATH = path.join(tempDir, "token");
			await writeFile(process.env.OPENCONTEXT_TOKEN_PATH, "file-token");

			const result = await mcp.readOpenContextAuthToken();
			expect(result).toMatchObject({
				token: "env.header.payload",
				source: "env",
			});
		});

		it("decodes a base64 env token", async () => {
			process.env.OPENCONTEXT_AUTH_TOKEN = Buffer.from("encoded-env").toString("base64");
			const result = await mcp.readOpenContextAuthToken();
			expect(result.token).toBe("encoded-env");
			expect(result.source).toBe("env");
		});

		it("reads the token file when no env token is set", async () => {
			const tokenPath = path.join(tempDir, "token");
			process.env.OPENCONTEXT_TOKEN_PATH = tokenPath;
			// Store the token base64-encoded, matching how OpenContext Desktop writes it.
			await writeFile(tokenPath, Buffer.from("file-token-value").toString("base64"));

			const result = await mcp.readOpenContextAuthToken();
			expect(result).toMatchObject({
				token: "file-token-value",
				source: "file",
				path: tokenPath,
			});
		});

		it("reports missing when the token file does not exist", async () => {
			process.env.OPENCONTEXT_TOKEN_PATH = path.join(tempDir, "missing-token");

			const result = await mcp.readOpenContextAuthToken();
			expect(result.token).toBeNull();
			expect(result.source).toBe("missing");
			expect(result.error).toBeDefined();
		});
	});

	describe("OpenContextClient", () => {
		it("uses the provided base URL", () => {
			const client = new mcp.OpenContextClient({ baseUrl: "http://custom:9000/" });
			expect(client.baseUrl).toBe("http://custom:9000");
		});

		it("falls back to the default base URL", () => {
			const client = new mcp.OpenContextClient();
			expect(client.baseUrl).toBe("http://127.0.0.1:3414");
		});

		it("uses OPENCONTEXT_API_URL when no base URL is provided", () => {
			process.env.OPENCONTEXT_API_URL = "http://env-host:4000/";
			const client = new mcp.OpenContextClient();
			expect(client.baseUrl).toBe("http://env-host:4000");
		});

		it("sends an Authorization header with the client token", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				token: "client-token",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await client.request("/test");

			const [, init] = fetchImpl.mock.calls[0];
			expect(init?.headers).toBeInstanceOf(Headers);
			expect((init?.headers as Headers).get("Authorization")).toBe("Bearer client-token");
		});

		it("allows a per-request token to override the client token", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				token: "client-token",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await client.request("/test", { token: "request-token" });

			const [, init] = fetchImpl.mock.calls[0];
			expect((init?.headers as Headers).get("Authorization")).toBe("Bearer request-token");
		});

		it("omits Authorization when no token is set", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await client.request("/test");

			const [, init] = fetchImpl.mock.calls[0];
			expect((init?.headers as Headers).has("Authorization")).toBe(false);
		});

		it("getJson returns parsed JSON", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ user: "alice" }));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				fetchImpl: fetchImpl as typeof fetch,
			});

			const result = await client.getJson("/user");
			expect(result).toEqual({ user: "alice" });
			expect(fetchImpl).toHaveBeenCalledWith("http://local/user", expect.objectContaining({ method: "GET" }));
		});

		it("postJson serializes the body and sets content-type", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 1 }));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				fetchImpl: fetchImpl as typeof fetch,
			});

			const result = await client.postJson("/items", { name: "test" });
			expect(result).toEqual({ id: 1 });

			const [, init] = fetchImpl.mock.calls[0];
			expect(init?.method).toBe("POST");
			expect(init?.body).toBe(JSON.stringify({ name: "test" }));
			expect((init?.headers as Headers).get("Content-Type")).toBe("application/json");
		});

		it("throws OpenContextApiError with the server error message", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await expect(client.request("/private")).rejects.toMatchObject({
				name: "OpenContextApiError",
				message: "unauthorized",
				status: 401,
				body: { error: "unauthorized" },
			});
		});

		it("throws OpenContextApiError with a fallback message for text errors", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(textResponse("Internal Server Error", 500));
			const client = new mcp.OpenContextClient({
				baseUrl: "http://local",
				fetchImpl: fetchImpl as typeof fetch,
			});

			await expect(client.request("/boom")).rejects.toMatchObject({
				name: "OpenContextApiError",
				status: 500,
				body: "Internal Server Error",
			});
		});
	});

	describe("OpenContextApiError", () => {
		it("is an Error with status and body", () => {
			const error = new mcp.OpenContextApiError("boom", 502, { detail: "bad gateway" });
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe("OpenContextApiError");
			expect(error.message).toBe("boom");
			expect(error.status).toBe(502);
			expect(error.body).toEqual({ detail: "bad gateway" });
		});
	});

	describe("resolveOpenContextBaseUrl", () => {
		it("returns the first reachable base URL", async () => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockRejectedValueOnce(new Error("refused"))
				.mockResolvedValueOnce(jsonResponse({ user: "alice" }));

			const result = await mcp.resolveOpenContextBaseUrl({
				token: "token",
				timeoutMs: 100,
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).toBe("http://localhost:3414");
		});

		it("returns null when no candidate is reachable", async () => {
			const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("refused"));

			const result = await mcp.resolveOpenContextBaseUrl({
				timeoutMs: 100,
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).toBeNull();
		});
	});

	describe("checkOpenContextReadiness", () => {
		it("reports READY when the API accepts the token", async () => {
			const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ user: "alice" }));
			vi.stubGlobal("fetch", mockFetch);

			const readiness = await mcp.checkOpenContextReadiness({
				authToken: { token: "valid-token", source: "env" },
				timeoutMs: 100,
			});

			expect(readiness.ready).toBe(true);
			expect(readiness.state).toBe("READY");
			expect(readiness.api.reachable).toBe(true);
			expect(readiness.auth.ok).toBe(true);
		});

		it("reports TOKEN_REQUIRED when reachable but no token is provided", async () => {
			const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
			vi.stubGlobal("fetch", mockFetch);

			const readiness = await mcp.checkOpenContextReadiness({ timeoutMs: 100 });

			expect(readiness.ready).toBe(false);
			expect(readiness.state).toBe("TOKEN_REQUIRED");
			expect(readiness.token.present).toBe(false);
		});

		it("reports AUTH_FAILED when the token is rejected", async () => {
			const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
			vi.stubGlobal("fetch", mockFetch);

			const readiness = await mcp.checkOpenContextReadiness({
				authToken: { token: "bad-token", source: "env" },
				timeoutMs: 100,
			});

			expect(readiness.ready).toBe(false);
			expect(readiness.state).toBe("AUTH_FAILED");
		});

		it("reports API_ERROR on a server-side failure", async () => {
			const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(textResponse("boom", 500));
			vi.stubGlobal("fetch", mockFetch);

			const readiness = await mcp.checkOpenContextReadiness({
				authToken: { token: "token", source: "env" },
				timeoutMs: 100,
			});

			expect(readiness.ready).toBe(false);
			expect(readiness.state).toBe("API_ERROR");
		});

		it("reports DESKTOP_NOT_DETECTED when the API is unreachable", async () => {
			const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
			vi.stubGlobal("fetch", mockFetch);

			const readiness = await mcp.checkOpenContextReadiness({ timeoutMs: 100 });

			expect(readiness.ready).toBe(false);
			expect(readiness.state).toBe("DESKTOP_NOT_DETECTED");
			expect(readiness.api.reachable).toBe(false);
		});
	});

	describe("formatOpenContextReadiness", () => {
		it("includes state, reachability, token source, auth status, and next steps", () => {
			const formatted = mcp.formatOpenContextReadiness({
				ready: true,
				state: "READY",
				baseUrl: "http://127.0.0.1:3414",
				installUrl: "https://opencontext.ai/docs/getting-started",
				token: { present: true, source: "file", path: "/home/user/.opencontext/token" },
				api: {
					reachable: true,
					selectedBaseUrl: "http://127.0.0.1:3414",
					probes: [],
				},
				auth: { ok: true, status: 200 },
				nextSteps: ["All good."],
			});

			expect(formatted).toContain("OpenContext MCP readiness: READY");
			expect(formatted).toContain("Desktop API: reachable at http://127.0.0.1:3414");
			expect(formatted).toContain("Token: found via file");
			expect(formatted).toContain("Auth: passed");
			expect(formatted).toContain("Next steps:");
			expect(formatted).toContain("- All good.");
		});

		it("reports missing desktop and token correctly", () => {
			const formatted = mcp.formatOpenContextReadiness({
				ready: false,
				state: "DESKTOP_NOT_DETECTED",
				baseUrl: null,
				installUrl: "https://opencontext.ai/docs/getting-started",
				token: { present: false, source: "missing" },
				api: {
					reachable: false,
					selectedBaseUrl: null,
					probes: [],
				},
				auth: { ok: false },
				nextSteps: ["Install OpenContext."],
			});

			expect(formatted).toContain("OpenContext MCP readiness: DESKTOP_NOT_DETECTED");
			expect(formatted).toContain("Desktop API: not detected");
			expect(formatted).toContain("Token: missing");
			expect(formatted).toContain("Auth: not ready");
			expect(formatted).toContain("- Install OpenContext.");
		});
	});
});
