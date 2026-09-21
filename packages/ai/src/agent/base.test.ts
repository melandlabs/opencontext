/**
 * Unit tests for `BaseAgent.run`'s transparent auto-compact behaviour.
 *
 * When `providerConfig.compactor` is set, `BaseAgent.run` must:
 *   - Forward to `runCore` on the first attempt.
 *   - On `kind: "context_overflow"`, call `agent.compactContext` over
 *     `options.conversation`, yield a synthetic `retry` notice, then
 *     re-issue `runCore` (NOT `run` — re-entry would infinite-loop).
 *   - Pass the retry prompt through the loop unchanged (the caller
 *     never sees the overflow error itself).
 *
 * When no compactor is configured, `BaseAgent.run` must be a pure
 * pass-through to `runCore`: no compact call, no notice, no second
 * attempt on overflow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAgent } from "./base";
import type {
	AgentConfig,
	AgentMessage,
	AgentOptions,
	CompactContextInput,
	CompactContextResult,
	Compactor,
	ExecuteOptions,
	PlanOptions,
} from "./types";

class StubBaseAgent extends BaseAgent {
	readonly provider = "stub" as const;

	// Configurable runCore behaviour for each test.
	coreStreams: AsyncGenerator<AgentMessage>[] = [];
	coreCalls = 0;
	corePrompts: string[] = [];

	async *runCore(prompt: string, _options?: AgentOptions): AsyncGenerator<AgentMessage> {
		this.coreCalls += 1;
		this.corePrompts.push(prompt);
		const stream = this.coreStreams.shift();
		if (!stream) throw new Error("StubBaseAgent: no runCore stream queued");
		yield* stream;
	}

	async *plan(_prompt: string, _options?: PlanOptions): AsyncGenerator<AgentMessage> {
		yield { type: "error", message: "plan not implemented in stub" };
	}

	async *execute(_options: ExecuteOptions): AsyncGenerator<AgentMessage> {
		yield { type: "error", message: "execute not implemented in stub" };
	}
}

async function* textStream(text: string): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield { type: "text", sessionId: "s1", content: text };
	yield { type: "result", sessionId: "s1", content: text, duration: 50 };
}

async function* overflowStream(): AsyncGenerator<AgentMessage> {
	yield { type: "session", sessionId: "s1" };
	yield {
		type: "error",
		sessionId: "s1",
		message: "context_length_exceeded",
		kind: { kind: "context_overflow", message: "context_length_exceeded" },
	};
}

/**
 * Build a minimal Compactor stub that records `compact()` calls and
 * returns a canned result. Only `compact` is part of the public surface
 * used by the loop. Returned shape: `{ compactor, compactSpy }` so tests
 * can assert on the spy without losing the `Compactor` type at the
 * call site.
 */
function makeCompactorStub(): {
	compactor: Compactor;
	compactSpy: ReturnType<typeof vi.fn>;
} {
	const compactSpy = vi.fn(
		async (_input: CompactContextInput): Promise<CompactContextResult> => ({
			summary: "[COMPACTED]",
			messageCount: 3,
			level: "hard",
			originalTokens: 400,
			summaryTokens: 90,
		}),
	);
	const compactor: Compactor = { compact: compactSpy };
	return { compactor, compactSpy };
}

function makeAgent(providerConfig: AgentConfig["providerConfig"]): StubBaseAgent {
	const config: AgentConfig = { provider: "stub", providerConfig };
	return new StubBaseAgent(config);
}

describe("BaseAgent.run auto-compact", () => {
	it("is a pure pass-through to runCore when no compactor is configured", async () => {
		const agent = makeAgent(undefined);
		agent.coreStreams.push(textStream("hello"));

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi")) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(agent.coreCalls).toBe(1);
		expect(agent.corePrompts).toEqual(["hi"]);
	});

	it("forwards overflow errors verbatim when no compactor is configured", async () => {
		const agent = makeAgent(undefined);
		agent.coreStreams.push(overflowStream());

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi")) {
			collected.push(msg);
		}

		// No retry: the overflow error is surfaced unchanged.
		expect(collected.map((m) => m.type)).toEqual(["session", "error"]);
		expect(agent.coreCalls).toBe(1);
	});

	it("transparently compacts on overflow and yields a retry notice before the retry stream", async () => {
		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(textStream("after compaction"));

		const history = [
			{ role: "user" as const, content: "earlier 1" },
			{ role: "assistant" as const, content: "earlier 2" },
			{ role: "user" as const, content: "earlier 3" },
		];

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("summarize what we discussed", { conversation: history })) {
			collected.push(msg);
		}

		// First attempt: session only (overflow suppressed).
		// Then: synthetic retry notice.
		// Then: retry stream (session + text + result).
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "text", "result"]);
		expect((collected[1] as { message?: string }).message ?? "").toMatch(/\[auto-compact\] compacted/);
		expect(collected[1].attempt).toBe(2);
		expect(collected[1].maxAttempts).toBe(2);
		expect(agent.coreCalls).toBe(2);
		// compactor was invoked with the caller-supplied conversation.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const call = compactSpy.mock.calls[0][0] as CompactContextInput;
		expect(call.messages).toEqual(history);
		expect(call.level).toBe("hard");
	});

	it("calls runCore directly (never this.run) so the wrapper is not re-entered on overflow", async () => {
		const { compactor } = makeCompactorStub();
		const agent = makeAgent({ compactor });

		// Spy on the inherited `run` to assert it is NEVER invoked from
		// inside the wrapper — only `runCore` should be. The stub is wired
		// to overflow on every attempt; if `run` were re-entered we'd see
		// infinite recursion (and a stack / budget error) rather than the
		// expected budget-exhaustion behaviour.
		const runSpy = vi.spyOn(agent, "run");
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(overflowStream());

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("p", { conversation: [{ role: "user", content: "h" }] })) {
			collected.push(msg);
		}

		// The agent.run(...) generator was entered exactly once — the
		// outer caller. The retry path inside the wrapper must call
		// runCore, not run.
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(agent.coreCalls).toBe(2);
		expect(collected.map((m) => m.type)).toEqual(["session", "retry", "session", "error"]);
		expect((collected.at(-1) as { kind?: { kind: string } }).kind?.kind).toBe("context_overflow");
	});

	it("does NOT call compactContext when the first attempt succeeds", async () => {
		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(textStream("hello"));

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi", { conversation: [{ role: "user", content: "h" }] })) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(agent.coreCalls).toBe(1);
	});

	it("threads options (abortController, etc.) through to runCore on the first attempt", async () => {
		const { compactor } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(textStream("ok"));

		const ac = new AbortController();
		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi", { abortController: ac, conversation: [] })) {
			collected.push(msg);
		}

		expect(collected.map((m) => m.type)).toEqual(["session", "text", "result"]);
		expect(agent.coreCalls).toBe(1);
	});

	it("wires providerConfig.compactThresholdTokens into the proactive path", async () => {
		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({ compactor, compactThresholdTokens: 10 });
		agent.coreStreams.push(textStream("ok"));

		const collected: AgentMessage[] = [];
		for await (const msg of agent.run("hi", {
			conversation: [
				{ role: "user", content: "a long earlier message exceeding ten estimated tokens easily" },
			],
		})) {
			collected.push(msg);
		}

		// Proactive compaction fired before the first attempt — no overflow
		// error was needed.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(collected.map((m) => m.type)).toEqual(["retry", "session", "text", "result"]);
		expect((collected[0] as { message?: string }).message ?? "").toMatch(/proactively compacted/);
	});

	it("threads AgentOptions.onCompactionBaseline through to the recovery loop", async () => {
		const { compactor } = makeCompactorStub();
		const agent = makeAgent({ compactor });
		agent.coreStreams.push(overflowStream());
		agent.coreStreams.push(textStream("after compaction"));

		const baselines: Array<Array<{ role: string; content: string }>> = [];
		for await (const _msg of agent.run("p", {
			conversation: [
				{ role: "user", content: "earlier 1" },
				{ role: "assistant", content: "earlier 2" },
			],
			onCompactionBaseline: (baseline) => baselines.push(baseline),
		})) {
			void _msg;
		}

		expect(baselines).toHaveLength(1);
		expect(baselines[0][0].role).toBe("system");
		expect(baselines[0][0].content).toContain("[Carry-forward summary from earlier 2 message(s)]");
	});
});

/**
 * HTTP-first path tests.
 *
 * When `providerConfig.compactor` is NOT configured, `BaseAgent.compactContext`
 * POSTs the conversation to a resolved HTTP endpoint carrying the user's
 * bearer token plus whatever else the caller attached via
 * `compactionEndpoint.headers` (agent-level) or `extraHeaders` (per-call).
 * Resolution order:
 *
 *   input.compactionEndpoint → providerConfig.compactionEndpoint.baseUrl
 *     → process.env.COMPACTION_HTTP_ENDPOINT
 *   input.userToken → providerConfig.compactionUserToken
 *     → process.env.COMPACTION_HTTP_USER_TOKEN
 *
 * opencontext does NOT default any host-specific header (e.g. usage-task
 * attribution) — callers are responsible for attaching those via
 * `compactionEndpoint.headers` or `extraHeaders`.
 *
 * Tests stub `fetch` so no real network happens; they verify request shape
 * (URL, headers, body) and the `CompactContextResult` mapping.
 */
describe("BaseAgent.compactContext HTTP-first path", () => {
	type FetchFn = (
		input: string | URL,
		init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
	) => Promise<Response>;

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	// Snapshot the env vars we mutate so a stray `beforeEach` in any other
	// suite can't leak COMPACTION_HTTP_* into this one (and vice versa).
	const SAVED_COMPACTION_ENDPOINT = process.env.COMPACTION_HTTP_ENDPOINT;
	const SAVED_COMPACTION_USER_TOKEN = process.env.COMPACTION_HTTP_USER_TOKEN;
	beforeEach(() => {
		process.env.COMPACTION_HTTP_ENDPOINT = "";
		process.env.COMPACTION_HTTP_USER_TOKEN = "";
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		if (SAVED_COMPACTION_ENDPOINT === undefined) {
			process.env.COMPACTION_HTTP_ENDPOINT = "";
		} else {
			process.env.COMPACTION_HTTP_ENDPOINT = SAVED_COMPACTION_ENDPOINT;
		}
		if (SAVED_COMPACTION_USER_TOKEN === undefined) {
			process.env.COMPACTION_HTTP_USER_TOKEN = "";
		} else {
			process.env.COMPACTION_HTTP_USER_TOKEN = SAVED_COMPACTION_USER_TOKEN;
		}
	});

	it("POSTs the conversation to providerConfig.compactionEndpoint.baseUrl with bearer + caller-supplied headers", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () =>
			jsonResponse({
				content: [{ type: "text", text: "[HTTP SUMMARY]" }],
				usage: { input_tokens: 120, output_tokens: 33 },
				stop_reason: "end_turn",
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: {
				baseUrl: "https://compaction.example/api/ai/v1/messages",
				headers: { "x-test-task": "compact_context:agent:my-run" },
			},
			compactionUserToken: "user-tok-123",
		});

		const result = await agent.compactContext({
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			level: "hard",
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string>; body?: string },
		];
		expect(calledUrl).toBe("https://compaction.example/api/ai/v1/messages");
		expect(calledInit.method).toBe("POST");
		expect(calledInit.headers?.Authorization).toBe("Bearer user-tok-123");
		expect(calledInit.headers?.["x-test-task"]).toBe("compact_context:agent:my-run");
		expect(calledInit.headers?.["anthropic-version"]).toBe("2023-06-01");
		expect(calledInit.headers?.["Content-Type"]).toBe("application/json");
		const body = JSON.parse(calledInit.body ?? "{}");
		expect(body.model).toBeDefined();
		expect(body.max_tokens).toBe(2000);
		expect(body.system).toMatch(/HARD/);
		expect(body.messages).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);

		expect(result.summary).toBe("[HTTP SUMMARY]");
		expect(result.messageCount).toBe(2);
		expect(result.level).toBe("hard");
		expect(result.originalTokens).toBe(120);
		expect(result.summaryTokens).toBe(33);
	});

	it("falls back to COMPACTION_HTTP_ENDPOINT + COMPACTION_HTTP_USER_TOKEN env vars", async () => {
		process.env.COMPACTION_HTTP_ENDPOINT = "https://compaction.example/env/v1/messages";
		process.env.COMPACTION_HTTP_USER_TOKEN = "env-tok-456";

		const fetchSpy = vi.fn<FetchFn>(async () =>
			jsonResponse({ content: [{ type: "text", text: "summary" }] }),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent(undefined);
		const result = await agent.compactContext({ messages: [{ role: "user", content: "m" }] });

		const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, { headers?: Record<string, string> }];
		expect(calledUrl).toBe("https://compaction.example/env/v1/messages");
		expect(calledInit.headers?.Authorization).toBe("Bearer env-tok-456");
		// opencontext does NOT default any host-specific header. Callers
		// are responsible for attaching the ones they need via
		// `compactionEndpoint.headers` or `extraHeaders`.
		expect(calledInit.headers?.["x-test-task"]).toBeUndefined();
		expect(result.summary).toBe("summary");
	});

	it("per-call overrides win over providerConfig + env (compactionEndpoint, userToken)", async () => {
		process.env.COMPACTION_HTTP_ENDPOINT = "https://compaction.example/env/v1/messages";
		process.env.COMPACTION_HTTP_USER_TOKEN = "env-tok";

		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: {
				baseUrl: "https://compaction.example/agent/v1/messages",
				headers: { "x-test-task": "compact_context:agent:agent" },
			},
			compactionUserToken: "agent-tok",
		});

		await agent.compactContext({
			messages: [{ role: "user", content: "x" }],
			compactionEndpoint: "https://compaction.example/percall/v1/messages",
			userToken: "percall-tok",
		});

		const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, { headers?: Record<string, string> }];
		expect(calledUrl).toBe("https://compaction.example/percall/v1/messages");
		expect(calledInit.headers?.Authorization).toBe("Bearer percall-tok");
		// caller-supplied headers at the agent level stay put unless
		// overridden via `extraHeaders` (which is a per-call-only field).
		expect(calledInit.headers?.["x-test-task"]).toBe("compact_context:agent:agent");
	});

	it("omits the Authorization header when no userToken is available at any level", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: { baseUrl: "https://compaction.example/v1/messages" },
		});

		await agent.compactContext({ messages: [{ role: "user", content: "x" }] });

		const [, calledInit] = fetchSpy.mock.calls[0] as [string, { headers?: Record<string, string> }];
		expect(calledInit.headers?.Authorization).toBeUndefined();
		// opencontext does NOT default any host-specific header.
		expect(calledInit.headers?.["x-test-task"]).toBeUndefined();
	});

	it("merges input.extraHeaders LAST so callers can override defaults", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: {
				baseUrl: "https://compaction.example/v1/messages",
				headers: { "x-trace-id": "agent-trace" },
			},
		});

		await agent.compactContext({
			messages: [{ role: "user", content: "x" }],
			extraHeaders: { "x-trace-id": "percall-trace" },
		});

		const [, calledInit] = fetchSpy.mock.calls[0] as [string, { headers?: Record<string, string> }];
		expect(calledInit.headers?.["x-trace-id"]).toBe("percall-trace");
	});

	it("uses maxSummaryTokens from input as max_tokens in the request body", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: { baseUrl: "https://compaction.example/v1/messages" },
		});

		await agent.compactContext({
			messages: [{ role: "user", content: "x" }],
			maxSummaryTokens: 512,
		});

		const [, calledInit] = fetchSpy.mock.calls[0] as [string, { body?: string }];
		const body = JSON.parse(calledInit.body ?? "{}");
		expect(body.max_tokens).toBe(512);
	});

	it("throws an actionable error when no compactor and no endpoint are configured", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ content: [{ type: "text", text: "never" }] }));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent(undefined);
		await expect(agent.compactContext({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
			/compactionEndpoint|Compactor/,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("throws when the endpoint returns a non-2xx status, surfacing the response body", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ error: "bad request" }, 400));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: { baseUrl: "https://compaction.example/v1/messages" },
		});
		await expect(agent.compactContext({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
			/compactContext HTTP 400/,
		);
	});

	it("preserves the providerConfig.compactor fallback — does NOT issue an HTTP call", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () =>
			jsonResponse({ content: [{ type: "text", text: "should-not-fire" }] }),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const { compactor, compactSpy } = makeCompactorStub();
		const agent = makeAgent({
			compactor,
			compactionEndpoint: { baseUrl: "https://compaction.example/v1/messages" },
			compactionUserToken: "user-tok",
		});

		const result = await agent.compactContext({ messages: [{ role: "user", content: "x" }] });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.summary).toBe("[COMPACTED]");
	});

	it("POSTs to the OpenAI Chat Completions API when protocol is 'openai'", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () =>
			jsonResponse({
				choices: [
					{
						message: { role: "assistant", content: "[OPENAI SUMMARY]" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 88, completion_tokens: 22 },
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: {
				baseUrl: "https://compaction.example/v1/chat/completions",
				protocol: "openai",
			},
			compactionUserToken: "user-tok",
		});

		const result = await agent.compactContext({
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			level: "hard",
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string>; body?: string },
		];
		expect(calledUrl).toBe("https://compaction.example/v1/chat/completions");
		expect(calledInit.method).toBe("POST");
		expect(calledInit.headers?.Authorization).toBe("Bearer user-tok");
		// OpenAI mode does NOT add anthropic-version — the caller is free to
		// add their own via `compactionEndpoint.headers`.
		expect(calledInit.headers?.["anthropic-version"]).toBeUndefined();
		expect(calledInit.headers?.["Content-Type"]).toBe("application/json");
		const body = JSON.parse(calledInit.body ?? "{}");
		expect(body.model).toBeDefined();
		expect(body.max_tokens).toBe(2000);
		// OpenAI carries the system prompt as the first message — there is
		// NO separate `system` field.
		expect(body.system).toBeUndefined();
		expect(body.messages[0]).toMatchObject({ role: "system" });
		expect(body.messages[0].content).toMatch(/HARD/);
		expect(body.messages.slice(1)).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);

		expect(result.summary).toBe("[OPENAI SUMMARY]");
		expect(result.messageCount).toBe(2);
		expect(result.level).toBe("hard");
		expect(result.originalTokens).toBe(88);
		expect(result.summaryTokens).toBe(22);
	});

	it("OpenAI path surfaces non-2xx HTTP status with the same error shape", async () => {
		const fetchSpy = vi.fn<FetchFn>(async () => jsonResponse({ error: "rate limited" }, 429));
		vi.stubGlobal("fetch", fetchSpy);

		const agent = makeAgent({
			compactionEndpoint: {
				baseUrl: "https://compaction.example/v1/chat/completions",
				protocol: "openai",
			},
		});
		await expect(agent.compactContext({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
			/compactContext HTTP 429/,
		);
	});
});
