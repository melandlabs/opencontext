/**
 * LongMemEval dataset loader.
 */

import { readFile } from "node:fs/promises";
import type { LongMemEvalEntry } from "./types";

const QUESTION_TYPES = new Set([
	"single-session-user",
	"single-session-preference",
	"single-session-assistant",
	"multi-session",
	"temporal-reasoning",
	"knowledge-update",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEntry(value: unknown, index: number): asserts value is LongMemEvalEntry {
	if (!isRecord(value)) throw new Error(`entry ${index} must be an object`);
	for (const field of ["question_id", "question_type", "question", "question_date"] as const) {
		if (typeof value[field] !== "string" || value[field].length === 0) {
			throw new Error(`entry ${index} has invalid ${field}`);
		}
	}
	if (!QUESTION_TYPES.has(value.question_type as string)) {
		throw new Error(`entry ${index} has unknown question_type: ${value.question_type}`);
	}
	if (typeof value.answer !== "string" && typeof value.answer !== "number") {
		throw new Error(`entry ${index} has invalid answer`);
	}
	const answerSessionIds = value.answer_session_ids;
	const haystackDates = value.haystack_dates;
	const haystackSessionIds = value.haystack_session_ids;
	if (!Array.isArray(answerSessionIds) || !answerSessionIds.every((item) => typeof item === "string"))
		throw new Error(`entry ${index} has invalid answer_session_ids`);
	if (!Array.isArray(haystackDates) || !haystackDates.every((item) => typeof item === "string"))
		throw new Error(`entry ${index} has invalid haystack_dates`);
	if (!Array.isArray(haystackSessionIds) || !haystackSessionIds.every((item) => typeof item === "string"))
		throw new Error(`entry ${index} has invalid haystack_session_ids`);
	if (!Array.isArray(value.haystack_sessions)) {
		throw new Error(`entry ${index} has invalid haystack_sessions`);
	}
	if (
		value.haystack_sessions.length !== haystackSessionIds.length ||
		value.haystack_sessions.length !== haystackDates.length
	) {
		throw new Error(`entry ${index} has misaligned haystack session arrays`);
	}
	for (const [sessionIndex, session] of value.haystack_sessions.entries()) {
		if (!Array.isArray(session)) throw new Error(`entry ${index} session ${sessionIndex} is not an array`);
		for (const [turnIndex, turn] of session.entries()) {
			if (
				!isRecord(turn) ||
				(turn.role !== "user" && turn.role !== "assistant") ||
				typeof turn.content !== "string"
			) {
				throw new Error(`entry ${index} session ${sessionIndex} turn ${turnIndex} is invalid`);
			}
		}
	}
	const haystackIds = new Set(haystackSessionIds);
	const missingAnswerSessionIds = answerSessionIds.filter((id) => !haystackIds.has(id));
	if (missingAnswerSessionIds.length > 0) {
		throw new Error(
			`entry ${index} answer_session_ids missing from haystack: ${missingAnswerSessionIds.join(", ")}`,
		);
	}
}

/**
 * Load LongMemEval dataset from JSON file.
 */
export async function loadLongMemEvalDatasetFromJson(jsonPath: string): Promise<LongMemEvalEntry[]> {
	const content = await readFile(jsonPath, "utf-8");
	const data: unknown = JSON.parse(content);

	if (!Array.isArray(data)) {
		throw new Error(`Expected array of entries, got ${typeof data}`);
	}

	const ids = new Set<string>();
	for (const [index, entry] of data.entries()) {
		validateEntry(entry, index);
		if (ids.has(entry.question_id)) throw new Error(`duplicate question_id: ${entry.question_id}`);
		ids.add(entry.question_id);
	}

	return data;
}
