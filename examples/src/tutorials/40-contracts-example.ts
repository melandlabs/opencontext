/**
 * Tutorial: OpenContext contracts.
 *
 * Demonstrates the canonical type guards and enumerations from
 * `@melandlabs/contracts`:
 *
 *   - `USER_TYPES` and `isUserType` for valid user tiers.
 *   - `INTEGRATION_IDS` and `isIntegrationId` for supported integrations.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/40-contracts-example.ts
 */

import { INTEGRATION_IDS, USER_TYPES, isIntegrationId, isUserType } from "@melandlabs/contracts";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- USER_TYPES is an array: ${Array.isArray(USER_TYPES)}`);
	console.log(`- INTEGRATION_IDS is an array: ${Array.isArray(INTEGRATION_IDS)}`);
	console.log(`- isUserType is callable: ${typeof isUserType === "function"}`);
	console.log(`- isIntegrationId is callable: ${typeof isIntegrationId === "function"}`);

	// ---- Real API: user-type guard ----
	console.log("\n--- USER_TYPES / isUserType ---");
	console.log(`- user types: ${USER_TYPES.join(", ")}`);
	if (!USER_TYPES.includes("pro")) {
		throw new Error("Expected USER_TYPES to include 'pro'");
	}
	if (!isUserType("pro")) {
		throw new Error("Expected 'pro' to be a valid user type");
	}
	if (!isUserType("guest")) {
		throw new Error("Expected 'guest' to be a valid user type");
	}
	if (isUserType("admin")) {
		throw new Error("Expected 'admin' to be rejected as an invalid user type");
	}
	if (isUserType(123)) {
		throw new Error("Expected numeric input to be rejected by isUserType");
	}

	// ---- Real API: integration-id guard ----
	console.log("\n--- INTEGRATION_IDS / isIntegrationId ---");
	console.log(`- integration count: ${INTEGRATION_IDS.length}`);
	if (!INTEGRATION_IDS.includes("telegram")) {
		throw new Error("Expected INTEGRATION_IDS to include 'telegram'");
	}
	if (!INTEGRATION_IDS.includes("slack")) {
		throw new Error("Expected INTEGRATION_IDS to include 'slack'");
	}
	if (!isIntegrationId("telegram")) {
		throw new Error("Expected 'telegram' to be a valid integration id");
	}
	if (!isIntegrationId("google_calendar")) {
		throw new Error("Expected 'google_calendar' to be a valid integration id");
	}
	if (isIntegrationId("matrix")) {
		throw new Error("Expected 'matrix' to be rejected as an invalid integration id");
	}
	if (isIntegrationId({ platform: "telegram" })) {
		throw new Error("Expected object input to be rejected by isIntegrationId");
	}

	console.log("\n[OK] Contracts tutorial completed");
}

export default main;

runIfMain("Contracts tutorial", main);
