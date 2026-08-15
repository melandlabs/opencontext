/**
 * Tiny assertion helper. The full dsh convention is to use a separate
 * `ts-invariant` style helper; we keep an in-tree copy so the plugin has
 * zero runtime dependencies beyond `@melandlabs/opencontext`.
 */

export function invariant(
	condition: unknown,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(`[dsh-opencontext] invariant: ${message}`);
	}
}

export function invariantString(value: unknown, field: string): string {
	invariant(typeof value === "string", `${field} must be a string`);
	return value;
}

export function invariantNumber(value: unknown, field: string): number {
	invariant(
		typeof value === "number" && Number.isFinite(value),
		`${field} must be a finite number`
	);
	return value;
}
