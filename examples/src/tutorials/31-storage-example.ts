/**
 * Tutorial: storage provider operations.
 *
 * This example demonstrates the @melandlabs/storage providers:
 *
 *   - MemoryStorageProvider (ephemeral, in-memory)
 *   - LocalStorageProvider (file-system backed)
 *
 * It performs static surface checks on both classes and exercises save,
 * exists, load, and delete using a MemoryStorageProvider so the demo leaves
 * no files behind.
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/31-storage-example.ts
 */

import { LocalStorageProvider } from "@melandlabs/storage";
import { MemoryStorageProvider } from "@melandlabs/storage/memory";
import { runIfMain } from "../_helpers.ts";

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- MemoryStorageProvider is a class: ${typeof MemoryStorageProvider === "function"}`);
	console.log(`- LocalStorageProvider is a class: ${typeof LocalStorageProvider === "function"}`);

	if (typeof MemoryStorageProvider !== "function") {
		throw new Error("MemoryStorageProvider is not exported as a class");
	}
	if (typeof LocalStorageProvider !== "function") {
		throw new Error("LocalStorageProvider is not exported as a class");
	}

	// ---- Live demo with MemoryStorageProvider ----
	console.log("\nMemoryStorageProvider round-trip:");
	const provider = new MemoryStorageProvider();
	await provider.initialize();

	const key = "tutorial/hello.bin";
	const payload = new TextEncoder().encode("Hello from the storage tutorial!");

	const existsBefore = await provider.exists(key);
	console.log(`- exists before save: ${existsBefore}`);
	if (existsBefore) {
		throw new Error("Key unexpectedly existed before save");
	}

	await provider.save(key, payload);
	console.log(`- saved ${payload.length} bytes to "${key}"`);

	const existsAfter = await provider.exists(key);
	console.log(`- exists after save: ${existsAfter}`);
	if (!existsAfter) {
		throw new Error("Key did not exist after save");
	}

	const loaded = await provider.load(key);
	console.log(`- loaded ${loaded.length} bytes`);
	if (loaded.length !== payload.length) {
		throw new Error(`Loaded payload length ${loaded.length} does not match saved ${payload.length}`);
	}
	const loadedText = new TextDecoder().decode(loaded);
	const payloadText = new TextDecoder().decode(payload);
	if (loadedText !== payloadText) {
		throw new Error(`Loaded payload "${loadedText}" does not match saved "${payloadText}"`);
	}

	await provider.delete(key);
	console.log(`- deleted "${key}"`);

	const existsAfterDelete = await provider.exists(key);
	console.log(`- exists after delete: ${existsAfterDelete}`);
	if (existsAfterDelete) {
		throw new Error("Key still existed after delete");
	}

	let loadThrew = false;
	try {
		await provider.load(key);
	} catch (error) {
		loadThrew = true;
	}
	console.log(`- loading deleted key threw: ${loadThrew}`);
	if (!loadThrew) {
		throw new Error("Loading a deleted key did not throw");
	}

	console.log("\n[OK] Storage tutorial completed");
}

export default main;

runIfMain("Storage tutorial", main);
