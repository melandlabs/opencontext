import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, del, get, post, put } from "./index";

describe("@melandlabs/api", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("ApiError", () => {
		it("exposes message, status, and details", () => {
			const error = new ApiError("Not found", 404, { resource: "user" });
			expect(error.message).toBe("Not found");
			expect(error.status).toBe(404);
			expect(error.details).toEqual({ resource: "user" });
			expect(error.name).toBe("ApiError");
			expect(error instanceof Error).toBe(true);
			expect(error instanceof ApiError).toBe(true);
		});

		it("defaults details to undefined", () => {
			const error = new ApiError("Server error", 500);
			expect(error.details).toBeUndefined();
		});
	});

	describe("get", () => {
		it("sends a GET request and returns parsed JSON", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 1, name: "Alice" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await get<{ id: number; name: string }>("https://api.example.com/users/1");

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/users/1", {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			});
			expect(result).toEqual({ id: 1, name: "Alice" });
		});

		it("throws ApiError for non-OK responses with JSON error body", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "User not found" }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await get("https://api.example.com/users/99");
				expect.fail("expected get to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(ApiError);
				expect((error as ApiError).message).toBe("User not found");
				expect((error as ApiError).status).toBe(404);
			}
		});

		it("throws ApiError for non-OK responses with text error body", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));

			try {
				await get("https://api.example.com/users");
				expect.fail("expected get to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(ApiError);
				expect((error as ApiError).message).toBe("Bad Gateway");
				expect((error as ApiError).status).toBe(502);
			}
		});
	});

	describe("post", () => {
		it("serializes the body and sends a POST request", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 201 }));

			const result = await post<{ id: number }>("https://api.example.com/users", {
				name: "Bob",
				email: "bob@example.com",
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Bob", email: "bob@example.com" }),
			});
			expect(result).toEqual({ id: 2 });
		});

		it("omits the body when data is undefined", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

			await post("https://api.example.com/ping");

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/ping", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: undefined,
			});
		});
	});

	describe("put", () => {
		it("serializes the body and sends a PUT request", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ updated: true }), { status: 200 }));

			const result = await put<{ updated: boolean }>("https://api.example.com/users/1", {
				name: "Alice Updated",
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/users/1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Alice Updated" }),
			});
			expect(result).toEqual({ updated: true });
		});

		it("omits the body when data is undefined", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

			await put("https://api.example.com/users/1/enable");

			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/users/1/enable", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: undefined,
			});
		});
	});

	describe("del", () => {
		it("sends a DELETE request", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));

			const result = await del<{ deleted: boolean }>("https://api.example.com/users/1");

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/users/1", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
			});
			expect(result).toEqual({ deleted: true });
		});
	});

	describe("headers", () => {
		it("sends the default JSON content type header", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

			await post("https://api.example.com/users", { name: "Bob" });

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.example.com/users",
				expect.objectContaining({
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
	});

	describe("query parameters", () => {
		it("passes the URL with query string unchanged to fetch", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }])));

			const url = new URL("https://api.example.com/users");
			url.searchParams.set("page", "2");
			url.searchParams.set("limit", "10");

			await get(url.toString());

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.example.com/users?page=2&limit=10",
				expect.any(Object),
			);
		});
	});
});
