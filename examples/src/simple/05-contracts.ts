/**
 * demo: @melandlabs/contracts — boundary types and guards.
 *
 * Every other package depends on this one. It holds the closed string
 * unions that cross package boundaries (user types, integration ids)
 * along with runtime type guards for them.
 *
 * The guards matter because these values arrive from outside the type
 * system — a database column, an HTTP body, a config file. `isUserType`
 * is how you narrow an untrusted `string` to a `UserType` safely.
 */

import {
	INTEGRATION_IDS,
	USER_TYPES,
	type UserType,
	isIntegrationId,
	isUserType,
} from "@melandlabs/contracts";
import { info, makeCheck, runSection } from "../_helpers.ts";

export default async function demoContracts() {
	await runSection("demo: @melandlabs/contracts", async () => {
		const check = makeCheck("demo/contracts");

		info("demo/contracts", `USER_TYPES = [${USER_TYPES.join(", ")}]`);
		info(
			"demo/contracts",
			`${INTEGRATION_IDS.length} integration ids, e.g. ${INTEGRATION_IDS.slice(0, 6).join(", ")}`,
		);

		check("USER_TYPES has 5 members", USER_TYPES.length === 5, USER_TYPES.join(", "));
		check(
			"every USER_TYPES member passes its own guard",
			USER_TYPES.every((t) => isUserType(t)),
		);
		check("isUserType('pro') accepts a real user type", isUserType("pro") === true);
		check("isUserType('slack') rejects an integration id", isUserType("slack") === false);
		check("isUserType('') rejects the empty string", isUserType("") === false);

		// Narrowing an untrusted value — the actual reason these guards exist.
		const fromDatabase: string = "regular";
		let narrowed: UserType | null = null;
		if (isUserType(fromDatabase)) {
			narrowed = fromDatabase; // typed as UserType inside this branch
		}
		info("demo/contracts", `narrowed an untrusted string to UserType: ${narrowed}`);
		check("isUserType narrows an untrusted string to UserType", narrowed === "regular");

		check(
			"INTEGRATION_IDS is a non-trivial list",
			INTEGRATION_IDS.length >= 5,
			`${INTEGRATION_IDS.length} ids`,
		);
		check(
			"every INTEGRATION_IDS member passes its own guard",
			INTEGRATION_IDS.every((id) => isIntegrationId(id)),
		);
		check("isIntegrationId rejects a made-up id", isIntegrationId("definitely-not-an-integration") === false);
		check(
			"the two unions are disjoint: no user type is an integration id",
			USER_TYPES.every((t) => !isIntegrationId(t)),
		);
	});
}
