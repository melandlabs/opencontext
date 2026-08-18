import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPOSIO_GOOGLE_CALENDAR_TOOLKIT,
	COMPOSIO_GOOGLE_MEET_TOOLKIT,
	ComposioClient,
	ComposioIntegrationError,
	isComposioConfigured,
	isComposioCredentials,
} from "./index";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function getFetchInputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

function createMockFetch(responses: Array<{ matcher: string | RegExp; response: Response }>) {
	return vi.fn<typeof fetch>(async (input) => {
		const url = getFetchInputUrl(input);
		for (const { matcher, response } of responses) {
			if (typeof matcher === "string" ? url.includes(matcher) : matcher.test(url)) {
				return response;
			}
		}
		throw new Error(`Unexpected fetch call: ${url}`);
	});
}

describe("isComposioConfigured", () => {
	const originalKey = process.env.COMPOSIO_API_KEY;

	afterEach(() => {
		if (originalKey === undefined) {
			Reflect.deleteProperty(process.env, "COMPOSIO_API_KEY");
		} else {
			process.env.COMPOSIO_API_KEY = originalKey;
		}
	});

	it("returns true when COMPOSIO_API_KEY is set on process.env", () => {
		process.env.COMPOSIO_API_KEY = "test-api-key";
		expect(isComposioConfigured()).toBe(true);
	});

	it("returns false when COMPOSIO_API_KEY is absent from process.env", () => {
		Reflect.deleteProperty(process.env, "COMPOSIO_API_KEY");
		expect(isComposioConfigured()).toBe(false);
	});

	it("accepts a custom env object", () => {
		expect(isComposioConfigured({ COMPOSIO_API_KEY: "key" })).toBe(true);
		expect(isComposioConfigured({})).toBe(false);
	});
});

describe("isComposioCredentials", () => {
	it("returns true for composio provider", () => {
		expect(isComposioCredentials({ provider: "composio" })).toBe(true);
	});

	it("returns true when a connected account id is present", () => {
		expect(isComposioCredentials({ composioConnectedAccountId: "acc-123" })).toBe(true);
	});

	it("returns true when both provider and account id are present", () => {
		expect(
			isComposioCredentials({
				provider: "composio",
				composioConnectedAccountId: "acc-123",
			}),
		).toBe(true);
	});

	it("returns false for google_oauth without a connected account id", () => {
		expect(isComposioCredentials({ provider: "google_oauth" })).toBe(false);
	});

	it("returns false for null, undefined or empty credentials", () => {
		expect(isComposioCredentials(null)).toBe(false);
		expect(isComposioCredentials(undefined)).toBe(false);
		expect(isComposioCredentials({})).toBe(false);
	});
});

describe("ComposioClient", () => {
	it("throws when no api key is provided", () => {
		expect(() => new ComposioClient({ apiKey: null, env: {} })).toThrow(ComposioIntegrationError);
		expect(() => new ComposioClient({ apiKey: null, env: {} })).toThrow(
			"Composio integration is not configured",
		);
	});

	it("uses the provided api key, base url and fetch implementation", async () => {
		const mockFetch = createMockFetch([
			{
				matcher: "/auth_configs?",
				response: jsonResponse({ items: [{ id: "cfg-1", auth_scheme: "OAUTH2", status: "ACTIVE" }] }),
			},
		]);

		const client = new ComposioClient({
			apiKey: "my-key",
			baseUrl: "https://example.com/api/",
			fetchImpl: mockFetch,
			env: {},
		});

		const id = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT);
		expect(id).toBe("cfg-1");

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://example.com/api/auth_configs?toolkit_slug=googlecalendar&limit=100");
		expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "my-key" });
	});

	it("falls back to the default base url when none is provided", async () => {
		const mockFetch = createMockFetch([
			{
				matcher: "/auth_configs?",
				response: jsonResponse({ items: [{ id: "cfg-1", auth_scheme: "OAUTH2", status: "ACTIVE" }] }),
			},
		]);

		const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
		await client.resolveAuthConfigId(COMPOSIO_GOOGLE_MEET_TOOLKIT);

		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toMatch(/^https:\/\/backend\.composio\.dev\/api\/v3\.1/);
	});

	describe("resolveAuthConfigId", () => {
		it("returns the env-pinned id for the calendar toolkit", async () => {
			const mockFetch = vi.fn<typeof fetch>();
			const client = new ComposioClient({
				apiKey: "key",
				fetchImpl: mockFetch,
				env: { COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID: "env-calendar-cfg" },
			});

			const id = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT);
			expect(id).toBe("env-calendar-cfg");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("returns the env-pinned id for the meet toolkit", async () => {
			const mockFetch = vi.fn<typeof fetch>();
			const client = new ComposioClient({
				apiKey: "key",
				fetchImpl: mockFetch,
				env: { COMPOSIO_GOOGLE_MEET_AUTH_CONFIG_ID: "env-meet-cfg" },
			});

			const id = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_MEET_TOOLKIT);
			expect(id).toBe("env-meet-cfg");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("falls back to the older env names", async () => {
			const mockFetch = vi.fn<typeof fetch>();
			const client = new ComposioClient({
				apiKey: "key",
				fetchImpl: mockFetch,
				env: {
					COMPOSIO_CALENDAR_AUTH_CONFIG_ID: "legacy-calendar",
					COMPOSIO_MEET_AUTH_CONFIG_ID: "legacy-meet",
				},
			});

			expect(await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT)).toBe("legacy-calendar");
			expect(await client.resolveAuthConfigId(COMPOSIO_GOOGLE_MEET_TOOLKIT)).toBe("legacy-meet");
		});

		it("reuses an existing managed oauth config", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/auth_configs?",
					response: jsonResponse({
						items: [
							{
								id: "reusable-1",
								is_composio_managed: true,
								auth_scheme: "OAUTH2",
								status: "ACTIVE",
								toolkit: { slug: COMPOSIO_GOOGLE_CALENDAR_TOOLKIT },
							},
						],
					}),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			const id = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT);
			expect(id).toBe("reusable-1");
		});

		it("creates a new managed oauth config when none is reusable", async () => {
			const mockFetch = vi.fn<typeof fetch>(async (input) => {
				const url = getFetchInputUrl(input);

				if (url.includes("/auth_configs?")) {
					return jsonResponse({ items: [] });
				}

				if (url.endsWith("/auth_configs")) {
					return jsonResponse({ auth_config: { id: "created-cfg" } });
				}

				throw new Error(`Unexpected call: ${url}`);
			});

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			const id = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT);
			expect(id).toBe("created-cfg");
		});
	});

	describe("createConnectLink", () => {
		it("returns a connect link from the API response", async () => {
			const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
				const url = getFetchInputUrl(input);

				if (url.includes("/auth_configs?")) {
					return jsonResponse({ items: [{ id: "cfg-1", auth_scheme: "OAUTH2", status: "ACTIVE" }] });
				}

				if (url.endsWith("/connected_accounts/link")) {
					expect(init?.method).toBe("POST");
					const body = JSON.parse(init?.body as string);
					expect(body).toMatchObject({
						auth_config_id: "cfg-1",
						user_id: "user-1",
						callback_url: "https://example.com/callback",
					});

					return jsonResponse({
						redirect_url: "https://auth.example.com/link",
						connected_account_id: "acc-1",
						link_token: "token-1",
						expires_at: "2026-01-01T00:00:00Z",
					});
				}

				throw new Error(`Unexpected call: ${url}`);
			});

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			const link = await client.createConnectLink({
				toolkitSlug: COMPOSIO_GOOGLE_CALENDAR_TOOLKIT,
				userId: "user-1",
				callbackUrl: "https://example.com/callback",
			});

			expect(link).toEqual({
				redirectUrl: "https://auth.example.com/link",
				connectedAccountId: "acc-1",
				linkToken: "token-1",
				expiresAt: "2026-01-01T00:00:00Z",
				authConfigId: "cfg-1",
			});
		});

		it("throws when the response does not contain a redirect url", async () => {
			const mockFetch = vi.fn<typeof fetch>(async (input) => {
				const url = getFetchInputUrl(input);
				if (url.includes("/auth_configs?")) {
					return jsonResponse({ items: [{ id: "cfg-1", auth_scheme: "OAUTH2", status: "ACTIVE" }] });
				}
				if (url.endsWith("/connected_accounts/link")) {
					return jsonResponse({ connected_account_id: "acc-1" });
				}
				throw new Error(`Unexpected call: ${url}`);
			});

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			await expect(
				client.createConnectLink({
					toolkitSlug: COMPOSIO_GOOGLE_MEET_TOOLKIT,
					userId: "user-1",
					callbackUrl: "https://example.com/callback",
				}),
			).rejects.toThrow(ComposioIntegrationError);
		});
	});

	describe("getConnectedAccount", () => {
		it("fetches the connected account by id", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/connected_accounts/acc-123",
					response: jsonResponse({ id: "acc-123", status: "ACTIVE" }),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			const account = await client.getConnectedAccount("acc-123");

			expect(account).toEqual({ id: "acc-123", status: "ACTIVE" });
			const [url, init] = mockFetch.mock.calls[0];
			expect((init as RequestInit).method).toBe("GET");
			expect(url).toContain("/connected_accounts/acc-123");
		});
	});

	describe("proxy", () => {
		it("returns proxy data on success", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/tools/execute/proxy",
					response: jsonResponse({ data: { id: "evt-1" }, status: 200 }),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			const result = await client.proxy<{ id: string }>({
				connectedAccountId: "acc-1",
				endpoint: "/calendar/v3/calendars/primary/events",
				method: "GET",
			});

			expect(result).toEqual({ id: "evt-1" });
			const [, init] = mockFetch.mock.calls[0];
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body).toEqual({
				connected_account_id: "acc-1",
				endpoint: "/calendar/v3/calendars/primary/events",
				method: "GET",
				body: undefined,
			});
		});

		it("throws when the proxy reports a high status", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/tools/execute/proxy",
					response: jsonResponse({ status: 404, error: { message: "Not found" } }),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			await expect(
				client.proxy({ connectedAccountId: "acc-1", endpoint: "/missing", method: "GET" }),
			).rejects.toThrow(ComposioIntegrationError);
		});

		it("throws when the proxy response contains an error", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/tools/execute/proxy",
					response: jsonResponse({ error: "Proxy failed" }),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			await expect(
				client.proxy({ connectedAccountId: "acc-1", endpoint: "/x", method: "POST", body: {} }),
			).rejects.toThrow("Proxy failed");
		});
	});

	describe("request error handling", () => {
		it("throws a ComposioIntegrationError for non-ok responses", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/auth_configs?",
					response: jsonResponse({ message: "Invalid API key" }, { status: 401, statusText: "Unauthorized" }),
				},
			]);

			const client = new ComposioClient({ apiKey: "bad-key", fetchImpl: mockFetch, env: {} });
			const err = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT).catch((e) => e);
			expect(err).toBeInstanceOf(ComposioIntegrationError);
			expect(err.message).toContain("Invalid API key");
		});

		it("falls back to a generic message when the error body is empty", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/auth_configs?",
					response: new Response("", { status: 500, statusText: "Internal Server Error" }),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			await expect(client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT)).rejects.toThrow(
				"Composio request failed.",
			);
		});

		it("extracts error details from common response fields", async () => {
			const mockFetch = createMockFetch([
				{
					matcher: "/auth_configs?",
					response: jsonResponse({ error: "Rate limited" }, { status: 429 }),
				},
			]);

			const client = new ComposioClient({ apiKey: "key", fetchImpl: mockFetch, env: {} });
			const err = await client.resolveAuthConfigId(COMPOSIO_GOOGLE_CALENDAR_TOOLKIT).catch((e) => e);
			expect(err).toBeInstanceOf(ComposioIntegrationError);
			expect(err.message).toContain("Rate limited");
		});
	});
});
