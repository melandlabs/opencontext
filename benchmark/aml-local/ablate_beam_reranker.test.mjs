import assert from "node:assert/strict";
import test from "node:test";
import { assertReplay, hydrateHit, selectRecords, sha256 } from "./ablate_beam_reranker.mjs";

test("selection is independent of answers and stable under input order", () => {
	const records = Array.from({ length: 12 }, (_, index) => ({
		id: `q${index}`,
		category: index % 2,
		rubric_nuggets: [],
	}));
	const ids = (input) =>
		selectRecords(input, 2)
			.map((item) => item.id)
			.sort();
	assert.deepEqual(ids(records), ids([...records].reverse()));
	assert.equal(ids(records).length, 4);
});

test("restores UTF-16 spans, including astral characters, with exact hashes", () => {
	const parent = {
		user_id: "u",
		archived_at: null,
		content: "a😀answer",
		metadata: '{"role":"user"}',
		message_sequence: 7,
		timestamp: null,
	};
	const content = "😀answer";
	const hit = {
		id: "m",
		score: 0.8,
		content_sha256: sha256(content),
		matched_spans: [
			{
				start_position: 1,
				end_position: parent.content.length,
				source_chunk_ids: ["c"],
				channels: [],
				content_sha256: sha256(content),
			},
		],
	};
	const restored = hydrateHit(
		hit,
		"u",
		() => parent,
		() => ({ message_id: "m", chunk_id: "c", chunk_index: 2, chunk_count: 3 }),
	);
	assert.equal(restored.content, content);
	assert.equal(restored.metadata.sourceChunkIndex, 2);
	assert.equal(restored.metadata.role, "user");
	assert.throws(
		() =>
			hydrateHit(
				hit,
				"other",
				() => parent,
				() => undefined,
			),
		/Scope mismatch/,
	);
	assert.throws(
		() =>
			hydrateHit(
				{ ...hit, content_sha256: "wrong" },
				"u",
				() => parent,
				() => undefined,
			),
		/Candidate content changed/,
	);
});

test("replay gate rejects altered answer contexts and rankings", () => {
	const hit = { id: "m", content: "evidence" };
	const output = { results: [hit], retrievalDiagnostics: { fusedBeforeRerank: [hit] } };
	const trace = {
		before_rerank: [{ id: "m", content_sha256: sha256("evidence") }],
		after_rerank: [{ id: "m" }],
	};
	assertReplay(output, trace, { id: "q", retrieved_context: ["evidence"] });
	assert.throws(
		() => assertReplay(output, trace, { id: "q", retrieved_context: ["altered"] }),
		/Answer context replay differs/,
	);
	assert.throws(
		() =>
			assertReplay(
				output,
				{ ...trace, after_rerank: [{ id: "other" }] },
				{ id: "q", retrieved_context: ["evidence"] },
			),
		/Rerank replay differs/,
	);
});
