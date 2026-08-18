import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpBackend } from "../src/backend-http.js";
import { makeConfig } from "./_helpers.js";

const fetchMock = vi.fn();

beforeEach(() => {
	process.env.OPENCONTEXT_DSH_HTTP_URL = "http://127.0.0.1:9999";
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.OPENCONTEXT_DSH_HTTP_URL = undefined;
	process.env.OPENCONTEXT_DSH_AUTHORIZATION = undefined;
});

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("createHttpBackend", () => {
	it("health checks /health/live and reports mode=http", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const backend = createHttpBackend(makeConfig());
		const h = await backend.health();
		expect(h.mode).toBe("http");
		expect(h.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:9999/health/live",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("health reports failure when fetch rejects", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
		const backend = createHttpBackend(makeConfig());
		const h = await backend.health();
		expect(h.ok).toBe(false);
		expect(h.details).toContain("ECONNREFUSED");
	});

	it("search POSTs to /v1/memory/search with the scope_id and limit", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "h1", content: "x", score: 0.7 }] }));
		const backend = createHttpBackend(makeConfig({ scopeId: "s1" }));
		const hits = await backend.search({ query: "hi", limit: 2 });
		expect(hits).toHaveLength(1);
		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(call[0]).toBe("http://127.0.0.1:9999/v1/memory/search");
		expect(call[1].method).toBe("POST");
		const body = JSON.parse(call[1].body as string);
		expect(body).toEqual({
			scope_id: "s1",
			query: "hi",
			limit: 2,
			mode: "auto",
		});
	});

	it("remember POSTs to /v1/memory/remember and returns ids", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ids: ["m1", "m2"] }));
		const backend = createHttpBackend(makeConfig());
		const r = await backend.remember({ content: "x" });
		expect(r.ids).toEqual(["m1", "m2"]);
		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(call[0]).toBe("http://127.0.0.1:9999/v1/memory/remember");
	});

	it("retire POSTs to /v1/memory/retire and returns ok", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const backend = createHttpBackend(makeConfig());
		const r = await backend.retire({ id: "x", reason: "stale" });
		expect(r.ok).toBe(true);
		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(call[0]).toBe("http://127.0.0.1:9999/v1/memory/retire");
		const body = JSON.parse(call[1].body as string);
		expect(body).toMatchObject({ citation: "x", reason: "stale" });
	});

	it("uses the Authorization header from env when present", async () => {
		process.env.OPENCONTEXT_DSH_AUTHORIZATION = "Bearer abcdef";
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const backend = createHttpBackend(makeConfig());
		await backend.health();
		const call = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = call[1].headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer abcdef");
	});

	it("maps a 503 response to server_unavailable when search fails", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: "down" }));
		const backend = createHttpBackend(makeConfig());
		await expect(backend.search({ query: "x" })).rejects.toMatchObject({
			statusCode: 503,
		});
	});
});
