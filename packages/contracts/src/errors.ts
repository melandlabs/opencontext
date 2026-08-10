/**
 * Cross-cutting error codes shared between runtime (auth handlers, db
 * queries, integrations) and UI (forms, route groups).
 *
 * Source of truth: this file.
 * Historically lived at `apps/web/lib/auth/error-codes.ts`; that file becomes
 * a re-export shim in Phase 2.
 */
export enum AuthErrorCode {
	// Auth-related errors
	INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
	USER_NOT_FOUND = "USER_NOT_FOUND",
	USER_EXISTS = "USER_EXISTS",

	// Request parameter errors
	MISSING_EMAIL = "MISSING_EMAIL",
	MISSING_PASSWORD = "MISSING_PASSWORD",
	INVALID_EMAIL = "INVALID_EMAIL",
	INVALID_PASSWORD = "INVALID_PASSWORD",

	// Server errors
	INTERNAL_ERROR = "INTERNAL_ERROR",
	SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",

	// Other errors
	RATE_LIMITED = "RATE_LIMITED",
}
