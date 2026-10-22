/**
 * `@melandlabs/workspace/postgres` — query translation.
 *
 * The SQLite backend matches with FTS5: the query is a string of quoted
 * terms (`"wpricing" OR "h定价 h价方"`), and FTS5's tokenizer turns each
 * quoted string into a phrase of the tokens it contains.
 *
 * Postgres has no such string syntax — a `tsquery` is a parsed
 * expression — so the query has to be built explicitly. The mapping is:
 *
 *   FTS5                          tsquery
 *   ─────────────────────────     ───────────────────────────────────
 *   `"wpricing"`                  `'wpricing'`
 *   `"h定价 h价方"`                `'h定价' <-> 'h价方'`
 *   `"a" OR "b"`                  `'a' | 'b'`
 *
 * Rather than hand-rolling the phrase operator (and guessing how
 * Postgres' parser will split a token such as `wpricing_v2`), the store
 * lets Postgres do the parsing: `phraseto_tsquery('simple', …)` turns
 * a token string into exactly the phrase its own parser sees — the same
 * way FTS5's tokenizer turns a quoted string into a phrase.
 *
 * `phraseto_tsquery` also never raises on odd input (unlike
 * `to_tsquery`), so a token the parser cannot make sense of degrades
 * to "no match" instead of an error.
 */

import { indexWordTokens, workspaceSearchWords } from "../search/tokenization";

/**
 * The phrase fragments a raw query decomposes into — one per query
 * word, in the same token scheme the index is built from.
 *
 * `定价方案` → `["h定价 h价方 h方案"]` (a single fragment: the bigrams
 * have to stay adjacent for the word to match).
 *
 * `pricing plan` → `["wpricing", "wplan"]` (two fragments: the words
 * are alternatives).
 */
export function workspaceTsQueryFragments(query: string): string[] {
	return workspaceSearchWords(query).map((word) => indexWordTokens(word).join(" "));
}

/**
 * Render the `tsquery` expression for a set of fragments.
 *
 * The fragments are ORed together (`||` is the tsquery OR operator),
 * matching FTS5's `"a" OR "b"`.
 *
 * The returned `params` are the fragment strings; the caller binds them
 * to the `$n` placeholders in `sql`, starting at `startParam`.
 */
export function buildTsQueryExpression(
	fragments: string[],
	startParam = 1,
): { sql: string; params: string[] } {
	const parts = fragments.map(
		(_fragment, index) => `phraseto_tsquery('simple'::regconfig, $${startParam + index})`,
	);
	return { sql: parts.join(" || "), params: fragments };
}
