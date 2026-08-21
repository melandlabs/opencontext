/**
 * LongMemEval dataset loader.
 */

import { readFile } from "node:fs/promises";
import type { LongMemEvalEntry } from "./types";

/**
 * Load LongMemEval dataset from JSON file.
 */
export async function loadLongMemEvalDatasetFromJson(jsonPath: string): Promise<LongMemEvalEntry[]> {
	const content = await readFile(jsonPath, "utf-8");
	const data = JSON.parse(content);

	if (!Array.isArray(data)) {
		throw new Error(`Expected array of entries, got ${typeof data}`);
	}

	return data as LongMemEvalEntry[];
}
