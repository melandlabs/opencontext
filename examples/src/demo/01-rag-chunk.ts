/**
 * demo: @melandlabs/rag — text chunking.
 *
 * `chunkText` is the first step of any retrieval pipeline: split a
 * document into overlapping windows small enough to embed. It is pure
 * and synchronous — no network, no API key.
 *
 * Two behaviours worth knowing before you tune it:
 *
 *   - `maxChunkSize` is a *soft* target. Splitting happens on the
 *     `separator` (default "\n\n") first, then on sentence boundaries.
 *     A single sentence is never cut in half, so a long sentence — plus
 *     the overlap text prepended to it — can exceed the limit.
 *   - `startPosition` / `endPosition` are cumulative offsets over the
 *     emitted chunks, not offsets into the original string. Use them to
 *     order chunks, not to slice the source document.
 */

import { chunkText } from "@melandlabs/rag";
import { info, makeCheck, runSection } from "../_helpers.ts";

const DOC = [
	"Retrieval-augmented generation grounds a model's answer in your own documents.",
	"The pipeline is: chunk, embed, store, then search.",
	"Chunk size is the main knob you tune.",
	"Too small and a chunk loses its context; too large and the embedding blurs ideas together.",
	"Overlap exists so a sentence straddling a boundary still appears intact somewhere.",
].join("\n\n");

export default async function demoRagChunk() {
	await runSection("demo: @melandlabs/rag (chunking)", async () => {
		const check = makeCheck("demo/rag-chunk");

		const chunks = chunkText(DOC, { maxChunkSize: 100, chunkOverlap: 20 });
		info("demo/rag-chunk", `${DOC.length} chars → ${chunks.length} chunks (maxChunkSize=100, overlap=20)`);
		for (const c of chunks) {
			info("demo/rag-chunk", `  #${c.index} (${c.content.length} chars) ${JSON.stringify(c.content)}`);
		}

		check("produced more than one chunk", chunks.length > 1, `${chunks.length} chunks`);
		check(
			"chunk indexes are sequential from 0",
			chunks.every((c, i) => c.index === i),
		);
		check(
			"positions are contiguous: each chunk starts where the previous ended",
			chunks.every((c, i) => (i === 0 ? c.startPosition === 0 : c.startPosition === chunks[i - 1].endPosition)),
		);
		check(
			"endPosition - startPosition equals the chunk length",
			chunks.every((c) => c.endPosition - c.startPosition === c.content.length),
		);
		check(
			"chunks are non-empty after trimming",
			chunks.every((c) => c.content.trim().length > 0),
		);
		check(
			"every chunk's text really came from the source document",
			chunks.every((c) => DOC.includes(c.content.split("\n\n").at(-1) ?? c.content)),
		);

		// Overlap: consecutive chunks share trailing/leading text so a
		// sentence on a boundary is never lost.
		const overlapping = chunks.filter((c, i) => i > 0 && chunks[i - 1].content.includes(c.content.split("\n\n")[0]));
		info("demo/rag-chunk", `${overlapping.length} of ${chunks.length - 1} boundaries carry overlap text`);
		check("at least one boundary carries overlap from the previous chunk", overlapping.length >= 1);

		// A document shorter than maxChunkSize comes back whole, in one chunk.
		const short = chunkText("One short sentence.", { maxChunkSize: 1000 });
		info("demo/rag-chunk", `short doc → ${short.length} chunk: ${JSON.stringify(short[0].content)}`);
		check("a short document yields exactly one chunk", short.length === 1);
		check("that chunk is the whole (trimmed) document", short[0].content === "One short sentence.");

		// Smaller maxChunkSize means more chunks — the knob actually works.
		const coarse = chunkText(DOC, { maxChunkSize: 250, chunkOverlap: 20 });
		const fine = chunkText(DOC, { maxChunkSize: 60, chunkOverlap: 20 });
		info("demo/rag-chunk", `maxChunkSize 250 → ${coarse.length} chunks, 60 → ${fine.length} chunks`);
		check(
			"a smaller maxChunkSize produces at least as many chunks",
			fine.length >= coarse.length,
			`${fine.length} >= ${coarse.length}`,
		);
	});
}
