/**
 * Structured Call — balanced JSON extraction.
 *
 * Companion to `extractJsonFromMarkdown` (agent/utils): that helper uses a
 * greedy `\{[\s\S]*\}` regex over markdown-stripped text and swallows
 * everything between the first `{` and the last `}`, which breaks when the
 * payload is followed by prose containing more braces. This module walks the
 * string tracking string/escape state so braces inside string literals do not
 * affect the balance, and returns the *first* complete object. Hosts that
 * need the old behavior keep importing from `agent/utils`.
 */

/**
 * Extract the first balanced JSON object embedded in raw text.
 *
 * Walks from the first `{`, tracking whether the cursor is inside a string
 * literal (and whether the current character is escaped) so braces and quotes
 * inside strings cannot break the scan. Returns the matched substring, or
 * null when there is no `{`, the object never closes, or a string literal is
 * left open — callers fall through to other recovery paths instead of
 * catching an exception.
 */
export function extractBalancedJsonObject(raw: string): string | null {
	const start = raw.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < raw.length; index += 1) {
		const character = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth += 1;
		} else if (character === "}") {
			depth -= 1;
			if (depth === 0) {
				return raw.slice(start, index + 1);
			}
		}
	}
	return null;
}
