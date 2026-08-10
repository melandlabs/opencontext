/**
 * @melandlabs/rag smoke test.
 *
 * RAG primitives — chunking, embeddings, vector store classes. We exercise
 * the chunking helper (pure, no network) and verify the vector store
 * classes are constructable shapes.
 */

import { chunkText } from "@melandlabs/rag";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testRag() {
	await runSection("@melandlabs/rag", async () => {
		const check = makeCheck("rag");

		const chunks = chunkText("Hello world. This is a test of the chunker.", {
			maxChunkSize: 12,
		});
		check("chunkText returns at least one chunk", chunks.length >= 1);
		check(
			"each chunk has a string `content` field",
			chunks.every((c) => typeof c?.content === "string"),
		);
		check(
			"each chunk has start/end positions",
			chunks.every((c) => typeof c?.startPosition === "number" && typeof c?.endPosition === "number"),
		);
		check(
			"chunk start positions are non-decreasing",
			chunks.every((c, i) => i === 0 || c.startPosition >= chunks[i - 1].startPosition),
		);

		// Verify vector-store classes are exported as constructors.
		const ragModule = await import("@melandlabs/rag");
		check("SQLiteVecStore is a class", typeof ragModule.SQLiteVecStore === "function");
		check("ChromaVectorStore is a class", typeof ragModule.ChromaVectorStore === "function");
		check("generateEmbedding is a function", typeof ragModule.generateEmbedding === "function");
	});
}
