import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig, AgentMessage, TaskPlan } from "../../types";
import { type ClaudeAgent, createClaudeAgent } from "./index";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: queryMock,
	tool: vi.fn((name, description, schema, handler) => ({ name, description, schema, handler })),
	createSdkMcpServer: vi.fn(() => ({ name: "test-server" })),
}));

const tempDirs: string[] = [];

afterEach(async () => {
	queryMock.mockReset();
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
});

beforeEach(() => {
	queryMock.mockReset();
});

function createAgent(config: Partial<AgentConfig> = {}): ClaudeAgent {
	return createClaudeAgent({
		provider: "claude",
		apiKey: "test-key",
		model: "claude-sonnet-4-20250514",
		workDir: "~/.opencontext",
		...config,
	});
}

function assistantTextMessage(text: string): unknown {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	};
}

function resultMessage(usage?: { input_tokens: number; output_tokens: number }): unknown {
	return {
		type: "result",
		subtype: "success",
		total_cost_usd: 0.001,
		duration_ms: 1234,
		usage,
	};
}

async function collectMessages(generator: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
	const messages: AgentMessage[] = [];
	for await (const message of generator) {
		messages.push(message);
	}
	return messages;
}

describe("ClaudeAgent factory", () => {
	it("creates an agent with the claude provider", () => {
		const agent = createAgent();
		expect(agent.provider).toBe("claude");
		expect(agent.type).toBe("claude");
		expect(agent.name).toBe("claude Agent");
	});
});

describe("ClaudeAgent run", () => {
	it("yields session, text, result, and done on a successful run", async () => {
		queryMock.mockImplementation(async function* () {
			yield assistantTextMessage("hello");
			yield resultMessage({ input_tokens: 5, output_tokens: 3 });
		});

		const agent = createAgent();
		const messages = await collectMessages(agent.run("say hello"));

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "session" }),
				expect.objectContaining({ type: "text", content: "hello" }),
				expect.objectContaining({
					type: "result",
					content: "success",
					usage: { inputTokens: 5, outputTokens: 3 },
				}),
			]),
		);
		expect(messages.at(-1)?.type).toBe("done");
	});

	it("passes providerConfig overrides to the SDK query options", async () => {
		queryMock.mockImplementation(async function* () {
			yield resultMessage();
		});

		const workDir = await mkdtemp(join(tmpdir(), "opencontext-claude-test-"));
		tempDirs.push(workDir);

		const agent = createAgent({
			workDir,
			providerConfig: {
				claudeCodePath: "/custom/claude",
				settingSources: ["project"],
				allowedTools: ["Read", "Write"],
				maxTurns: 42,
			},
		});

		await collectMessages(agent.run("test"));

		expect(queryMock).toHaveBeenCalledTimes(1);
		const call = queryMock.mock.calls[0] as [{ prompt: string; options: Record<string, unknown> }];
		const options = call[0].options;
		expect(options.pathToClaudeCodeExecutable).toBe("/custom/claude");
		expect(options.settingSources).toEqual(["project"]);
		expect(options.allowedTools).toEqual(["Read", "Write"]);
		expect(options.maxTurns).toBe(42);
		expect(options.cwd).toBe(workDir);
	});

	it("forwards the abort signal to the SDK and still yields done", async () => {
		const abortController = new AbortController();
		queryMock.mockImplementation(async function* () {
			yield assistantTextMessage("starting");
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (abortController.signal.aborted) {
				throw new Error("aborted");
			}
			yield resultMessage();
		});

		const agent = createAgent();
		const runPromise = collectMessages(agent.run("hang", { abortController }));
		setTimeout(() => abortController.abort("user cancelled"), 100);
		const messages = await runPromise;

		expect(messages.at(-1)?.type).toBe("done");
	});

	it("converts SDK errors into AgentMessage.error", async () => {
		queryMock.mockImplementation(() => {
			throw new Error("SDK boom");
		});

		const agent = createAgent();
		const messages = await collectMessages(agent.run("explode"));

		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "error", message: "SDK boom" })]),
		);
		expect(messages.at(-1)?.type).toBe("done");
	});
});

describe("ClaudeAgent plan", () => {
	it("returns a structured plan when the model emits a plan", async () => {
		const planPayload = {
			type: "plan",
			goal: "Implement feature",
			steps: [{ id: "1", description: "Write tests" }],
		};
		queryMock.mockImplementation(async function* () {
			yield assistantTextMessage(JSON.stringify(planPayload));
			yield resultMessage();
		});

		const agent = createAgent();
		const messages = await collectMessages(agent.plan("add auth"));

		const planMessage = messages.find((message) => message.type === "plan");
		expect(planMessage).toBeDefined();
		const plan = planMessage?.plan as TaskPlan | undefined;
		expect(plan).toMatchObject({
			goal: "Implement feature",
			steps: [{ id: "1", description: "Write tests" }],
		});
		expect(messages.at(-1)?.type).toBe("done");

		if (!plan) throw new Error("Expected plan to be defined");
		expect(agent.getPlan(plan.id)).toBe(plan);
	});

	it("returns direct_answer when the model emits one", async () => {
		queryMock.mockImplementation(async function* () {
			yield assistantTextMessage(JSON.stringify({ type: "direct_answer", answer: "42" }));
			yield resultMessage();
		});

		const agent = createAgent();
		const messages = await collectMessages(agent.plan("what is the answer?"));

		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "direct_answer", content: "42" })]),
		);
		expect(messages.at(-1)?.type).toBe("done");
	});

	it("falls back to direct_answer for unstructured text", async () => {
		queryMock.mockImplementation(async function* () {
			yield assistantTextMessage("Just do it");
			yield resultMessage();
		});

		const agent = createAgent();
		const messages = await collectMessages(agent.plan("simple task"));

		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "direct_answer", content: "Just do it" })]),
		);
		expect(messages.at(-1)?.type).toBe("done");
	});
});

async function createPlan(
	agent: ClaudeAgent,
	planPayload: { goal: string; steps: { id: string; description: string }[] },
): Promise<TaskPlan> {
	const planResponse = {
		type: "plan" as const,
		goal: planPayload.goal,
		steps: planPayload.steps.map((step) => ({ ...step, status: "pending" as const })),
	};
	queryMock.mockImplementation(async function* () {
		yield assistantTextMessage(JSON.stringify(planResponse));
		yield resultMessage();
	});

	const messages = await collectMessages(agent.plan("plan the work"));
	const planMessage = messages.find((message) => message.type === "plan");
	const plan = planMessage?.plan;
	if (!plan) throw new Error("Expected planning to produce a plan");
	return plan;
}

describe("ClaudeAgent execute", () => {
	it("executes a stored plan and deletes it on success", async () => {
		const agent = createAgent();
		const plan = await createPlan(agent, {
			goal: "Do work",
			steps: [{ id: "1", description: "Complete implementation" }],
		});
		expect(agent.getPlan(plan.id)).toBe(plan);

		queryMock.mockImplementation(async function* () {
			yield assistantTextMessage("done");
			yield resultMessage();
		});

		const messages = await collectMessages(agent.execute({ planId: plan.id, originalPrompt: "do work" }));

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "session" }),
				expect.objectContaining({ type: "text", content: "done" }),
				expect.objectContaining({ type: "result", content: "success" }),
			]),
		);
		expect(agent.getPlan(plan.id)).toBeUndefined();
	});

	it("returns an error when the plan is missing", async () => {
		const agent = createAgent();
		const messages = await collectMessages(agent.execute({ planId: "missing", originalPrompt: "do work" }));

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("Plan not found: missing"),
				}),
				expect.objectContaining({ type: "done" }),
			]),
		);
	});

	it("keeps the plan when the SDK throws during execution", async () => {
		const agent = createAgent();
		const plan = await createPlan(agent, {
			goal: "Do work",
			steps: [{ id: "1", description: "Complete implementation" }],
		});
		expect(agent.getPlan(plan.id)).toBe(plan);

		queryMock.mockImplementation(() => {
			throw new Error("SDK boom");
		});

		const messages = await collectMessages(agent.execute({ planId: plan.id, originalPrompt: "do work" }));

		expect(messages.some((message) => message.type === "error")).toBe(true);
		expect(agent.getPlan(plan.id)).toBe(plan);
	});
});
