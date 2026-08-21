import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentMessage, TaskPlan } from "../../types";
import {
	CodexCommandNotFoundError,
	buildCodexRunCommand,
	normalizeCodexProviderConfig,
	resolveCodexSandboxMode,
} from "./command";
import {
	CodexAgent,
	type CodexInterruptedContext,
	formatCodexInterruptedError,
	parseCodexInterruptedError,
} from "./index";
import { parseCodexJsonLine } from "./parser";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
});

describe("Codex command builder", () => {
	it("builds the MVP exec --json command with default sandbox + skip-git-repo-check", () => {
		const command = buildCodexRunCommand({
			prompt: "fix the failing tests",
			cwd: "/workspace/project",
			model: "gpt-4.1",
			providerConfig: {
				codexPath: "codex-bin",
				profile: "work",
			},
		});

		expect(command.command).toBe("codex-bin");
		expect(command.args).toEqual([
			"exec",
			"--json",
			"--disable",
			"goals",
			"-p",
			"work",
			"-m",
			"gpt-4.1",
			"--sandbox",
			process.platform === "darwin" ? "danger-full-access" : "workspace-write",
			"--skip-git-repo-check",
		]);
		expect(command.stdin).toBe("fix the failing tests");
		expect(command.args).not.toContain("--full-auto");
	});

	it("runs macOS execution turns without the workspace-write sandbox", () => {
		for (const mode of ["run", "execute"] as const) {
			for (const configuredSandbox of [undefined, "workspace-write"] as const) {
				expect(resolveCodexSandboxMode(mode, configuredSandbox, "darwin")).toBe("danger-full-access");
			}
		}
	});

	it("preserves an explicit read-only sandbox for macOS execution", () => {
		expect(resolveCodexSandboxMode("execute", "read-only", "darwin")).toBe("read-only");
	});

	it("keeps workspace-write as the Linux and Windows execution default", () => {
		for (const platform of ["linux", "win32"] as const) {
			expect(resolveCodexSandboxMode("run", undefined, platform)).toBe("workspace-write");
		}
	});

	it("forces read-only sandbox and skips --full-auto during planning", () => {
		const command = buildCodexRunCommand({
			prompt: "draft a plan",
			cwd: "/workspace/project",
			mode: "plan",
			permissionMode: "bypassPermissions",
			providerConfig: { fullAuto: true },
		});

		const sandboxIdx = command.args.indexOf("--sandbox");
		expect(sandboxIdx).toBeGreaterThan(-1);
		expect(command.args[sandboxIdx + 1]).toBe("read-only");
		expect(command.args).not.toContain("--full-auto");
	});

	it("passes --full-auto only for bypassPermissions with explicit provider opt-in", () => {
		const command = buildCodexRunCommand({
			prompt: "ship it",
			cwd: "/workspace/project",
			permissionMode: "bypassPermissions",
			providerConfig: { fullAuto: true },
		});

		expect(command.args).toContain("--full-auto");
		expect(command.stdin).toBe("ship it");
	});

	it("does not pass --full-auto for bypassPermissions without explicit opt-in", () => {
		const command = buildCodexRunCommand({
			prompt: "ship it",
			cwd: "/workspace/project",
			permissionMode: "bypassPermissions",
			providerConfig: { fullAuto: false },
		});

		expect(command.args).not.toContain("--full-auto");
	});

	it("passes image paths as Codex CLI attachments", () => {
		const command = buildCodexRunCommand({
			prompt: "describe the attached image",
			cwd: "/workspace/project",
			imagePaths: [" /tmp/one.png ", "/tmp/two.jpg"],
		});

		expect(command.args).toEqual(
			expect.arrayContaining(["--image", "/tmp/one.png", "--image", "/tmp/two.jpg"]),
		);
		expect(command.stdin).toBe("describe the attached image");
	});

	it("rejects unsafe sandbox/approval values and ignores unsafe extraArgs", () => {
		const command = buildCodexRunCommand({
			prompt: "validate input",
			cwd: "/workspace/project",
			providerConfig: {
				sandbox: "danger-full-access",
				askForApproval: "never",
				extraArgs: ["--full-auto", "safe-arg", "--sandbox"],
			},
		});

		expect(command.args).toContain("--sandbox");
		expect(command.args).toContain("danger-full-access");
		expect(command.args).not.toContain("--ask-for-approval");
		expect(command.args).not.toContain("never");
		const guardIndex = command.args.indexOf("--");
		expect(guardIndex).toBeGreaterThan(-1);
		expect(command.args[guardIndex + 1]).toBe("safe-arg");
	});

	it("normalizes timeoutMs from provider config", () => {
		const config = normalizeCodexProviderConfig({ timeoutMs: 12_345 });
		expect(config.timeoutMs).toBe(12_345);

		expect(normalizeCodexProviderConfig({ timeoutMs: -5 }).timeoutMs).toBeUndefined();
		expect(normalizeCodexProviderConfig({ timeoutMs: "nope" }).timeoutMs).toBeUndefined();
	});

	it("defaults skipGitRepoCheck to true and honours an explicit false", () => {
		expect(normalizeCodexProviderConfig({}).skipGitRepoCheck).toBe(true);
		expect(normalizeCodexProviderConfig({ skipGitRepoCheck: false }).skipGitRepoCheck).toBe(false);
	});
});

describe("Codex parser", () => {
	it("ignores empty and invalid JSON lines", () => {
		expect(parseCodexJsonLine("")).toEqual([]);
		expect(parseCodexJsonLine("   ")).toEqual([]);
		expect(parseCodexJsonLine("not-json")).toEqual([]);
	});

	it("projects thread.started into a session message", () => {
		expect(parseCodexJsonLine(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }))).toEqual([
			{ type: "session", sessionId: "thread-1" },
		]);
	});

	it("projects agent_message and reasoning items into text/reasoning", () => {
		expect(
			parseCodexJsonLine(
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", id: "msg-1", text: "hello" },
				}),
			),
		).toEqual([{ type: "text", content: "hello" }]);

		expect(
			parseCodexJsonLine(
				JSON.stringify({
					type: "item.completed",
					item: { type: "reasoning", id: "r-1", text: "thinking" },
				}),
			),
		).toEqual([{ type: "reasoning", content: "thinking" }]);
	});

	it("emits tool_use + tool_result for completed command_execution items", () => {
		expect(
			parseCodexJsonLine(
				JSON.stringify({
					type: "item.completed",
					item: {
						type: "command_execution",
						id: "cmd-1",
						command: "pwd",
						aggregated_output: "/workspace/project\n",
						exit_code: 0,
						status: "completed",
					},
				}),
			),
		).toEqual([
			{
				type: "tool_result",
				toolUseId: "cmd-1",
				output: "/workspace/project\n",
				isError: false,
			},
		]);
	});

	it("marks failed command executions with isError: true", () => {
		const messages = parseCodexJsonLine(
			JSON.stringify({
				type: "item.completed",
				item: {
					type: "command_execution",
					id: "cmd-2",
					command: "false",
					aggregated_output: "boom",
					exit_code: 1,
					status: "failed",
				},
			}),
		);
		expect(messages).toEqual([
			{
				type: "tool_result",
				toolUseId: "cmd-2",
				output: "boom",
				isError: true,
			},
		]);
	});

	it("only emits tool_use for running command_execution items", () => {
		expect(
			parseCodexJsonLine(
				JSON.stringify({
					type: "item.started",
					item: {
						type: "command_execution",
						id: "cmd-3",
						command: "sleep 5",
					},
				}),
			),
		).toEqual([
			{
				type: "tool_use",
				id: "cmd-3",
				name: "shell",
				input: { command: "sleep 5" },
			},
		]);
	});

	it("projects file_change items into tool_result with summary", () => {
		expect(
			parseCodexJsonLine(
				JSON.stringify({
					type: "item.completed",
					item: {
						type: "file_change",
						id: "fc-1",
						changes: [
							{ path: "src/a.ts", kind: "update" },
							{ path: "src/b.ts", kind: "create" },
						],
					},
				}),
			),
		).toEqual([
			{
				type: "tool_result",
				toolUseId: "fc-1",
				output: "update src/a.ts\ncreate src/b.ts",
				isError: false,
			},
		]);
	});

	it("projects turn.completed usage onto a result message", () => {
		expect(
			parseCodexJsonLine(
				JSON.stringify({
					type: "turn.completed",
					usage: {
						input_tokens: 12,
						cached_input_tokens: 4,
						output_tokens: 6,
					},
				}),
			),
		).toEqual([
			{
				type: "result",
				content: "turn.completed",
				usage: { inputTokens: 12, outputTokens: 6 },
			},
		]);
	});

	it("classifies 'Reconnecting... n/m' as a retry, not a fatal error", () => {
		const messages = parseCodexJsonLine(
			JSON.stringify({
				type: "error",
				message: "Reconnecting... 2/5 (request timed out)",
			}),
		);
		expect(messages).toEqual([
			{
				type: "retry",
				content: "Reconnecting... 2/5 (request timed out)",
				retryKind: "reconnecting",
				attempt: 2,
				maxAttempts: 5,
			},
		]);
	});

	it("keeps a fatal Codex exit-code error fatal even when it mentions a transient keyword", () => {
		const messages = parseCodexJsonLine(
			JSON.stringify({
				type: "error",
				message: "Codex CLI exited with code 7: connection refused",
			}),
		);
		expect(messages).toEqual([
			{
				type: "error",
				message: "Codex CLI exited with code 7: connection refused",
			},
		]);
	});

	it("ignores unknown event types without crashing", () => {
		expect(parseCodexJsonLine(JSON.stringify({ type: "future.event", x: 1 }))).toEqual([]);
	});
});

describe("CodexAgent", () => {
	it("runs a thread, forwards session id, and yields text + result", async () => {
		const workDir = await createFakeCodexWorkDir(defaultFakeCodexScript());
		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		const messages = await collectMessages(agent.run("hello codex"));

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "session" }),
				expect.objectContaining({ type: "text", content: "hello" }),
				expect.objectContaining({ type: "tool_use", name: "shell" }),
				expect.objectContaining({
					type: "tool_result",
					output: "/workspace\n",
					isError: false,
				}),
				expect.objectContaining({
					type: "result",
					content: "success",
					usage: { inputTokens: 9, outputTokens: 4 },
				}),
			]),
		);
		expect(messages.at(-1)?.type).toBe("done");

		const args = JSON.parse(await readFile(join(workDir, "args.json"), "utf8")) as string[];
		expect(args).toContain("--json");
		expect(args).toContain("--sandbox");
		expect(args).toContain(process.platform === "darwin" ? "danger-full-access" : "workspace-write");
		expect(args).not.toContain("--ask-for-approval");
		expect(args).toContain("--skip-git-repo-check");
		expect(args).not.toContain("hello codex");
		expect(await readFile(join(workDir, "stdin.txt"), "utf8")).toBe("hello codex");
	});

	it("writes multiline conversation context to Codex stdin", async () => {
		const workDir = await createFakeCodexWorkDir(defaultFakeCodexScript());
		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		await collectMessages(
			agent.run("current question", {
				conversation: [
					{ role: "user", content: "之前的问题\n还有第二行" },
					{ role: "assistant", content: "飞书连接于六月十五日" },
				],
			}),
		);

		const args = JSON.parse(await readFile(join(workDir, "args.json"), "utf8")) as string[];
		const prompt = await readFile(join(workDir, "stdin.txt"), "utf8");
		expect(args).not.toContain(prompt);
		expect(prompt).toEqual(expect.stringContaining("之前的问题\n还有第二行"));
		expect(prompt).toEqual(expect.stringContaining("飞书连接于六月十五日"));
		expect(prompt).toEqual(expect.stringContaining("current question"));
	});

	it("converts a nonzero CLI exit into an error message", async () => {
		const workDir = await createFakeCodexWorkDir(`
console.log(JSON.stringify({ type: "error", message: "Reconnecting... 5/5 (request timed out)" }));
console.error("simulated failure");
process.exit(7);
`);

		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		const messages = await collectMessages(agent.run("do work"));

		expect(messages.find((message) => message.type === "retry")).toMatchObject({
			type: "retry",
			retryKind: "reconnecting",
			attempt: 5,
			maxAttempts: 5,
		});
		expect(messages.find((message) => message.type === "error")).toMatchObject({
			type: "error",
			message: expect.stringContaining("Codex CLI exited with code 7"),
		});
		expect(messages.find((message) => message.type === "error")?.message).toContain("simulated failure");
		expect(messages.find((message) => message.type === "result")).toBeUndefined();
		expect(messages.at(-1)?.type).toBe("done");
	});

	it("returns a clear error when the codex executable is missing", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "opencontext-codex-test-"));
		tempDirs.push(workDir);

		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: "definitely-not-opencontext-codex" },
		});

		const messages = await collectMessages(agent.run("do work"));

		expect(messages.find((message) => message.type === "error")).toMatchObject({
			type: "error",
			message: expect.stringContaining("Codex CLI executable not found"),
		});
		expect(messages.at(-1)?.type).toBe("done");
	});

	it("surfaces CodexCommandNotFoundError type when codex is missing", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "opencontext-codex-test-"));
		tempDirs.push(workDir);

		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: "definitely-not-opencontext-codex" },
		});

		const messages = await collectMessages(agent.run("anything"));
		const error = messages.find((message) => message.type === "error");
		expect(error?.message).toMatch(/Codex CLI executable not found/);
		expect(CodexCommandNotFoundError).toBeDefined();
	});

	it("forces read-only sandbox during planning and never opts into --full-auto", async () => {
		const workDir = await createFakeCodexWorkDir(
			fakeCodexScriptAfterPrompt(`
require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "text", text: JSON.stringify({ type: "direct_answer", answer: "ok" }) }));
`),
		);
		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath, fullAuto: true },
		});

		await collectMessages(agent.plan("draft a plan", { permissionMode: "bypassPermissions" }));

		const args = JSON.parse(await readFile(join(workDir, "args.json"), "utf8")) as string[];
		const sandboxIdx = args.indexOf("--sandbox");
		expect(sandboxIdx).toBeGreaterThan(-1);
		expect(args[sandboxIdx + 1]).toBe("read-only");
		expect(args).not.toContain("--full-auto");
	});

	it("retains and deletes plans across successful executions", async () => {
		const workDir = await createFakeCodexWorkDir(
			fakeCodexScriptAfterPrompt(`
require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "text", text: JSON.stringify({
  type: "plan",
  goal: "Do work",
  steps: [{ id: "1", description: "Complete implementation" }]
}) }));
`),
		);

		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		const planMessages = await collectMessages(agent.plan("plan the work"));
		const plan = planMessages.find((message) => message.type === "plan")?.plan as TaskPlan | undefined;
		expect(plan).toBeDefined();
		if (!plan) {
			throw new Error("Expected Codex planning to produce a plan");
		}
		const planId = plan.id;
		expect(agent.getPlan(planId)).toBe(plan);

		await writeFakeCodexScript(
			workDir,
			fakeCodexScriptAfterPrompt(`console.log(JSON.stringify({ type: "text", text: "done" }));`),
		);
		await collectMessages(agent.execute({ planId, originalPrompt: "do work" }));
		expect(agent.getPlan(planId)).toBeUndefined();
	});

	it("returns direct_answer when planning response is not a plan", async () => {
		const workDir = await createFakeCodexWorkDir(
			fakeCodexScriptAfterPrompt(`
console.log(JSON.stringify({ type: "text", text: JSON.stringify({ type: "direct_answer", answer: "42" }) }));
`),
		);
		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		const messages = await collectMessages(agent.plan("what is the answer?"));

		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "direct_answer", content: "42" })]),
		);
		expect(messages.at(-1)?.type).toBe("done");
	});

	it("returns an error when executing a missing plan", async () => {
		const agent = new CodexAgent({
			provider: "codex",
			workDir: await mkdtemp(join(tmpdir(), "opencontext-codex-test-")),
		});

		const messages = await collectMessages(
			agent.execute({ planId: "missing-plan", originalPrompt: "do work" }),
		);

		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("Plan not found: missing-plan"),
				}),
				expect.objectContaining({ type: "done" }),
			]),
		);
	});

	it("decodes UTF-8 JSON events split across stdout chunks", async () => {
		const workDir = await createFakeCodexWorkDir(
			fakeCodexScriptAfterPrompt(`
const payload = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "msg-1", text: "你好" } }) + "\\n");
const split = payload.indexOf(Buffer.from("你")) + 1;
process.stdout.write(payload.subarray(0, split));
setTimeout(() => process.stdout.write(payload.subarray(split)), 10);
`),
		);
		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		const messages = await collectMessages(agent.run("unicode"));

		expect(messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "text", content: "你好" })]),
		);
	});

	it("emits interrupted tool_results + a structured error when the provider timeout fires", async () => {
		const workDir = await createFakeCodexWorkDir(`
require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "file_change", id: "fc-1", changes: [{ path: "report.md", kind: "create" }] }
}));
console.log(JSON.stringify({
  type: "item.started",
  item: { type: "command_execution", id: "cmd-hang", command: "sleep 60" }
}));
setInterval(() => {}, 1000);
`);

		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath, timeoutMs: 250 },
		});

		const messages = await collectMessages(agent.run("long task"));

		const interruptedResult = messages.find(
			(message) => message.type === "tool_result" && message.toolUseId === "cmd-hang",
		);
		expect(interruptedResult).toMatchObject({
			type: "tool_result",
			toolUseId: "cmd-hang",
			isError: true,
		});

		const error = messages.find(
			(message) =>
				message.type === "error" &&
				typeof message.message === "string" &&
				message.message.startsWith("__CODEX_INTERRUPTED__"),
		);
		expect(error).toBeDefined();
		if (!error?.message) {
			throw new Error("Expected a structured Codex interruption message");
		}
		const interruption = parseCodexInterruptedError(error.message);
		expect(interruption).toMatchObject({
			workspacePath: workDir,
			completedArtifacts: ["report.md"],
			canResume: true,
		});
		expect(messages.at(-1)?.type).toBe("done");
	});

	it("stops a running session when the abort signal fires", async () => {
		const workDir = await createFakeCodexWorkDir(`
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "msg-1", text: "hello" } }));
setInterval(() => {}, 1000);
`);

		const abortController = new AbortController();
		const agent = new CodexAgent({
			provider: "codex",
			workDir,
			providerConfig: { codexPath: process.execPath },
		});

		const collectedPromise = collectMessages(agent.run("hang", { abortController }));
		setTimeout(() => abortController.abort("user cancelled"), 150);
		const messages = await collectedPromise;

		expect(messages.at(-1)?.type).toBe("done");
	});
});

describe("Codex interrupted marker", () => {
	it("round-trips workspace + completed artifacts through format/parse", () => {
		const context: CodexInterruptedContext = {
			timeoutMs: 900_000,
			workspacePath: "/workspace/project",
			completedArtifacts: ["data.csv", "report.md"],
		};

		const raw = formatCodexInterruptedError(context);
		const parsed = parseCodexInterruptedError(raw);
		expect(parsed).toEqual({
			...context,
			canResume: true,
		});
	});

	it("returns null for unrelated errors", () => {
		expect(parseCodexInterruptedError("Codex CLI exited with code 7")).toBeNull();
		expect(parseCodexInterruptedError("")).toBeNull();
	});
});

async function createFakeCodexWorkDir(script: string) {
	const workDir = await mkdtemp(join(tmpdir(), "opencontext-codex-test-"));
	tempDirs.push(workDir);
	await writeFakeCodexScript(workDir, script, "exec");
	return workDir;
}

async function writeFakeCodexScript(workDir: string, script: string, filename = "exec") {
	await writeFile(join(workDir, filename), script, "utf8");
}

function fakeCodexScriptAfterPrompt(body: string) {
	return `
process.stdin.resume();
process.stdin.on("end", () => {
${body}
});
`;
}

function defaultFakeCodexScript() {
	return `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.145.0");
  process.exit(0);
}
// Wire stdin consumers BEFORE the args.json write. On loaded CI runners
// the fs write can take long enough that the parent already delivers and
// half-closes stdin; if no consumer is attached by then the kernel sees
// no reader on the pipe and the parent's end() surfaces as EPIPE,
// tripping runCodexCommand's "successful exit with failed delivery = fatal"
// guard. Real Codex resumes stdin eagerly, never gated on disk I/O.
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
fs.writeFileSync("args.json", JSON.stringify(args));
process.stdin.on("end", () => {
  fs.writeFileSync("stdin.txt", stdin);
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
  console.log(JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", id: "cmd-1", command: "pwd" }
  }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", id: "cmd-1", command: "pwd", aggregated_output: "/workspace\\n", exit_code: 0, status: "completed" }
  }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", id: "msg-1", text: "hello" }
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 4 }
  }));
});
`;
}

async function collectMessages(generator: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
	const messages: AgentMessage[] = [];
	for await (const message of generator) {
		messages.push(message);
	}
	return messages;
}
