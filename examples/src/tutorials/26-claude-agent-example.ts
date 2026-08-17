/**
 * Tutorial: drive Claude Code through OpenContext's ClaudeAgent.
 *
 * This example shows the provider-agnostic IAgent lifecycle using Anthropic's
 * Claude Code as the underlying runtime:
 *
 *   1. Build a ClaudeAgent directly with createClaudeAgent().
 *   2. Run a simple prompt and stream AgentMessage events.
 *   3. Plan a multi-step task and then execute the stored plan.
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY set in your environment, **or**
 *   - a working `claude` CLI installed and authenticated.
 *
 * The example skips the live LLM call if neither is available, but the static
 * surface checks still prove the package exports are wired correctly.
 *
 * Run:
 *   cd examples
 *   node --env-file=../.env --experimental-strip-types src/tutorials/26-claude-agent-example.ts
 */

import process from "node:process";
import { type AgentMessage, ClaudeAgent, claudeAgentPlugin, createClaudeAgent } from "@melandlabs/ai/agent";
import { runIfMain } from "../_helpers.ts";
import { collectAgentMessages, hasCommand } from "./_agents.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- ClaudeAgent is a class: ${typeof ClaudeAgent === "function"}`);
	console.log(`- createClaudeAgent is callable: ${typeof createClaudeAgent === "function"}`);
	console.log(`- claudeAgentPlugin metadata type: ${claudeAgentPlugin.metadata.type}`);
	console.log(`- claudeAgentPlugin supports plan: ${claudeAgentPlugin.metadata.supportsPlan}`);

	const canRunLive = Boolean(process.env.ANTHROPIC_API_KEY) || hasCommand("claude");
	if (!canRunLive) {
		console.log("\nSkipping live ClaudeAgent calls:");
		console.log("  Set ANTHROPIC_API_KEY or install the `claude` CLI to run the live demo.");
		return;
	}

	const workDir = "./.tmp-claude-agent";
	const agent = createClaudeAgent({
		provider: "claude",
		model: "claude-sonnet-4-20250514",
		workDir,
		providerConfig: {
			// Limit the number of autonomous turns to keep the tutorial short.
			maxTurns: 5,
		},
	});

	// ---- Direct execution ----
	const runMessages = await collectAgentMessages(
		agent.run("Reply with a single sentence confirming ClaudeAgent is reachable."),
		"run()",
	);
	const runFinishedOk =
		runMessages.some((m) => m.type === "result") || runMessages.some((m) => m.type === "text");
	if (!runFinishedOk) {
		throw new Error("ClaudeAgent run() did not produce any text or result message");
	}

	// ---- Planning ----
	const planMessages = await collectAgentMessages(
		agent.plan("List the Markdown files in the current directory and summarize their purpose."),
		"plan()",
	);
	const planMsg = planMessages.find((m) => m.type === "plan");
	const directAnswerMsg = planMessages.find((m) => m.type === "direct_answer");
	if (!planMsg && !directAnswerMsg) {
		throw new Error("ClaudeAgent plan() did not return a plan or direct_answer");
	}

	// ---- Execution (only when a plan was produced) ----
	if (planMsg) {
		const planId = planMsg.plan.id;
		const executeMessages = await collectAgentMessages(
			agent.execute({
				planId,
				originalPrompt: "List the Markdown files in the current directory and summarize their purpose.",
			}),
			"execute()",
		);
		const executeFinishedOk = executeMessages.some((m) => m.type === "result" || m.type === "text");
		if (!executeFinishedOk) {
			throw new Error("ClaudeAgent execute() did not produce any text or result message");
		}
	}

	console.log("\n[OK] ClaudeAgent tutorial completed");
}

export default main;

runIfMain("ClaudeAgent tutorial", main);
