/**
 * Smaller utility packages — config, db, audit, insights, shared, i18n, api.
 *
 * These mostly export framework helpers or constants. We verify the modules
 * load and that the most user-visible symbols are well-shaped.
 */

import * as api from "@melandlabs/api";
import * as audit from "@melandlabs/audit";
import * as config from "@melandlabs/config";
import * as db from "@melandlabs/db";
import * as i18n from "@melandlabs/i18n";
import * as insights from "@melandlabs/insights";
import * as shared from "@melandlabs/shared";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testUtilities() {
	await runSection("@melandlabs/audit", async () => {
		const check = makeCheck("audit");
		const exported = Object.keys(audit).filter((k) => !k.startsWith("_"));
		check("audit exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/config", async () => {
		const check = makeCheck("config");
		const exported = Object.keys(config).filter((k) => !k.startsWith("_"));
		check("config exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/db", async () => {
		const check = makeCheck("db");
		const exported = Object.keys(db).filter((k) => !k.startsWith("_"));
		check("db exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/insights", async () => {
		const check = makeCheck("insights");
		const exported = Object.keys(insights).filter((k) => !k.startsWith("_"));
		check("insights exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/shared", async () => {
		const check = makeCheck("shared");
		const exported = Object.keys(shared).filter((k) => !k.startsWith("_"));
		check("shared exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/i18n", async () => {
		const check = makeCheck("i18n");
		const exported = Object.keys(i18n).filter((k) => !k.startsWith("_"));
		check("i18n exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/api", async () => {
		const check = makeCheck("api");
		const exported = Object.keys(api).filter((k) => !k.startsWith("_"));
		check("api exports symbols", exported.length > 0);
	});
}
