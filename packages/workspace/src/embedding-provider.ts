/**
 * `@melandlabs/workspace` — embedding provider adapter.
 *
 * The JS API and CLI want a single "give me a vector for this text" /
 * "give me vectors for these N texts" surface that honours the
 * `EMBEDDING_PROVIDER` env var (`local` | `cloud`). Without this adapter
 * `generateEmbedding` / `generateEmbeddings` from `@melandlabs/rag`
 * always hit OpenRouter, which makes `hybrid` / `cross-file` / `semantic`
 * search unusable in a fully-offline setup.
 *
 * The provider lives in `@melandlabs/ai-rag`, which is an **optional**
 * peer dep: hosts that only want lexical search don't need to install
 * it. The adapter is therefore a lazy dynamic import — if the host never
 * sets `EMBEDDING_PROVIDER=local` *and* never calls into the embedding
 * path with `local` semantics, the import never resolves.
 *
 * Hosts that *do* set `EMBEDDING_PROVIDER=local` must install
 * `@melandlabs/ai-rag` themselves; the workspace package surfaces a
 * clear error in that case instead of crashing the module load.
 */

export interface WorkspaceEmbeddingProvider {
	embedQuery(text: string): Promise<number[]>;
	embedDocuments(texts: string[]): Promise<number[][]>;
	getModelName(): string;
	getDimensions(): number | undefined;
}

export type WorkspaceEmbeddingProviderType = "cloud" | "local";

let _provider: WorkspaceEmbeddingProvider | undefined;

function resolveProviderType(): WorkspaceEmbeddingProviderType {
	// Default to `local` for the workspace CLI: folder indexing is
	// positioned as an offline-first feature and most demos / OKF review
	// workflows don't carry an OPENROUTER_API_KEY. Set
	// `EMBEDDING_PROVIDER=cloud` to opt into the 1536-dim OpenRouter path.
	const raw = (process.env.EMBEDDING_PROVIDER ?? "local").trim().toLowerCase();
	return raw === "local" ? "local" : "cloud";
}

/**
 * Returns the singleton embedding provider, instantiating it on first
 * call. Honours `EMBEDDING_PROVIDER` at construction time so the model
 * weight download (local) or API key validation (cloud) only happens
 * once per process.
 *
 * Throws if `EMBEDDING_PROVIDER=local` is set but `@melandlabs/ai-rag`
 * isn't installed.
 */
export async function getWorkspaceEmbeddingProvider(): Promise<WorkspaceEmbeddingProvider> {
	if (_provider) return _provider;
	const providerType = resolveProviderType();
	if (providerType === "local") {
		// Dynamic import keeps `@melandlabs/ai-rag` out of the static
		// dependency graph for hosts that don't need local embeddings.
		const specifier = "@melandlabs/ai-rag/embedding-provider";
		let mod: typeof import("@melandlabs/ai-rag/embedding-provider");
		try {
			mod = await import(specifier);
		} catch (error) {
			throw new Error(
				`EMBEDDING_PROVIDER=local but "${specifier}" could not be resolved. ` +
					`Install @melandlabs/ai-rag to enable local ONNX embeddings ` +
					`(Xenova/all-MiniLM-L6-v2, 384 dims by default). ` +
					`Underlying error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const provider = mod.getConfiguredEmbeddingProvider({ providerType: "local" });
		if (!provider) {
			throw new Error(
				`EMBEDDING_PROVIDER=local but getConfiguredEmbeddingProvider returned no provider`,
			);
		}
		_provider = provider;
	} else {
		const specifier = "@melandlabs/ai-rag/embedding-provider";
		let mod: typeof import("@melandlabs/ai-rag/embedding-provider");
		try {
			mod = await import(specifier);
		} catch (error) {
			throw new Error(
				`Cloud embedding provider requested but "${specifier}" could not be resolved. ` +
					`Install @melandlabs/ai-rag to enable OpenRouter-backed embeddings ` +
					`(requires OPENROUTER_API_KEY). ` +
					`Underlying error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const provider = mod.getConfiguredEmbeddingProvider({ providerType: "cloud" });
		if (!provider) {
			throw new Error(
				`Cloud embedding provider requested but getConfiguredEmbeddingProvider returned no provider`,
			);
		}
		_provider = provider;
	}
	return _provider;
}

/**
 * Convenience: embed a single text and return just the vector.
 * Used by `searchWorkspaceContext` for the query side.
 */
export async function workspaceEmbedQuery(text: string): Promise<number[]> {
	const provider = await getWorkspaceEmbeddingProvider();
	return provider.embedQuery(text);
}

/**
 * Convenience: embed a batch of texts and return parallel vectors.
 * Used by `createEmbeddingQueue` for the chunk fan-out.
 */
export async function workspaceEmbedDocuments(texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	const provider = await getWorkspaceEmbeddingProvider();
	return provider.embedDocuments(texts);
}

/**
 * Read the model name of the active provider without instantiating it.
 * Used for the `embedding_model` column on `workspace_chunks`.
 */
export async function workspaceEmbeddingModelName(): Promise<string> {
	const provider = await getWorkspaceEmbeddingProvider();
	return provider.getModelName();
}

/**
 * Read the dimension of the active provider without instantiating it
 * (the cloud provider only knows its dim after the first embed call).
 * Returns `undefined` for the cloud provider pre-warmup.
 */
export async function workspaceEmbeddingDimensions(): Promise<number | undefined> {
	const provider = await getWorkspaceEmbeddingProvider();
	return provider.getDimensions();
}

/** Test-only: drop the singleton so the next call re-instantiates. */
export function __resetWorkspaceEmbeddingProviderForTests(): void {
	_provider = undefined;
}
