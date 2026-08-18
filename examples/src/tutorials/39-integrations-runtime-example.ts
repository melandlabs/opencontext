/**
 * Tutorial: integrations-runtime helpers.
 *
 * Demonstrates the platform-agnostic runtime utilities from
 * `@melandlabs/integrations-runtime`:
 *
 *   - `getPlatformDisplayInfo` returns icon/label styling for a known integration.
 *   - `isIntegrationPlatformConnectable` gates whether a platform can be connected.
 *   - `inferTaskIntegrationRequirementsFromText` extracts source/notification
 *     platform requirements from free-form task text.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/39-integrations-runtime-example.ts
 */

import { runIfMain } from "../_helpers.ts";
import {
	getPlatformDisplayInfo,
	inferTaskIntegrationRequirementsFromText,
	isIntegrationPlatformConnectable,
} from "@melandlabs/integrations-runtime";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- getPlatformDisplayInfo is callable: ${typeof getPlatformDisplayInfo === "function"}`);
	console.log(
		`- isIntegrationPlatformConnectable is callable: ${typeof isIntegrationPlatformConnectable === "function"}`,
	);
	console.log(
		`- inferTaskIntegrationRequirementsFromText is callable: ${typeof inferTaskIntegrationRequirementsFromText === "function"}`,
	);

	// ---- Real API: platform display info ----
	console.log("\n--- getPlatformDisplayInfo ---");
	const telegramInfo = getPlatformDisplayInfo("telegram");
	console.log("- telegram display info:", JSON.stringify(telegramInfo));
	if (!telegramInfo.icon || !telegramInfo.label || !telegramInfo.iconBackground) {
		throw new Error("Expected platform display info to have icon, label, and iconBackground");
	}

	const gmailInfo = getPlatformDisplayInfo("gmail");
	console.log("- gmail display info:", JSON.stringify(gmailInfo));
	if (gmailInfo.label !== "Gmail") {
		throw new Error(`Expected Gmail label to be 'Gmail', got '${gmailInfo.label}'`);
	}

	// ---- Real API: connectability gate ----
	console.log("\n--- isIntegrationPlatformConnectable ---");
	const telegramConnectable = isIntegrationPlatformConnectable("telegram");
	const slackConnectable = isIntegrationPlatformConnectable("slack");
	console.log(`- telegram connectable: ${telegramConnectable}`);
	console.log(`- slack connectable: ${slackConnectable}`);
	if (!telegramConnectable || !slackConnectable) {
		throw new Error("Expected telegram and slack to be connectable");
	}

	// ---- Real API: requirement inference ----
	console.log("\n--- inferTaskIntegrationRequirementsFromText ---");
	const taskText = "Read my Gmail inbox and send a Slack message to the team";
	const requirements = inferTaskIntegrationRequirementsFromText(taskText);
	console.log("- inferred:", JSON.stringify(requirements));

	const sourceNames = requirements.sources.map((s) => s.name);
	const hasGmailSource = sourceNames.some((name) => name.startsWith("gmail:"));
	const hasSlackNotification = requirements.notificationChannels.some((channel) =>
		channel.startsWith("slack:"),
	);
	if (!hasGmailSource) {
		throw new Error(`Expected Gmail to be inferred as a source for text: ${taskText}`);
	}
	if (!hasSlackNotification) {
		throw new Error(`Expected Slack to be inferred as a notification channel for text: ${taskText}`);
	}

	// Empty text should return empty requirements.
	const emptyRequirements = inferTaskIntegrationRequirementsFromText("   ");
	if (emptyRequirements.sources.length !== 0 || emptyRequirements.notificationChannels.length !== 0) {
		throw new Error("Expected empty requirements for empty input text");
	}

	console.log("\n[OK] Integrations runtime tutorial completed");
}

export default main;

runIfMain("IntegrationsRuntime tutorial", main);
