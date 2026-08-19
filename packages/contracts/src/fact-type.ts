/**
 * Fact-type classification for atomic facts / memory records.
 *
 * Classification of a fact extracted by the atomic-fact chunker (and stored
 * on `RawMessage` / `MemoryRecord`):
 *
 * - "world": objective facts about the world (entities, definitions, dates,
 *   relationships) that do not depend on a particular speaker.
 * - "experience": first-person recollections ("I went hiking", "I bought X").
 * - "mental_model": the speaker's beliefs, preferences, opinions, or
 *   patterns of behavior ("I prefer Y", "Whenever X, I do Y").
 *
 * This is the single source of truth for the `FactType` union — the
 * `ai`, `ai-rag`, and `indexeddb` packages all re-export it from here so
 * the definition cannot drift between workspaces.
 */

export type FactType = "world" | "experience" | "mental_model";

export function isFactType(value: unknown): value is FactType {
	return value === "world" || value === "experience" || value === "mental_model";
}
