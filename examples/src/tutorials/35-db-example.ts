/**
 * Tutorial: database utilities from `@melandlabs/db`.
 *
 * This example demonstrates the public surface of the DB package:
 *
 *   - `batchInsert` — split a large array into chunks and call an insert
 *     function for each chunk, respecting database parameter limits.
 *   - `generateHashedPassword` — hash a plaintext password with bcrypt.
 *   - `generateDummyPassword` — generate and hash a random dummy password.
 *
 * The demo performs real calls and asserts that the hashed passwords verify
 * their basic shape (non-empty strings starting with the bcrypt `$2` prefix).
 *
 * Run:
 *   cd examples
 *   node --experimental-strip-types src/tutorials/35-db-example.ts
 */

import { batchInsert, generateDummyPassword, generateHashedPassword } from "@melandlabs/db";
import { runIfMain } from "../_helpers.ts";

interface UserRow {
	id: number;
	name: string;
}

async function main() {
	// ---- Static surface checks ----
	console.log("Static surface checks:");
	console.log(`- batchInsert is callable: ${typeof batchInsert === "function"}`);
	console.log(`- generateHashedPassword is callable: ${typeof generateHashedPassword === "function"}`);
	console.log(`- generateDummyPassword is callable: ${typeof generateDummyPassword === "function"}`);

	// ---- batchInsert ----
	console.log("\n--- batchInsert ---");
	const inserted: UserRow[] = [];
	const items: Omit<UserRow, "id">[] = Array.from({ length: 25 }, (_, index) => ({
		name: `User ${index + 1}`,
	}));

	const batchResults = await batchInsert(items, 10, async (chunk) => {
		// Simulate an async insert returning the created rows.
		const rows = chunk.map((item, index) => ({
			id: inserted.length + index + 1,
			...item,
		}));
		inserted.push(...rows);
		return rows;
	});

	console.log(`inserted ${inserted.length} row(s); batchInsert merged ${batchResults.length} result row(s)`);
	if (inserted.length !== items.length) {
		throw new Error(`Expected ${items.length} inserted rows, got ${inserted.length}`);
	}
	// batchInsert flattens array results, so the merged result contains every row.
	if (batchResults.length !== items.length) {
		throw new Error(`Expected ${items.length} merged result rows, got ${batchResults.length}`);
	}
	if (inserted[0]?.name !== "User 1" || inserted[24]?.name !== "User 25") {
		throw new Error("First or last inserted row does not match the input order");
	}

	// ---- generateHashedPassword ----
	console.log("\n--- generateHashedPassword ---");
	const password = "open-context-tutorial";
	const hash = generateHashedPassword(password);
	console.log(`hash starts with ${hash.slice(0, 7)}...`);
	if (!hash.startsWith("$2")) {
		throw new Error("Expected bcrypt hash to start with '$2'");
	}
	if (hash === password) {
		throw new Error("Hash must differ from the plaintext password");
	}

	// ---- generateDummyPassword ----
	console.log("\n--- generateDummyPassword ---");
	const dummyHash = generateDummyPassword();
	console.log(`dummy hash starts with ${dummyHash.slice(0, 7)}...`);
	if (!dummyHash.startsWith("$2")) {
		throw new Error("Expected dummy password hash to start with '$2'");
	}
	if (dummyHash.length < 20) {
		throw new Error("Expected dummy password hash to be reasonably long");
	}

	console.log("\n[OK] DB tutorial completed");
}

export default main;

runIfMain("DB tutorial", main, import.meta.url);
