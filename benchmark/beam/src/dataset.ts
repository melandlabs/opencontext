/**
 * BEAM dataset loader.
 *
 * BEAM is distributed on HuggingFace as parquet files (one per scale).
 * We convert to JSON once with `dataset/convert.py`, then this module
 * loads + filters. Filtering happens at the loader so we never materialize
 * all ~100K questions into memory at once.
 */

import { readFile } from "node:fs/promises";
import type {
	BeamConversation,
	BeamDatasetFile,
	BeamDatasetSource,
	BeamProbingQuestion,
	BeamQuestionCategory,
	BeamScale,
	BeamTurn,
} from "./types";

export interface LoadBeamOptions {
	/**
	 * Cap on the number of conversations to return.
	 * Default: undefined (return all).
	 */
	conversations?: number;
	/**
	 * Cap on probing questions per conversation.
	 * Default: undefined (return all).
	 */
	questionsPerConv?: number;
	/**
	 * Filter to specific question categories (e.g. ["knowledge_update",
	 * "preference_following"] for the OpenContext claim subset).
	 * Default: undefined (return all categories).
	 */
	types?: BeamQuestionCategory[];
	/**
	 * Validate that all conversations match the expected scale tag in the
	 * file. Useful for catching convert.py mistakes. Default: false.
	 */
	assertScale?: BeamScale;
}

/**
 * A flattened (conv × question) pair, ready for the evaluator to consume
 * one at a time. This is what the evaluator iterates over.
 */
export interface BeamSample {
	conversation: BeamConversation;
	question: BeamProbingQuestion;
}

interface RawBeamTurn {
	speaker?: string;
	role?: string;
	text?: string;
	content?: string;
	timestamp?: string;
	time_anchor?: string;
	source_id?: string | number;
	id?: string | number;
	source_index?: string | number;
	index?: string | number;
}

interface RawBeamQuestion {
	question_id?: string;
	id?: string;
	category?: string;
	question?: string;
	atoms?: string[];
	nuggets?: string[];
	gold_answer?: string;
	answer?: string;
	source?: Partial<BeamProbingQuestion["source"]>;
	source_chat_ids?: unknown;
	conversation_reference?: unknown;
	conversation_references?: unknown;
	plan_reference?: unknown;
	why_unanswerable?: string;
}

interface RawBeamConversation {
	entry_id?: string;
	id?: string;
	scale?: string;
	chat?: RawBeamTurn[];
	turns?: RawBeamTurn[];
	probing_questions?: RawBeamQuestion[];
	questions?: RawBeamQuestion[];
}

interface RawBeamDataset {
	scale?: string;
	source?: BeamDatasetSource;
	conversations?: RawBeamConversation[];
}

export interface LoadedBeamDataset {
	conversations: BeamConversation[];
	source: BeamDatasetSource | null;
}

const VALID_CATEGORIES = new Set<BeamQuestionCategory>([
	"abstention",
	"contradiction_resolution",
	"event_ordering",
	"information_extraction",
	"instruction_following",
	"knowledge_update",
	"multi_session_reasoning",
	"preference_following",
	"summarization",
	"temporal_reasoning",
]);

function normalizeCategory(raw: string | undefined): BeamQuestionCategory | null {
	if (!raw) return null;
	const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
	if (VALID_CATEGORIES.has(normalized as BeamQuestionCategory)) {
		return normalized as BeamQuestionCategory;
	}
	return null;
}

function normalizeTurn(raw: RawBeamTurn): BeamTurn {
	const sourceId = raw.source_id ?? raw.id;
	const sourceIndex = raw.source_index ?? raw.index;
	return {
		speaker: raw.speaker ?? raw.role ?? "user",
		text: raw.text ?? raw.content ?? "",
		timestamp: raw.timestamp ?? raw.time_anchor,
		source_id: sourceId === undefined ? undefined : String(sourceId),
		source_index: sourceIndex === undefined ? undefined : String(sourceIndex),
	};
}

function flattenScalarValues(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap(flattenScalarValues);
	if (typeof value === "object") return Object.values(value).flatMap(flattenScalarValues);
	return [String(value)];
}

function normalizeSourceChatIds(value: unknown): string[] {
	const placeholders = new Set(["", "--", "none", "null", "n/a"]);
	return flattenScalarValues(value).filter((item) => !placeholders.has(item.trim().toLowerCase()));
}

function normalizeQuestion(
	raw: RawBeamQuestion,
	fallbackCategory: BeamQuestionCategory | null,
	index: number,
): BeamProbingQuestion | null {
	const text = raw.question;
	if (!text) return null;

	const category = normalizeCategory(raw.category) ?? fallbackCategory;
	if (!category) return null;

	const atoms = (raw.atoms ?? raw.nuggets ?? []).filter(
		(a): a is string => typeof a === "string" && a.trim().length > 0,
	);

	return {
		question_id: raw.question_id ?? raw.id ?? `q_${index}`,
		category,
		question: text,
		atoms,
		gold_answer: raw.gold_answer ?? raw.answer,
		source: {
			source_chat_ids: normalizeSourceChatIds(raw.source?.source_chat_ids ?? raw.source_chat_ids),
			conversation_references: flattenScalarValues(
				raw.source?.conversation_references ?? raw.conversation_references ?? raw.conversation_reference,
			),
			plan_references: flattenScalarValues(raw.source?.plan_references ?? raw.plan_reference),
			why_unanswerable: raw.source?.why_unanswerable ?? raw.why_unanswerable,
		},
	};
}

function normalizeConversation(
	raw: RawBeamConversation,
	fallbackCategoryHint: BeamQuestionCategory | null,
	index: number,
): BeamConversation | null {
	const entryId = raw.entry_id ?? raw.id ?? `conv_${index}`;
	const turns = (raw.chat ?? raw.turns ?? []).map(normalizeTurn);
	if (turns.length === 0) return null;

	const questionsRaw = raw.probing_questions ?? raw.questions ?? [];
	const questions: BeamProbingQuestion[] = [];
	questionsRaw.forEach((q, i) => {
		const normalized = normalizeQuestion(q, fallbackCategoryHint, i);
		if (normalized) questions.push(normalized);
	});

	if (questions.length === 0) return null;

	const scale = (raw.scale as BeamScale) ?? "1m";

	return {
		entry_id: entryId,
		scale,
		chat: turns,
		probing_questions: questions,
	};
}

/**
 * Parse + lightly validate a BEAM dataset JSON file.
 * Throws if the file shape is wrong; returns the typed object otherwise.
 */
export async function loadBeamDatasetWithMetadata(
	jsonPath: string,
	opts: LoadBeamOptions = {},
): Promise<LoadedBeamDataset> {
	const content = await readFile(jsonPath, "utf-8");
	let raw: RawBeamDataset | BeamConversation[];
	try {
		raw = JSON.parse(content) as RawBeamDataset | BeamConversation[];
	} catch (error) {
		throw new Error(`Failed to parse BEAM dataset at ${jsonPath}: ${(error as Error).message}`);
	}

	// Accept either the wrapped shape or a bare array.
	let conversations: BeamConversation[];
	if (Array.isArray(raw)) {
		conversations = (raw as RawBeamConversation[])
			.map((c, i) => normalizeConversation(c, null, i))
			.filter((c): c is BeamConversation => c !== null);
	} else {
		const fileScale = (raw.scale ?? opts.assertScale) as BeamScale | undefined;
		conversations = (raw.conversations ?? [])
			.map((c, i) => normalizeConversation(c, null, i))
			.filter((c): c is BeamConversation => c !== null);

		if (opts.assertScale && fileScale !== opts.assertScale) {
			throw new Error(
				`BEAM dataset scale mismatch: expected ${opts.assertScale}, got ${fileScale ?? "(missing)"}`,
			);
		}
	}

	// Apply conversation cap
	if (opts.conversations !== undefined) {
		conversations = conversations.slice(0, opts.conversations);
	}

	// Apply per-conversation question filter + cap
	if (opts.types !== undefined || opts.questionsPerConv !== undefined) {
		const typeSet = opts.types ? new Set(opts.types) : null;
		conversations = conversations.map((conv) => {
			let filteredQuestions = conv.probing_questions;
			if (typeSet) {
				filteredQuestions = filteredQuestions.filter((q) => typeSet.has(q.category));
			}
			if (opts.questionsPerConv !== undefined) {
				filteredQuestions = filteredQuestions.slice(0, opts.questionsPerConv);
			}
			return { ...conv, probing_questions: filteredQuestions };
		});
		conversations = conversations.filter((c) => c.probing_questions.length > 0);
	}

	return {
		conversations,
		source: Array.isArray(raw) ? null : (raw.source ?? null),
	};
}

export async function loadBeamDatasetFromJson(
	jsonPath: string,
	opts: LoadBeamOptions = {},
): Promise<BeamConversation[]> {
	return (await loadBeamDatasetWithMetadata(jsonPath, opts)).conversations;
}

/**
 * Build the flat list of (conv, question) pairs the evaluator iterates over.
 * Pulled out so dataset.ts stays loader-only and evaluator.ts stays simple.
 */
export function expandBeamSamples(conversations: BeamConversation[]): BeamSample[] {
	const out: BeamSample[] = [];
	for (const conversation of conversations) {
		for (const question of conversation.probing_questions) {
			out.push({ conversation, question });
		}
	}
	return out;
}

/**
 * Re-export the wrapped-file type so callers can construct one in tests.
 */
export type { BeamDatasetFile };
