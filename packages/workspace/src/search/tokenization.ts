/** Keep Han runs separate from Latin words and never bridge punctuation. */
export function workspaceSearchWords(text: string): string[] {
	return (
		text
			.normalize("NFKC")
			.toLowerCase()
			.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+/gu) ?? []
	);
}

function indexWord(word: string): string {
	if (!/^\p{Script=Han}+$/u.test(word)) return `w${word}`;
	const characters = Array.from(word);
	if (characters.length < 2) return `h${word}`;
	return characters
		.slice(0, -1)
		.map((character, index) => `h${character}${characters[index + 1]}`)
		.join(" ");
}

/** Derived index text; the source body and citation hash stay untouched. */
export function workspaceIndexText(text: string): string {
	// The unqueryable boundary token prevents phrases spanning separate runs.
	return workspaceSearchWords(text).map(indexWord).join(" b ");
}

/** Multi-character Chinese queries use consecutive bigrams as an FTS phrase. */
export function workspaceFtsQuery(words: string[]): string {
	return words.map((word) => `"${indexWord(word)}"`).join(" OR ");
}
