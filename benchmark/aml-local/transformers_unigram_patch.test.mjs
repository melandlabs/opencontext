import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const entry = require.resolve("@huggingface/transformers");
const root = path.resolve(path.dirname(entry), "..");
const { CharTrie } = await import(pathToFileURL(path.join(root, "src/utils/data-structures.js")));
const { TokenizerModel } = await import(pathToFileURL(path.join(root, "src/tokenizers.js")));

test("Unigram trie uses code-point offsets and retains prefix order", () => {
	const trie = new CharTrie();
	trie.extend(["a", "ab", "😀", "😀a", "😀ab"]);
	assert.deepEqual([...trie.commonPrefixSearch(Array.from("x😀ab"), 1)], ["😀", "😀a", "😀ab"]);
	assert.deepEqual([...trie.commonPrefixSearch(Array.from("😀ab"), 1)], ["a", "ab"]);
	assert.deepEqual([...trie.commonPrefixSearch(Array.from("none"), 1)], []);
});

test("Unigram retains Viterbi scores, overlapping vocabulary and astral tokens", () => {
	const model = TokenizerModel.fromConfig(
		{
			type: "Unigram",
			unk_id: 0,
			vocab: [
				["<unk>", -20],
				["a", -2],
				["b", -2],
				["ab", -1],
				["😀", -1],
				["</s>", -1],
			],
		},
		{ eos_token: "</s>" },
	);
	assert.deepEqual(model.tokenize("ab😀ab"), ["ab", "😀", "ab"]);
	assert.deepEqual(model.tokenize(""), []);
	assert.deepEqual(model.encode(["ab", "😀"]), ["ab", "😀"]);
});

test("Unigram never copies a full remaining character suffix", () => {
	const model = TokenizerModel.fromConfig(
		{
			type: "Unigram",
			unk_id: 0,
			vocab: [
				["<unk>", -20],
				["a", -1],
				["</s>", -1],
			],
		},
		{ eos_token: "</s>" },
	);
	const chars = Array.from("a".repeat(50000));
	chars.slice = () => {
		throw new Error("Quadratic suffix copying returned");
	};
	let inserted = 0;
	model.populateNodes({
		chars,
		insert: () => {
			inserted++;
		},
	});
	assert.equal(inserted, 50000);
});
