/**
 * Small helpers shared by the two store backends.
 *
 * Both databases cap the number of bind parameters a statement may
 * carry, and both stores answer questions about a *list* of versions.
 * Splitting the list is the same job on both sides, so it is written
 * once.
 */

/** Split a list into batches of at most `size` entries. */
export function chunk<T>(items: T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		batches.push(items.slice(index, index + size));
	}
	return batches;
}

/**
 * How many versions one `IN (…)` statement may carry on SQLite.
 *
 * SQLite caps the number of bound parameters per statement (999 before
 * 3.32, 32766 after). The cap is kept well below both so a long list of
 * resources cannot trip over it.
 */
export const SQLITE_MAX_BOUND_PARAMETERS = 500;

/**
 * How many versions one `IN (…)` statement may carry on Postgres.
 *
 * Postgres caps the number of bind parameters per statement at 65535.
 */
export const POSTGRES_MAX_BOUND_PARAMETERS = 1000;
