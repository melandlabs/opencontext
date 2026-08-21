export const RUNTIME_INSTRUCTION_SCHEMA_VERSION = "2" as const;

export const DEFAULT_GOAL_MAX_TURNS = 12;

export const AGENT_GOAL_LIMITS = {
	objectiveCharacters: 8_000,
	successCriteria: 64,
	criterionDescriptionCharacters: 2_000,
	constraints: 64,
	constraintDescriptionCharacters: 2_000,
	contextReferences: 128,
	contextSummaryCharacters: 8_000,
	contextAttributesBytes: 32 * 1024,
	instructionPayloadBytes: 256 * 1024,
	evidencePayloadBytes: 256 * 1024,
	idempotencyKeyCharacters: 256,
} as const;

export const GOAL_STEP_COMPLETION_MARKER_OPEN = "<!-- OPENCONTEXT_STEP_COMPLETE:" as const;

export function goalStepCompletionMarker(criterionId: string): string {
	const encodedId = Array.from(new TextEncoder().encode(criterionId), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${GOAL_STEP_COMPLETION_MARKER_OPEN}${encodedId} -->`;
}

export function stripGoalStepCompletionMarkers(text: string): string {
	return text.replace(/^<!-- OPENCONTEXT_STEP_COMPLETE:[0-9a-f]+ -->[\t ]*(?:\r?\n)?/gm, "");
}
