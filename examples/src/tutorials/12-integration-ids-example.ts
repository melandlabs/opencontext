import { INTEGRATION_IDS } from "@melandlabs/opencontext";

console.log("Available integrations:");
for (const id of Object.values(INTEGRATION_IDS)) {
	console.log("-", id);
}
