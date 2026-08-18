/**
 * Category mapping for BEAM benchmark.
 *
 * Each BEAM question category maps to:
 *   - a human-readable label (for the summary table),
 *   - the Alloomi product claim it validates (for the investor deck).
 */

import type { BeamQuestionCategory } from "./types";

export const QUESTION_TYPE_NAMES: Record<BeamQuestionCategory, string> = {
  abstention: "Abstention (know when NOT to answer)",
  contradiction_resolution:
    "Contradiction Resolution (handle conflicting facts)",
  event_ordering: "Event Ordering (sequence of events)",
  information_extraction: "Information Extraction (recall specific facts)",
  instruction_following: "Instruction Following (user-stated rules)",
  knowledge_update: "Knowledge Update (refresh stale info)",
  multi_session_reasoning: "Multi-Session Reasoning (connect across sessions)",
  preference_following: "Preference Following (user preferences over time)",
  summarization: "Summarization (compress long contexts)",
  temporal_reasoning: "Temporal Reasoning (dates, durations, ordering)",
};

/**
 * Mapping from BEAM category → the Alloomi product claim it directly tests.
 *
 * Used by the CLI summary to render the "BEAM-1M #1 / <claim>" framing.
 * If a claim is dropped, remove the entry here so we don't print a stale one.
 */
export const ALLOOMI_CLAIM_MAP: Record<BeamQuestionCategory, string> = {
  abstention: "Active forgetting (the system knows when NOT to answer)",
  contradiction_resolution: "Cross-session attribution",
  event_ordering: "Cross-session attribution",
  information_extraction: "Long-term recall",
  instruction_following: "User-defined rules & commitments",
  knowledge_update: "Active reinforcement (update stale memory)",
  multi_session_reasoning: "Cross-session attribution",
  preference_following: "Knows you better over time",
  summarization: "Long-context compression",
  temporal_reasoning: "Time-aware retrieval",
};

/**
 * Convenience: the subset of categories most often used for blog/deck
 * demos, matching the 4 most public Alloomi claims.
 */
export const ALLOOMI_HIGHLIGHT_CATEGORIES: BeamQuestionCategory[] = [
  "knowledge_update",
  "preference_following",
  "contradiction_resolution",
  "multi_session_reasoning",
];

/**
 * All valid categories, in the canonical order from the BEAM paper.
 */
export const QUESTION_TYPES: BeamQuestionCategory[] = [
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
];
