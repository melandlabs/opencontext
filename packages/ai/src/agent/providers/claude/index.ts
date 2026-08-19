/**
 * Claude Code agent — thin {@link BaseAgent} implementation that drives the
 * Anthropic Claude Agent SDK's `query()` AsyncGenerator.
 *
 * This is the opencontext reference port: it wires the pure SDK helpers in
 * `./cli-locations.ts`, `./runtime-preflight.ts`, `./message-converter.ts`,
 * `./query-options.ts`, and `./process-spawner.ts` into a working `IAgent`,
 * but deliberately omits the opencontext-coupled layers (MCP server registry,
 * supplemental-input hooks, business-tools MCP, host permission callbacks,
 * per-session logging). Hosts that need those concerns should layer them on
 * by mutating the `Options` returned from `createClaudeQueryOptions` before
 * passing it to the SDK.
 */

import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { getOpenContextDir } from "@melandlabs/env-config";

import {
	type AgentConfig,
	type AgentMessage,
	type AgentOptions,
	type AgentPlugin,
	type AgentProvider,
	BaseAgent,
	CLAUDE_METADATA,
	type ExecuteOptions,
	PLANNING_INSTRUCTION,
	type PlanOptions,
	defineAgentPlugin,
	formatPlanForExecution,
	parsePlanFromResponse,
	parsePlanningResponse,
} from "../..";
import { type ClaudeSdkMessageConversionOptions, convertClaudeSdkMessage } from "./message-converter";
import { createClaudeCodeProcessSpawner } from "./process-spawner";
import { createClaudeQueryOptions } from "./query-options";
import { prepareClaudeCodeTempDirectory, redactClaudeRuntimeDiagnostic } from "./runtime-preflight";

import { type Options, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";

export {
	sanitizeClaudeAgentText,
	convertClaudeSdkMessage,
	extractClaudeResultUsage,
} from "./message-converter";
export { createClaudeCodeProcessSpawner } from "./process-spawner";
export { createClaudeQueryOptions, DEFAULT_ALLOWED_TOOLS } from "./query-options";
export {
	prepareClaudeCodeTempDirectory,
	createLineBufferedDiagnosticSink,
	redactClaudeRuntimeDiagnostic,
	extractSafeClaudeSdkErrorLines,
} from "./runtime-preflight";
export { getClaudeBundleDirectories } from "./cli-locations";

export class ClaudeAgent extends BaseAgent {
	readonly provider: AgentProvider = "claude";

	private messageCounter = 0;

	private generateMessageId(): string {
		return `claude_msg_${Date.now()}_${++this.messageCounter}`;
	}

	async *run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentMessage> {
		const session = this.createSession("executing", {
			abortController: options?.abortController,
		});

		yield {
			type: "session",
			sessionId: session.id,
			messageId: this.generateMessageId(),
		};

		try {
			const cwd = await this.resolveAndPrepareWorkDir(options);
			yield* this.runClaudeQuery(prompt, cwd, options, session.abortController.signal);
		} catch (error) {
			yield this.toErrorMessage(error);
		} finally {
			this.sessions.delete(session.id);
			yield { type: "done", messageId: this.generateMessageId() };
		}
	}

	async *plan(prompt: string, options?: PlanOptions): AsyncGenerator<AgentMessage> {
		const session = this.createSession("planning", {
			abortController: options?.abortController,
		});

		yield {
			type: "session",
			sessionId: session.id,
			messageId: this.generateMessageId(),
		};

		let fullResponse = "";
		try {
			const cwd = await this.resolveAndPrepareWorkDir(options);
			const planningPrompt = `${PLANNING_INSTRUCTION(options?.timezone ?? undefined)}\n\n${prompt}`;
			const planningOptions: AgentOptions = {
				...options,
				permissionMode: "plan",
			};

			for await (const message of this.runClaudePrompt(
				planningPrompt,
				cwd,
				planningOptions,
				session.abortController.signal,
			)) {
				if (message.type === "text" && message.content) {
					fullResponse += message.content;
					yield message;
				} else if (message.type === "error") {
					yield message;
					return;
				}
			}

			const planningResult = parsePlanningResponse(fullResponse);
			if (planningResult?.type === "direct_answer") {
				yield {
					type: "direct_answer",
					content: planningResult.answer,
					messageId: this.generateMessageId(),
				};
				return;
			}

			const plan =
				planningResult?.type === "plan" ? planningResult.plan : parsePlanFromResponse(fullResponse);
			if (plan && plan.steps.length > 0) {
				this.storePlan(plan);
				yield {
					type: "plan",
					plan,
					messageId: this.generateMessageId(),
				};
				return;
			}

			yield {
				type: "direct_answer",
				content: fullResponse.trim(),
				messageId: this.generateMessageId(),
			};
		} catch (error) {
			yield this.toErrorMessage(error);
		} finally {
			this.sessions.delete(session.id);
			yield { type: "done", messageId: this.generateMessageId() };
		}
	}

	async *execute(options: ExecuteOptions): AsyncGenerator<AgentMessage> {
		const plan = options.plan || this.getPlan(options.planId);

		if (!plan) {
			yield {
				type: "session",
				sessionId: options.sessionId,
				messageId: this.generateMessageId(),
			};
			yield {
				type: "error",
				message: `Plan not found: ${options.planId}`,
				messageId: this.generateMessageId(),
			};
			yield { type: "done", messageId: this.generateMessageId() };
			return;
		}

		let completedSuccessfully = false;

		try {
			const cwd = await this.resolveAndPrepareWorkDir(options);
			const executionPrompt = `${formatPlanForExecution(
				plan,
				cwd,
				undefined,
				options.aiSoulPrompt ?? undefined,
				options.language ?? undefined,
				options.timezone ?? undefined,
			)}\n\nOriginal request: ${options.originalPrompt}`;

			let sawError = false;
			for await (const message of this.run(executionPrompt, { ...options, cwd })) {
				if (message.type === "error") {
					sawError = true;
				}
				yield message;
			}

			completedSuccessfully = !sawError && !options.abortController?.signal.aborted;
		} finally {
			if (completedSuccessfully) {
				this.deletePlan(options.planId);
			}
		}
	}

	private async *runClaudeQuery(
		prompt: string,
		cwd: string,
		options?: AgentOptions,
		signal?: AbortSignal,
	): AsyncGenerator<AgentMessage> {
		yield* this.runClaudePrompt(prompt, cwd, options, signal);
	}

	private async *runClaudePrompt(
		prompt: string,
		cwd: string,
		options?: AgentOptions,
		signal?: AbortSignal,
	): AsyncGenerator<AgentMessage> {
		const abortController = new AbortController();
		if (signal) {
			if (signal.aborted) abortController.abort(signal.reason);
			else signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
		}
		if (options?.abortController) {
			const outer = options.abortController;
			if (outer.signal.aborted) abortController.abort(outer.signal.reason);
			else
				outer.signal.addEventListener("abort", () => abortController.abort(outer.signal.reason), {
					once: true,
				});
		}

		const providerConfig = (this.config.providerConfig ?? {}) as Record<string, unknown>;
		const claudeCodePath =
			typeof providerConfig.claudeCodePath === "string" && providerConfig.claudeCodePath
				? providerConfig.claudeCodePath
				: "claude";

		// Surface stderr through a redaction-aware line sink so application logs
		// never see raw credentials from the CLI.
		const diagnosticLines: string[] = [];
		const spawnClaudeCodeProcess = createClaudeCodeProcessSpawner((line) => {
			diagnosticLines.push(redactClaudeRuntimeDiagnostic(line));
		});

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		env.CLAUDE_CODE_ENTRYPOINT = "opencontext-sdk";
		// Ensure the SDK temp directory is usable before handing the env to
		// query(); the helper removes unsafe overrides and returns an Error
		// describing what went wrong.
		const tmpError = await prepareClaudeCodeTempDirectory(env);
		if (tmpError) {
			yield {
				type: "error",
				message: `Claude Code temp directory rejected: ${tmpError.message}`,
				messageId: this.generateMessageId(),
			};
			return;
		}

		const settingSources = Array.isArray(providerConfig.settingSources)
			? (providerConfig.settingSources.filter(
					(value): value is "user" | "project" => value === "user" || value === "project",
				) as ("user" | "project")[])
			: (["user", "project"] as ("user" | "project")[]);

		const sdkOptions: Options = createClaudeQueryOptions({
			sessionId: abortController.signal.toString(),
			cwd,
			settingSources,
			settings: typeof providerConfig.settings === "string" ? providerConfig.settings : undefined,
			allowedTools: Array.isArray(providerConfig.allowedTools)
				? (providerConfig.allowedTools.filter((t): t is string => typeof t === "string") as string[])
				: [],
			agentOptions: {
				permissionMode: options?.permissionMode,
				disallowedTools: options?.disallowedTools,
			},
			abortController,
			env,
			config: this.config,
			claudeCodePath,
			systemPrompt: options?.aiSoulPrompt ?? "",
			tools: { type: "preset", preset: "claude_code" },
			maxTurns: typeof providerConfig.maxTurns === "number" ? providerConfig.maxTurns : undefined,
			includePartialMessages:
				typeof providerConfig.includePartialMessages === "boolean"
					? providerConfig.includePartialMessages
					: undefined,
			spawnClaudeCodeProcess,
		});

		const sentTextHashes = new Set<string>();
		const sentToolIds = new Set<string>();
		let hasStreamedText = false;
		let totalCost: number | undefined;
		let inputTokens = 0;
		let outputTokens = 0;
		let sawUsage = false;
		const start = Date.now();

		const conversionContext: ClaudeSdkMessageConversionOptions = {
			message: undefined as unknown,
			sentTextHashes,
			sentToolIds,
			hasStreamedText,
			createMessageId: () => this.generateMessageId(),
		};

		try {
			for await (const sdkMessage of query({ prompt, options: sdkOptions }) as AsyncIterable<SDKMessage>) {
				conversionContext.message = sdkMessage;
				conversionContext.hasStreamedText = hasStreamedText;
				for (const agentMessage of convertClaudeSdkMessage(conversionContext)) {
					if (agentMessage.type === "result") {
						if (typeof agentMessage.cost === "number") totalCost = agentMessage.cost;
						if (agentMessage.usage) {
							inputTokens += agentMessage.usage.inputTokens;
							outputTokens += agentMessage.usage.outputTokens;
							sawUsage = true;
						}
					}
					yield agentMessage;
				}
				hasStreamedText = conversionContext.hasStreamedText;
			}
		} catch (error) {
			yield this.toErrorMessage(error);
			return;
		}

		if (diagnosticLines.length > 0) {
			// Diagnostic lines are already redacted by the spawner callback —
			// surface them to the host console via stderr so they reach the
			// application log without leaking credentials.
			for (const line of diagnosticLines) {
				process.stderr.write(`[claude] ${line}`);
			}
		}

		yield {
			type: "result",
			content: "success",
			cost: totalCost,
			duration: Date.now() - start,
			usage: sawUsage ? { inputTokens, outputTokens } : undefined,
			messageId: this.generateMessageId(),
		};
	}

	private toErrorMessage(error: unknown): AgentMessage {
		return {
			type: "error",
			message: error instanceof Error ? error.message : String(error),
			messageId: this.generateMessageId(),
		};
	}

	private async resolveAndPrepareWorkDir(options?: AgentOptions) {
		const rawWorkDir = options?.cwd || this.config.workDir || getOpenContextDir();
		const resolved = isAbsolute(rawWorkDir) ? rawWorkDir : join(process.cwd(), rawWorkDir);
		await mkdir(resolved, { recursive: true });
		return resolved;
	}
}

export function createClaudeAgent(config: AgentConfig): ClaudeAgent {
	return new ClaudeAgent(config);
}

export const claudeAgentPlugin: AgentPlugin = defineAgentPlugin({
	metadata: CLAUDE_METADATA,
	factory: (config: AgentConfig) => createClaudeAgent(config),
});
