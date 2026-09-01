import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeStructuredCall } from "./client";

import type { StructuredCallOptions, StructuredCallTool } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const fetchMock = vi.fn<FetchLike>();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllGlobals();
});

const TOOL: StructuredCallTool = {
	name: "submit_plan",
	description: "Submit the plan",
	input_schema: { type: "object" },
};

function baseOptions(overrides: Partial<StructuredCallOptions> = {}): StructuredCallOptions {
	return {
		baseUrl: "https://gateway.example/api/ai",
		authToken: "token-1",
		model: "openrouter/auto",
		system: "be a planner",
		user: "plan this event",
		tools: [TOOL],
		toolName: TOOL.name,
		...overrides,
	};
}

function messagesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "z-ai/glm-5.3",
		stop_reason: "tool_use",
		usage: { input_tokens: 10, output_tokens: 20 },
		content: [{ type: "tool_use", id: "t1", name: TOOL.name, input: { summary: "s" } }],
		...overrides,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestBody(): Record<string, unknown> {
	const init = fetchMock.mock.calls[0][1];
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("executeStructuredCall", () => {
	it("resolves a forced tool_use response and sends the expected wire request", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, messagesBody()));

		const result = await executeStructuredCall(baseOptions());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example/api/ai/v1/messages");
		const init = fetchMock.mock.calls[0][1];
		expect(init?.method).toBe("POST");
		const headers = init?.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		expect(headers.Authorization).toBe("Bearer token-1");
		expect(headers["anthropic-version"]).toBe("2023-06-01");

		const body = requestBody();
		expect(body.model).toBe("openrouter/auto");
		expect(body.max_tokens).toBe(8000);
		expect(body.stream).toBe(false);
		expect(body.system).toBe("be a planner");
		expect(body.messages).toEqual([{ role: "user", content: "plan this event" }]);
		expect(body.tools).toEqual([TOOL]);
		expect(body.tool_choice).toEqual({
			type: "tool",
			name: TOOL.name,
			disable_parallel_tool_use: true,
		});
		expect(body.thinking).toEqual({ type: "disabled" });
		expect("provider" in body).toBe(false);

		expect(result).toEqual({
			ok: true,
			content: messagesBody().content,
			toolInput: { summary: "s" },
			source: "tool_use",
			responseModel: "z-ai/glm-5.3",
			stopReason: "tool_use",
			usage: { input_tokens: 10, output_tokens: 20 },
			status: 200,
		});
	});

	it("strips trailing slashes from the base URL", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, messagesBody()));
		await executeStructuredCall(baseOptions({ baseUrl: "https://gateway.example/api/ai/" }));
		expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.example/api/ai/v1/messages");
	});

	it("falls back to JSON embedded in a text block", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				200,
				messagesBody({
					stop_reason: "end_turn",
					content: [{ type: "text", text: 'here: {"summary":"s","actions":[]}' }],
				}),
			),
		);

		const result = await executeStructuredCall(baseOptions());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("text_json_fallback");
			expect(result.toolInput).toEqual({ summary: "s", actions: [] });
			expect(result.stopReason).toBe("end_turn");
		}
	});

	it("takes the first of multiple tool_use blocks and warns via onWarn", async () => {
		const onWarn = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn<FetchLike>().mockResolvedValue(
				jsonResponse(200, {
					...messagesBody(),
					usage: undefined,
					content: [
						{ type: "tool_use", id: "t1", name: TOOL.name, input: { first: true } },
						{ type: "tool_use", id: "t2", name: TOOL.name, input: { second: true } },
					],
				}),
			),
		);

		const result = await executeStructuredCall(baseOptions({ onWarn }));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.toolInput).toEqual({ first: true });
			expect(result.usage).toBeUndefined();
		}
		expect(onWarn).toHaveBeenCalledTimes(1);
		expect(onWarn.mock.calls[0][0]).toContain("multiple");
	});

	it("warns through console.warn with the module prefix by default", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn<FetchLike>().mockResolvedValue(
				jsonResponse(200, {
					...messagesBody(),
					content: [{ type: "text", text: "no json anywhere" }],
				}),
			),
		);

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		warnSpy.mockRestore();
		if (!result.ok) {
			expect(result.code).toBe("no_tool_use");
			expect(result.contentTypes).toEqual(["text"]);
		}
	});

	it("ignores tool_use blocks under a different name", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<FetchLike>().mockResolvedValue(
				jsonResponse(
					200,
					messagesBody({
						content: [
							{ type: "tool_use", id: "t0", name: "other_tool", input: { nope: true } },
							{ type: "text", text: '{"summary":"s"}' },
						],
					}),
				),
			),
		);

		const result = await executeStructuredCall(baseOptions());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe("text_json_fallback");
			expect(result.toolInput).toEqual({ summary: "s" });
		}
	});

	it("reports no_tool_use when nothing is recoverable", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				200,
				messagesBody({
					content: [
						{ type: "text", text: "just prose" },
						{ type: "thinking", thinking: "..." },
					],
				}),
			),
		);

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("no_tool_use");
			expect(result.contentTypes).toEqual(["text", "thinking"]);
			expect(result.status).toBe(200);
		}
	});

	it("maps a 402 to http_error with the Anthropic error envelope", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(402, { error: { type: "credits", message: "insufficient credits" } }),
		);

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("http_error");
			expect(result.status).toBe(402);
			expect(result.message).toBe("HTTP 402: insufficient credits");
			expect(result.errorBody).toContain("insufficient credits");
		}
	});

	it("falls back to the raw body text for non-JSON 500 responses", async () => {
		fetchMock.mockResolvedValue(jsonResponse(500, "upstream exploded"));

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("http_error");
			expect(result.status).toBe(500);
			expect(result.message).toContain("upstream exploded");
		}
	});

	it("classifies transport failures as network_error", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("network_error");
			expect(result.message).toBe("fetch failed");
		}
	});

	it("classifies a TimeoutError DOMException as timeout", async () => {
		fetchMock.mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("timeout");
		}
	});

	it("classifies an AbortError DOMException as aborted", async () => {
		fetchMock.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("aborted");
		}
	});

	it("plumbs a caller-owned abort signal through AbortSignal.any", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			"fetch",
			vi.fn<FetchLike>().mockImplementation(async (_input, init) => {
				if (init?.signal?.aborted) {
					throw new DOMException("The operation was aborted.", "AbortError");
				}
				return jsonResponse(200, messagesBody());
			}),
		);

		const result = await executeStructuredCall(baseOptions({ signal: controller.signal }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("aborted");
		}
	});

	it("returns decode_error for a 200 body that is not JSON", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, "not json at all"));

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("decode_error");
			expect(result.message).toContain("not valid JSON");
		}
	});

	it("returns decode_error when content is not an array", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, messagesBody({ content: {} })));

		const result = await executeStructuredCall(baseOptions());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("decode_error");
			expect(result.message).toContain("content");
		}
	});

	it("omits thinking when disableThinking is false and forwards provider when given", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, messagesBody()));

		await executeStructuredCall(
			baseOptions({
				disableThinking: false,
				provider: { require_parameters: true },
				maxTokens: 1234,
				timeoutMs: 5000,
			}),
		);

		const body = requestBody();
		expect("thinking" in body).toBe(false);
		expect(body.provider).toEqual({ require_parameters: true });
		expect(body.max_tokens).toBe(1234);
	});

	it("lets options.headers override the defaults", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, messagesBody()));

		await executeStructuredCall(
			baseOptions({ headers: { "anthropic-version": "custom-version", "x-tag": "1" } }),
		);

		const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["anthropic-version"]).toBe("custom-version");
		expect(headers["x-tag"]).toBe("1");
		expect(headers.Authorization).toBe("Bearer token-1");
	});

	it("uses an injected fetchImpl instead of the global fetch", async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, messagesBody()));
		const globalSpy = vi.fn<FetchLike>();
		vi.stubGlobal("fetch", globalSpy);

		const result = await executeStructuredCall(baseOptions({ fetchImpl }));

		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(globalSpy).not.toHaveBeenCalled();
	});
});
