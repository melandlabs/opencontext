/**
 * Canonical user-tier enum shared between runtime (auth, db, integrations)
 * and UI (Next.js route groups, components).
 *
 * Source of truth: this file.
 * Re-exported (for one release) by `apps/web/app/(auth)/auth.ts` for backward
 * compatibility; new code MUST import from `@opencontext/contracts`.
 *
 * Note: `packages/integrations/src/core/index.ts` historically had its own
 * local `UserType = "user" | "guest"`. That type describes bot-owner
 * classification, NOT account tier. It is renamed to `LocalUserType` in
 * Phase 2 to eliminate the collision.
 */
export type UserType = "guest" | "regular" | "basic" | "pro" | "team";

export const USER_TYPES: readonly UserType[] = [
	"guest",
	"regular",
	"basic",
	"pro",
	"team",
] as const;

export function isUserType(value: unknown): value is UserType {
	return (
		typeof value === "string" &&
		(USER_TYPES as readonly string[]).includes(value)
	);
}
