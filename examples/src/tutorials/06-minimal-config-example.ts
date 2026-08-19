import { createMemoryStore } from "@melandlabs/opencontext";
import { runIfMain } from "../_helpers.ts";

async function main() {
	const store = await createMemoryStore({
		db: { type: "sqlite-vec", path: "./tutorials-memory.db" },
	});

	console.log("Backend:", store.raw.getBackend());

	// Search works out of the box with lexical fallback (no API keys).
	const results = await store.search({
		userId: "user-123",
		query: "hello world",
		limit: 5,
	});

	console.log(`Found ${results.count} result(s)`);
	await store.raw.close();
}

export default main;
runIfMain("minimal-config", main, import.meta.url);
