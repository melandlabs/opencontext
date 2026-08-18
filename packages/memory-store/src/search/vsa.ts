/**
 * `@melandlabs/memory-store` — VSA (Vector Symbolic Architecture) facade.
 *
 * Four verbs on top of any `VsaFactStorage` backend:
 *
 *   - `storeFact(input)` — persist a (role, filler) binding.
 *   - `recall(input)`    — rebuild the memory vector from the user's
 *                          facts, unbind by the requested role, and pick
 *                          the best vocabulary entry.
 *   - `listFacts(input)` — read-side projection of stored facts (no vectors).
 *   - `forget(input)`    — soft-delete facts by id (idempotent).
 *
 * The facade intentionally does NOT route through `unified-search`. VSA
 * recall semantics differ: a single best-match from a vocabulary, not
 * top-K nearest neighbours. Folding both into one result set would require
 * a confusing union type and a fake "similarity" field that doesn't mean
 * the same thing across sources.
 *
 * Persistence shapes live in `@melandlabs/contracts/vsa-fact`. The HRR
 * algebra (`bind` / `unbind` / `superpose` / `cleanup` / `cosineSimilarity`)
 * is imported from `@melandlabs/vsa` — a leaf package with no runtime deps.
 */

import type {
	StoreVsaFactInput,
	StoreVsaFactOutput,
	VsaFact,
	VsaFactStorage,
	VsaFactSummary,
	VsaForgetInput,
	VsaForgetOutput,
	VsaListInput,
	VsaRecallInput,
	VsaRecallOutput,
	VsaRecallScore,
} from "@melandlabs/contracts";
import { vsaAssertSameDim, vsaNormalizeVector } from "@melandlabs/contracts";
import { type HRRVector, bind, cleanup, cosineSimilarity, superpose, unbind } from "@melandlabs/vsa";

const DEFAULT_MAX_FACTS = 1000;
/** Below this cosine score we surface `vsa_low_confidence`. Tuned empirically
 * for D=128 with up to a few hundred facts; tune for your dim. */
const LOW_CONFIDENCE_THRESHOLD = 0.1;

function toHRR(data: number[] | Float32Array): HRRVector {
	const arr = data instanceof Float32Array ? data : new Float32Array(data);
	return { dim: arr.length, data: arr };
}

function generateFactId(): string {
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `vsa-${stamp}-${rand}`;
}

export interface VsaRecallFacade {
	storeFact(input: StoreVsaFactInput): Promise<StoreVsaFactOutput>;
	recall(input: VsaRecallInput): Promise<VsaRecallOutput>;
	listFacts(input: VsaListInput): Promise<VsaFactSummary[]>;
	forget(input: VsaForgetInput): Promise<VsaForgetOutput>;
}

export function createVsaRecall(storage: VsaFactStorage): VsaRecallFacade {
	return {
		async storeFact(input: StoreVsaFactInput): Promise<StoreVsaFactOutput> {
			const roleVector = vsaNormalizeVector(input.roleVector, "roleVector");
			const fillerVector = vsaNormalizeVector(input.fillerVector, "fillerVector");
			vsaAssertSameDim(roleVector, fillerVector, "storeFact");
			const dim = input.dim ?? roleVector.length;
			if (roleVector.length !== dim) {
				throw new Error(`storeFact: roleVector.length (${roleVector.length}) must equal dim (${dim})`);
			}

			const now = Date.now();
			const fact: VsaFact = {
				factId: input.factId ?? generateFactId(),
				userId: input.userId,
				roleLabel: input.roleLabel,
				fillerLabel: input.fillerLabel,
				roleVector,
				fillerVector,
				dim,
				scopeTag: input.scopeTag ?? "default",
				botId: input.botId,
				createdAt: now,
			};
			await storage.storeFact(fact);
			return { factId: fact.factId, createdAt: now };
		},

		async recall(input: VsaRecallInput): Promise<VsaRecallOutput> {
			const roleVector = vsaNormalizeVector(input.roleVector, "roleVector");
			const scopeTag = input.scopeTag ?? "default";
			const maxFacts = input.maxFacts ?? DEFAULT_MAX_FACTS;

			if (input.vocabulary.length === 0) {
				throw new Error("vsaRecall: vocabulary must contain at least one entry");
			}

			const facts = await storage.queryFacts({
				userId: input.userId,
				scopeTag,
				botId: input.botId,
				includeDeprecated: false,
				limit: maxFacts,
			});

			const warnings: Array<{ code: string; message: string }> = [];

			if (facts.length === 0) {
				warnings.push({
					code: "vsa_no_facts",
					message: `No VSA facts for userId=${input.userId} scopeTag=${scopeTag}`,
				});
				return {
					fillerLabel: "",
					score: 0,
					allScores: [],
					factCount: 0,
					warnings,
				};
			}

			// Validate dim consistency across facts. Facts with a different
			// `dim` from the reference are surfaced as warnings and dropped
			// from the memory vector — otherwise `superpose` would throw and
			// the user would lose all recall output, including the
			// consistent facts.
			const refDim = facts[0].dim;
			const dimMatchedFacts = facts.filter((fact) => {
				if (fact.dim === refDim) return true;
				warnings.push({
					code: "vsa_dim_mismatch",
					message: `Fact ${fact.factId} has dim=${fact.dim}, expected ${refDim}; skipping`,
				});
				return false;
			});

			if (roleVector.length !== refDim) {
				throw new Error(
					`vsaRecall: roleVector dim (${roleVector.length}) must match stored fact dim (${refDim})`,
				);
			}

			if (dimMatchedFacts.length === 0) {
				warnings.push({
					code: "vsa_no_facts",
					message: `All stored facts for userId=${input.userId} scopeTag=${scopeTag} had a non-matching dim`,
				});
				return {
					fillerLabel: "",
					score: 0,
					allScores: [],
					factCount: 0,
					warnings,
				};
			}

			// Rebuild the superposed memory vector: bind(role, filler) for each
			// dim-matched fact. HRR superposition is a sum, so scale grows with
			// factCount. The cosine cleanup is scale-invariant, so we don't
			// normalise here.
			const memoryVec = superpose(
				dimMatchedFacts.map((fact) => bind(toHRR(fact.roleVector), toHRR(fact.fillerVector))),
			);

			// Unbind by the requested role → recovered candidate.
			const candidate = unbind(memoryVec, toHRR(roleVector));

			// Run cleanup against the vocabulary. The returned vector is the
			// best-match entry; we use its index in the vocabulary array to
			// pick the label. We also produce a full sorted score list so the
			// caller can inspect confidence.
			const vocabVecs = input.vocabulary.map((entry) =>
				toHRR(vsaNormalizeVector(entry.vector, `vocabulary[${entry.label}].vector`)),
			);
			const bestVec = cleanup(candidate, vocabVecs);
			const bestIdx = vocabVecs.indexOf(bestVec);

			const allScores: VsaRecallScore[] = input.vocabulary.map((entry, idx) => ({
				label: entry.label,
				score: cosineSimilarity(candidate, vocabVecs[idx]),
			}));
			allScores.sort((a, b) => b.score - a.score);

			const fillerLabel = bestIdx >= 0 ? input.vocabulary[bestIdx].label : "";
			const score = allScores[0]?.score ?? 0;

			if (score < LOW_CONFIDENCE_THRESHOLD) {
				warnings.push({
					code: "vsa_low_confidence",
					message: `Best match "${fillerLabel}" score ${score.toFixed(3)} below ${LOW_CONFIDENCE_THRESHOLD}`,
				});
			}

			if (facts.length >= maxFacts) {
				warnings.push({
					code: "vsa_fact_limit_reached",
					message: `Loaded ${facts.length} facts (cap=${maxFacts}); recall may degrade with more`,
				});
			}

			return {
				fillerLabel,
				score,
				allScores,
				factCount: facts.length,
				warnings,
			};
		},

		async listFacts(input: VsaListInput): Promise<VsaFactSummary[]> {
			const facts = await storage.queryFacts({
				userId: input.userId,
				scopeTag: input.scopeTag,
				botId: input.botId,
				includeDeprecated: input.includeDeprecated,
			});
			return facts.map((fact) => ({
				factId: fact.factId,
				userId: fact.userId,
				roleLabel: fact.roleLabel,
				fillerLabel: fact.fillerLabel,
				scopeTag: fact.scopeTag,
				botId: fact.botId,
				createdAt: fact.createdAt,
				deprecatedAt: fact.deprecatedAt,
			}));
		},

		async forget(input: VsaForgetInput): Promise<VsaForgetOutput> {
			const result = await storage.deprecateFacts({
				userId: input.userId,
				factIds: input.factIds,
				reason: input.reason,
			});
			return { deprecatedCount: result.deprecatedCount };
		},
	};
}
