/**
 * Tutorial: drive OpenAI Codex CLI through OpenContext's CodexAgent.
 *
 * This example shows the provider-agnostic IAgent lifecycle using OpenAI's
 * Codex CLI (`codex exec --json`) as the underlying runtime:
 *
 *   1. Build a CodexAgent directly with `new CodexAgent()`.
 *   2. Run a read-only prompt and stream AgentMessage events.
 *   3. Plan a multi-step task (always read-only) and inspect the TaskPlan.
 *
 * Requirements:
 *   - `codex` CLI installed and authenticated.
 *   - OPENAI_API_KEY set in your environment.
 *
 * The live demo is skipped if the `codex` CLI is not on PATH. To keep the
 * tutorial safe, all live calls use a `read-only` sandbox so the workspace is
 * never modified.
 *
 * Run:
 *   cd examples
 *   node --env-file=../.env --experimental-strip-types src/tutorials/27-codex-agent-example.ts
 */

import process from "node:process";
import { CodexAgent, codexAgentPlugin } from "@melandlabs/ai/agent";
import { runIfMain } from "../_helpers.ts";
import { collectAgentMessages, hasCommand } from "./_agents.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- CodexAgent is a class: ${typeof CodexAgent === "function"}`);
	console.log(`- codexAgentPlugin metadata type: ${codexAgentPlugin.metadata.type}`);
	console.log(`- codexAgentPlugin supports plan: ${codexAgentPlugin.metadata.supportsPlan}`);

	if (!process.env.OPENAI_API_KEY || !hasCommand("codex")) {
		console.log("\nSkipping live CodexAgent calls:");
		console.log("  Set OPENAI_API_KEY and install the `codex` CLI to run the live demo.");
		return;
	}

	const workDir = "./.tmp-codex-agent";
	const agent = new CodexAgent({
		provider: "codex",
		model: "gpt-4.1",
		workDir,
		providerConfig: {
			// Force read-only sandbox for this tutorial so the workspace is never
			// modified. Remove this override to let Codex edit files.
			sandbox: "read-only",
			skipGitRepoCheck: true,
		},
	});

	// ---- Direct execution (read-only) ----
	const runMessages = await collectAgentMessages(
		agent.run("List the files in the current directory and report how many there are."),
		"run()",
	);
	const runFinishedOk =
		runMessages.some((m) => m.type === "result") || runMessages.some((m) => m.type === "text");
	if (!runFinishedOk) {
		throw new Error("CodexAgent run() did not produce any text or result message");
	}

	// ---- Planning (always read-only) ----
	const planMessages = await collectAgentMessages(
		agent.plan("Describe the steps needed to add a new example file to this project."),
		"plan()",
	);
	const planMsg = planMessages.find((m) => m.type === "plan");
	const directAnswerMsg = planMessages.find((m) => m.type === "direct_answer");
	if (!planMsg && !directAnswerMsg) {
		throw new Error("CodexAgent plan() did not return a plan or direct_answer");
	}

	console.log("\n[OK] CodexAgent tutorial completed");
	console.log("To see execute(), pass the planId from plan() to agent.execute({ planId, originalPrompt }).");
}

export default main;

runIfMain("CodexAgent tutorial", main, import.meta.url);
