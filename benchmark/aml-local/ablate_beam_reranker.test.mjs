import assert from "node:assert/strict";
import test from "node:test";
import {
	assertCompleteRerankerScores,
	assertReplay,
	hydrateHit,
	hydratePrimaryHit,
	selectRecords,
	sha256,
} from "./ablate_beam_reranker.mjs";

test("complete reranker scores preserve actual model order and reject incomplete evidence", () => {
	const candidates = [{ id: "a" }, { id: "b" }];
	const scores = [
		{ id: "b", score: 0.9 },
		{ id: "a", score: 0.2 },
	];
	assert.deepEqual(assertCompleteRerankerScores(scores, candidates), scores);
	assert.notEqual(assertCompleteRerankerScores(scores, candidates)[0], scores[0]);
	assert.throws(() => assertCompleteRerankerScores(scores.slice(0, 1), candidates));
	assert.throws(() => assertCompleteRerankerScores([scores[0], scores[0]], candidates));
	assert.throws(() => assertCompleteRerankerScores([scores[0], { id: "c", score: 1 }], candidates));
	assert.throws(() => assertCompleteRerankerScores([scores[0], { id: "a", score: Number.NaN }], candidates));
	assert.throws(() =>
		assertCompleteRerankerScores([scores[0], { id: "a", score: Number.POSITIVE_INFINITY }], candidates),
	);
});

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

test("legacy primary replay restores distinct matched children while preserving the answer window", () => {
	const parent = {
		user_id: "u",
		archived_at: null,
		content: "before 😀first second after",
		metadata: "{}",
		message_sequence: 3,
		timestamp: null,
	};
	const children = new Map(
		["😀first", "second"].map((content, index) => {
			const id = `c${index}`;
			const start_position = parent.content.indexOf(content);
			return [
				id,
				{
					chunk_id: id,
					message_id: "p",
					user_id: "u",
					content,
					content_hash: sha256(content),
					start_position,
					end_position: start_position + content.length,
					chunk_index: index,
					chunk_count: 2,
				},
			];
		}),
	);
	const hit = {
		id: "p",
		score: 1,
		content_sha256: sha256(parent.content),
		matched_spans: [
			{
				start_position: 0,
				end_position: parent.content.length,
				content_sha256: sha256(parent.content),
				source_chunk_ids: ["c0", "c1", "c0"],
				channels: [],
			},
		],
	};
	const load = (id) => children.get(id);
	const restored = hydratePrimaryHit(hit, "u", () => parent, load);
	assert.equal(restored.content, parent.content);
	assert.deepEqual(
		restored.metadata.matchedSpans.map((span) => span.matchedContent),
		["😀first", "second"],
	);
	assert.deepEqual(
		restored.metadata.matchedSpans.map((span) => span.sourceChunkIds),
		[["c0"], ["c1"]],
	);
	assert.equal(restored.metadata.matchedSpans[0].matchedStartPosition, 7);
	assert.equal(restored.metadata.timestamp, undefined);
	assert.throws(
		() =>
			hydratePrimaryHit(
				hit,
				"u",
				() => parent,
				(id) => ({ ...load(id), user_id: "other" }),
			),
		/scope mismatch/,
	);
	assert.throws(
		() =>
			hydratePrimaryHit(
				hit,
				"u",
				() => parent,
				(id) => ({ ...load(id), content_hash: "bad" }),
			),
		/hash mismatch/,
	);
	assert.throws(
		() =>
			hydratePrimaryHit(
				hit,
				"u",
				() => parent,
				(id) => ({ ...load(id), start_position: -1 }),
			),
		/outside/,
	);
	assert.throws(
		() =>
			hydratePrimaryHit(
				{ ...hit, matched_spans: [{ ...hit.matched_spans[0], source_chunk_ids: [] }] },
				"u",
				() => parent,
				load,
			),
		/Missing matched child/,
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

test("new trace replay keeps exact primary evidence separate from its expanded window", () => {
	const parent = {
		user_id: "u",
		archived_at: null,
		content: "neighbor 😀answer trailing context",
		metadata: "{}",
		message_sequence: 9,
		timestamp: null,
	};
	const start = parent.content.indexOf("😀");
	const end = start + "😀answer".length;
	const span = {
		start_position: 0,
		end_position: parent.content.length,
		content_sha256: sha256(parent.content),
		source_chunk_ids: ["c"],
		channels: [],
		matched_start_position: start,
		matched_end_position: end,
		matched_content_sha256: sha256("😀answer"),
	};
	const hit = { id: "p", score: 1, content_sha256: sha256(parent.content), matched_spans: [span] };
	const child = { message_id: "p", chunk_id: "c", chunk_index: 0, chunk_count: 1 };
	const restored = hydrateHit(
		hit,
		"u",
		() => parent,
		() => child,
	);
	assert.equal(restored.content, parent.content);
	assert.equal(restored.metadata.matchedSpans[0].matchedContent, "😀answer");
	assert.equal(restored.metadata.matchedSpans[0].matchedStartPosition, start);
	assert.throws(
		() =>
			hydrateHit(
				{ ...hit, matched_spans: [{ ...span, matched_content_sha256: "bad" }] },
				"u",
				() => parent,
				() => child,
			),
		/Primary content changed/,
	);
	assert.throws(
		() =>
			hydrateHit(
				hit,
				"u",
				() => parent,
				() => undefined,
			),
		/Missing primary child/,
	);
	assert.throws(
		() =>
			hydrateHit(
				hit,
				"u",
				() => parent,
				() => ({ ...child, message_id: "other" }),
			),
		/another parent/,
	);
});
