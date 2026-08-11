/**
 * demo: @melandlabs/ai-rag — local Transformers embedding provider.
 *
 * `LocalTransformersEmbeddingProvider` runs an ONNX sentence-embedding model
 * in-process via `@huggingface/transformers` — no API keys, no outbound
 * network during inference. The default model is `Xenova/all-MiniLM-L6-v2`
 * (384 dimensions).
 *
 * First-run cost: ~30 MB of ONNX weights are pulled from HuggingFace and
 * cached in the transformers.js global cache directory. After that, set
 * `LOCAL_EMBEDDING_LOCAL_ONLY=true` and the same demo runs offline. With
 * neither network nor a populated cache the inference calls cannot run;
 * this section skips cleanly in that case rather than failing the suite.
 *
 * Dimensionality contract: the default cloud path (`text-embedding-3-small`)
 * is 1536-dim, local MiniLM is 384-dim. Switching between them means
 * the SQLite-vec / pgvector / Chroma collection must be cleared and
 * re-indexed — see `packages/rag/README.md` for the index contract.
 */

import { getConfiguredEmbeddingProvider } from "@melandlabs/ai-rag/embedding-provider";
import { cosineSimilarity } from "@melandlabs/ai-rag/embeddings";
import { LocalTransformersEmbeddingProvider } from "@melandlabs/ai-rag/local-transformers-embedding-provider";
import { info, makeCheckWithSkip, runSection } from "./_helpers.ts";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_DIMS = 384;

export default async function demoLocalEmbedding() {
	await runSection("demo: @melandlabs/ai-rag (local Transformers embedding)", async () => {
		const { check, skip } = makeCheckWithSkip("demo/local-embedding");

		// 1. Direct construction — pure object shape, no model download yet.
		const provider = new LocalTransformersEmbeddingProvider({ modelName: MODEL });
		check(
			"LocalTransformersEmbeddingProvider.getModelName() echoes the requested model",
			provider.getModelName() === MODEL,
			provider.getModelName(),
		);
		check(
			"getDimensions() returns undefined until the first embed completes",
			provider.getDimensions() === undefined,
		);

		// 2. Factory routing: EMBEDDING_PROVIDER=local selects the local class.
		// Construction only — the actual model is not loaded here. We duck-type
		// instead of using `instanceof` because tsup bundles each entry
		// separately, so the class object imported from this subpath and the
		// one used inside `embedding-provider.js` are different references.
		const previousProvider = process.env.EMBEDDING_PROVIDER;
		process.env.EMBEDDING_PROVIDER = "local";
		let factoryProvider: ReturnType<typeof getConfiguredEmbeddingProvider>;
		try {
			factoryProvider = getConfiguredEmbeddingProvider();
		} finally {
			if (previousProvider === undefined) process.env.EMBEDDING_PROVIDER = undefined;
			else process.env.EMBEDDING_PROVIDER = previousProvider;
		}
		check(
			"getConfiguredEmbeddingProvider() returns the local embedding provider when EMBEDDING_PROVIDER=local",
			factoryProvider.constructor.name === "LocalTransformersEmbeddingProvider" &&
				typeof factoryProvider.embedQuery === "function" &&
				typeof factoryProvider.embedDocuments === "function" &&
				typeof factoryProvider.getModelName === "function",
			factoryProvider.constructor.name,
		);

		// 3. Real inference — first call downloads the ONNX weights from
		// HuggingFace and caches them under the transformers.js global
		// cache directory. Without network access or a populated cache
		// the call throws; we treat that as an expected skip.
		let queryVector: number[];
		try {
			queryVector = await provider.embedQuery("hello world");
		} catch (err) {
			const detail = (err as Error).message.split("\n")[0];
			skip(
				`embedQuery against ${MODEL}`,
				"transformers.js could not load the model (no network, or no populated cache)",
				detail,
			);
			skip("embedDocuments batch call", "depends on the model loading");
			skip("getDimensions() returns the model's dimension after first embed", "depends on the model loading");
			skip("cosine similarity sanity check (related > unrelated)", "depends on embedDocuments");
			return;
		}

		check(
			`embedQuery returns a ${EXPECTED_DIMS}-dim vector of finite numbers`,
			Array.isArray(queryVector) &&
				queryVector.length === EXPECTED_DIMS &&
				queryVector.every((n) => typeof n === "number" && Number.isFinite(n)),
			`${queryVector.length} dims`,
		);
		check(
			`getDimensions() now reports ${EXPECTED_DIMS}`,
			provider.getDimensions() === EXPECTED_DIMS,
			String(provider.getDimensions()),
		);

		const batch = await provider.embedDocuments([
			"the cat sat on the mat",
			"the dog chased the ball",
			"an introduction to quantum chromodynamics and the strong force",
		]);
		check(
			"embedDocuments returns one vector per input, all of the expected dimension",
			Array.isArray(batch) &&
				batch.length === 3 &&
				batch.every((v) => Array.isArray(v) && v.length === EXPECTED_DIMS),
			`${batch.length} rows`,
		);

		const catDog = cosineSimilarity(batch[0], batch[1]);
		const catPhysics = cosineSimilarity(batch[0], batch[2]);
		info(
			"demo/local-embedding",
			`cosine(cat, dog) = ${catDog.toFixed(4)}, cosine(cat, physics) = ${catPhysics.toFixed(4)}`,
		);
		check(
			"related sentences score higher than unrelated ones (cosine)",
			catDog > catPhysics,
			`${catDog.toFixed(4)} > ${catPhysics.toFixed(4)}`,
		);
	});
}
