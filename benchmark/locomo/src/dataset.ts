/**
 * LoCoMo dataset loader.
 */

import { readFile } from "node:fs/promises";
import type { LoCoMoSample, QAPair } from "./types";

interface RawQAPair {
	question: string;
	answer?: string;
	category?: number | string;
	evidence?: string[];
}

interface RawSample {
	sample_id?: string;
	conversation?: Record<string, unknown>;
	observation?: Record<string, unknown>;
	session_summary?: Record<string, unknown>;
	event_summary?: Record<string, unknown>;
	qa?: RawQAPair[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Create QAPair from raw dictionary.
 */
function createQAPair(qa: RawQAPair, sampleIndex: number, questionIndex: number): QAPair | null {
	// Skip QA pairs that don't have an answer field (e.g., adversarial questions)
	if (!qa.answer) {
		return null;
	}
	if (typeof qa.question !== "string" || qa.question.trim().length === 0) {
		throw new Error(`sample ${sampleIndex} question ${questionIndex} has invalid question`);
	}
	const category = typeof qa.category === "string" ? Number.parseInt(qa.category, 10) : (qa.category ?? 0);
	if (!Number.isInteger(category) || category < 1 || category > 5) {
		throw new Error(`sample ${sampleIndex} question ${questionIndex} has invalid category`);
	}
	if (
		qa.evidence !== undefined &&
		(!Array.isArray(qa.evidence) || !qa.evidence.every((item) => typeof item === "string"))
	) {
		throw new Error(`sample ${sampleIndex} question ${questionIndex} has invalid evidence`);
	}

	return {
		question: qa.question,
		answer: String(qa.answer),
		category,
		evidence: qa.evidence ?? [],
	};
}

/**
 * Create LoCoMoSample from raw dictionary.
 */
export function createLoCoMoSample(data: RawSample, sampleIndex = 0): LoCoMoSample {
	if (typeof data.sample_id !== "string" || data.sample_id.trim().length === 0) {
		throw new Error(`sample ${sampleIndex} has invalid sample_id`);
	}
	if (!isRecord(data.conversation)) {
		throw new Error(`sample ${sampleIndex} has invalid conversation`);
	}
	for (const [field, value] of [
		["observation", data.observation],
		["session_summary", data.session_summary],
		["event_summary", data.event_summary],
	] as const) {
		if (value !== undefined && !isRecord(value)) {
			throw new Error(`sample ${sampleIndex} has invalid ${field}`);
		}
	}
	if (data.qa !== undefined && !Array.isArray(data.qa)) {
		throw new Error(`sample ${sampleIndex} has invalid qa`);
	}
	const qaPairs: QAPair[] = [];

	if (data.qa) {
		for (const [questionIndex, qa] of data.qa.entries()) {
			if (!isRecord(qa)) throw new Error(`sample ${sampleIndex} question ${questionIndex} must be an object`);
			const qaPair = createQAPair(qa as unknown as RawQAPair, sampleIndex, questionIndex);
			if (qaPair) {
				qaPairs.push(qaPair);
			}
		}
	}
	if (qaPairs.length === 0) throw new Error(`sample ${sampleIndex} has no answerable questions`);

	return {
		sample_id: data.sample_id,
		conversation: data.conversation,
		observation: data.observation ?? {},
		session_summary: data.session_summary ?? {},
		event_summary: data.event_summary ?? {},
		qa_pairs: qaPairs,
	};
}

/**
 * Load LoCoMo dataset from JSON file.
 */
export async function loadLoCoMoDatasetFromJson(jsonPath: string): Promise<LoCoMoSample[]> {
	const content = await readFile(jsonPath, "utf-8");
	const data: unknown = JSON.parse(content);

	// Handle both single sample and list of samples
	const rawSamples = Array.isArray(data) ? data : [data];
	const samples = rawSamples.map((sample, index) => {
		if (!isRecord(sample)) throw new Error(`sample ${index} must be an object`);
		return createLoCoMoSample(sample as RawSample, index);
	});
	const ids = new Set<string>();
	for (const sample of samples) {
		if (ids.has(sample.sample_id)) throw new Error(`duplicate sample_id: ${sample.sample_id}`);
		ids.add(sample.sample_id);
	}
	return samples;
}
