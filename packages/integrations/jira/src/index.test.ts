import { AppError } from "@melandlabs/shared/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraAdapter, type JiraIssue } from "./index";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function getLastCall(
	fetchMock: ReturnType<typeof vi.fn>,
	index = 0,
): {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
} {
	const [url, init] = fetchMock.mock.calls[index];
	const requestInit = (init ?? {}) as RequestInit;
	const headers = (requestInit.headers ?? {}) as Record<string, string>;
	const body = typeof requestInit.body === "string" ? JSON.parse(requestInit.body) : requestInit.body;
	return { url: url as string, method: requestInit.method ?? "GET", headers, body };
}

describe("JiraAdapter static formatters", () => {
	describe("formatIssueDescription", () => {
		it("returns an empty string for missing description", () => {
			expect(JiraAdapter.formatIssueDescription(undefined)).toBe("");
			expect(JiraAdapter.formatIssueDescription({ type: "doc", version: 1 })).toBe("");
		});

		it("concatenates paragraph text with double newlines", () => {
			const description: JiraIssue["fields"]["description"] = {
				type: "doc",
				version: 1,
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "First paragraph." }],
					},
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "Line one." },
							{ type: "text", text: " Line two." },
						],
					},
				],
			};

			expect(JiraAdapter.formatIssueDescription(description)).toBe("First paragraph.\n\nLine one. Line two.");
		});

		it("skips empty paragraphs", () => {
			const description: JiraIssue["fields"]["description"] = {
				type: "doc",
				version: 1,
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "Only text" }] },
					{ type: "paragraph", content: [] },
				],
			};

			expect(JiraAdapter.formatIssueDescription(description)).toBe("Only text\n\n");
		});
	});

	describe("formatCommentBody", () => {
		it("returns an empty string for missing body", () => {
			expect(JiraAdapter.formatCommentBody(undefined)).toBe("");
			// biome-ignore lint/suspicious/noExplicitAny: platform-specific opaque type
			expect(JiraAdapter.formatCommentBody({ type: "doc", version: 1 } as any)).toBe("");
		});

		it("extracts text from comment ADF", () => {
			const body = {
				type: "doc",
				version: 1,
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "A comment." }],
					},
				],
			};

			expect(JiraAdapter.formatCommentBody(body)).toBe("A comment.");
		});
	});
});

describe("JiraAdapter", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("throws when the access token is missing", () => {
		expect(() => new JiraAdapter({ credentials: {} })).toThrow(AppError);
		expect(() => new JiraAdapter({ credentials: {} })).toThrow("Jira access token is missing");
	});

	it("uses a default instance url", () => {
		fetchMock.mockResolvedValue(jsonResponse({}));
		const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
		expect(adapter).toBeInstanceOf(JiraAdapter);
	});

	it("uses a custom instance url when provided", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ issues: [], total: 0, startAt: 0 }));

		const adapter = new JiraAdapter({
			credentials: {
				accessToken: "token",
				instanceUrl: "https://custom.atlassian.net",
			},
		});

		await adapter.searchIssues("project = TEST");
		const { url } = getLastCall(fetchMock);
		expect(url).toMatch(/^https:\/\/custom\.atlassian\.net\/rest\/api\/3\/search/);
	});

	describe("getIssue", () => {
		it("fetches an issue by key", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: "1", key: "TEST-1", self: "https://x" }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const issue = await adapter.getIssue("TEST-1");

			expect(issue.key).toBe("TEST-1");
			const { url, method, headers } = getLastCall(fetchMock);
			expect(method).toBe("GET");
			expect(url).toBe("https://api.atlassian.com/ex/jira/rest/api/3/issue/TEST-1");
			expect(headers.Authorization).toBe("Bearer token");
		});
	});

	describe("searchIssues", () => {
		it("posts a JQL search with default max results", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ issues: [], total: 0, startAt: 0 }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			await adapter.searchIssues("project = TEST");

			const { url, method, body } = getLastCall(fetchMock);
			expect(method).toBe("POST");
			expect(url).toBe("https://api.atlassian.com/ex/jira/rest/api/3/search");
			expect(body).toEqual({
				jql: "project = TEST",
				maxResults: 50,
				fields: [
					"summary",
					"description",
					"status",
					"priority",
					"issuetype",
					"assignee",
					"reporter",
					"created",
					"updated",
					"comment",
				],
			});
		});

		it("allows overriding max results", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ issues: [], total: 0, startAt: 0 }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			await adapter.searchIssues("project = TEST", 10);

			const { body } = getLastCall(fetchMock);
			expect(body).toMatchObject({ maxResults: 10 });
		});
	});

	describe("addComment", () => {
		it("posts a comment with an ADF body", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: "100", self: "https://x" }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const result = await adapter.addComment("TEST-1", "Nice work");

			expect(result).toEqual({ id: "100", self: "https://x" });
			const { url, method, body } = getLastCall(fetchMock);
			expect(method).toBe("POST");
			expect(url).toBe("https://api.atlassian.com/ex/jira/rest/api/3/issue/TEST-1/comment");
			expect(body).toEqual({
				body: {
					type: "doc",
					version: 1,
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "Nice work" }],
						},
					],
				},
			});
		});
	});

	describe("createIssue", () => {
		it("posts a minimal issue", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ key: "TEST-2", id: "2", self: "https://x" }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const result = await adapter.createIssue({
				projectKey: "TEST",
				summary: "A bug",
				issueType: "Bug",
			});

			expect(result).toEqual({ key: "TEST-2", id: "2", self: "https://x" });
			const { body } = getLastCall(fetchMock);
			expect(body).toEqual({
				fields: {
					project: { key: "TEST" },
					summary: "A bug",
					issuetype: { name: "Bug" },
				},
			});
		});

		it("includes optional description, priority and assignee", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ key: "TEST-3", id: "3", self: "https://x" }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			await adapter.createIssue({
				projectKey: "TEST",
				summary: "Task",
				description: "Do this",
				issueType: "Task",
				priority: "High",
				assigneeId: "abc-123",
			});

			// biome-ignore lint/suspicious/noExplicitAny: platform-specific opaque type
			const body = getLastCall(fetchMock).body as Record<string, any>;
			expect(body.fields.description).toEqual({
				type: "doc",
				version: 1,
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "Do this" }],
					},
				],
			});
			expect(body.fields.priority).toEqual({ name: "High" });
			expect(body.fields.assignee).toEqual({ id: "abc-123" });
		});
	});

	describe("getProjects", () => {
		it("fetches projects", async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([{ id: "1", key: "TEST", name: "Test", projectTypeKey: "software", self: "x" }]),
			);

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const projects = await adapter.getProjects();

			expect(projects).toHaveLength(1);
			const { url } = getLastCall(fetchMock);
			expect(url).toBe("https://api.atlassian.com/ex/jira/rest/api/3/project");
		});
	});

	describe("transitionIssue", () => {
		it("finds a transition by name and posts it", async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse({ transitions: [{ id: "10", name: "In Progress" }] }))
				.mockResolvedValueOnce(jsonResponse({}));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			await adapter.transitionIssue("TEST-1", "in progress");

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const { url: getUrl } = getLastCall(fetchMock, 0);
			expect(getUrl).toBe("https://api.atlassian.com/ex/jira/rest/api/3/issue/TEST-1/transitions");

			const { method: postMethod, body } = getLastCall(fetchMock, 1);
			expect(postMethod).toBe("POST");
			expect(body).toEqual({ transition: { id: "10" } });
		});

		it("throws when the transition is not found", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ transitions: [{ id: "1", name: "Done" }] }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const err = await adapter.transitionIssue("TEST-1", "blocked").catch((e) => e);
			expect(err).toBeInstanceOf(AppError);
			expect(err.message).toContain('Transition "blocked" not found for issue TEST-1');
		});
	});

	describe("searchAssignableUsers", () => {
		it("searches assignable users", async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([{ accountId: "1", displayName: "Alice", emailAddress: "a@x" }]),
			);

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const users = await adapter.searchAssignableUsers("ali");

			expect(users).toHaveLength(1);
			const { url } = getLastCall(fetchMock);
			expect(url).toBe(
				"https://api.atlassian.com/ex/jira/rest/api/3/user/assignable/search?query=ali&maxResults=20",
			);
		});

		it("includes projectKey when provided", async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			await adapter.searchAssignableUsers("bob", "TEST");

			const { url } = getLastCall(fetchMock);
			expect(url).toContain("query=bob");
			expect(url).toContain("projectKey=TEST");
		});
	});

	describe("error handling", () => {
		it("throws an AppError when the response is not ok", async () => {
			fetchMock.mockResolvedValue(new Response("Bad request", { status: 400, statusText: "Bad Request" }));

			const adapter = new JiraAdapter({ credentials: { accessToken: "token" } });
			const err = await adapter.getIssue("TEST-1").catch((e) => e);
			expect(err).toBeInstanceOf(AppError);
			expect(err.message).toContain("Jira API error: 400 Bad Request");
		});
	});
});
