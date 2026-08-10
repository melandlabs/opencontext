/**
 * @melandlabs/contracts smoke test.
 *
 * Boundary types and helpers that every other package depends on. We
 * exercise the user-type helpers and verify the integration-id set is
 * loaded.
 */

import {
	INTEGRATION_IDS,
	USER_TYPES,
	type UserType,
	isIntegrationId,
	isUserType,
} from "@melandlabs/contracts";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testContracts() {
	await runSection("@melandlabs/contracts", async () => {
		const check = makeCheck("contracts");
		check("USER_TYPES has 5 members", USER_TYPES.length === 5);
		check("isUserType('pro')", isUserType("pro"));
		check("isUserType('slack') === false", !isUserType("slack"));

		// Type-only assertion that the runtime value is one of the union members.
		const sample: UserType = "regular";
		check("UserType literal 'regular' is recognized", isUserType(sample));
		check("UserType literal 'unknown' is rejected", !isUserType("unknown"));

		check("INTEGRATION_IDS is an array", Array.isArray(INTEGRATION_IDS));
		check(
			"INTEGRATION_IDS has at least 5 entries",
			INTEGRATION_IDS.length >= 5,
		);
		check(
			"isIntegrationId recognizes known id",
			isIntegrationId(INTEGRATION_IDS[0]),
		);
		check(
			"isIntegrationId rejects 'definitely-not-an-integration'",
			!isIntegrationId("definitely-not-an-integration"),
		);
	});
}
