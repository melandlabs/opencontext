import { INTEGRATION_IDS } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	console.log("Available integrations:");
	for (const id of Object.values(INTEGRATION_IDS)) {
		console.log("-", id);
	}
}

export default main;
runIfMain("integration-ids", main, import.meta.url);
