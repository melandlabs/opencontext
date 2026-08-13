/**
 * Canonical `EntityType` enum shared between runtime (NER, graph nodes,
 * indexing) and UI (entity pickers, type badges).
 *
 * Source of truth: this file. New code MUST import from
 * `@melandlabs/contracts`.
 */
export type EntityType = "person" | "organization" | "place" | "thing" | "event" | "concept";

export const ENTITY_TYPES: readonly EntityType[] = [
	"person",
	"organization",
	"place",
	"thing",
	"event",
	"concept",
] as const;

export function isEntityType(value: unknown): value is EntityType {
	return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}
