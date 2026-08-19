/**
 * Holographic Reduced Representation (HRR) primitives.
 *
 * Implementation notes:
 *   - We use the "correlation / inverse-correlation" pair rather than
 *     Plate's "(i-j) / (i+j)" form, because the latter introduces a
 *     cyclic shift of the recovered vector that breaks downstream
 *     cleanup unless the vocabulary is shifted to match.
 *       bind(a, b)[i]    = Σ_j a[j] · b[(i + j) mod D]
 *       unbind(c, a)[n]  = Σ_j c[j] · a[(n - j) mod D]
 *     With these formulas, unbind(bind(role, filler), role) ≈ ||role||²
 *     times the original filler in the no-noise limit. The cross terms
 *     (i ≠ j) contribute Gaussian noise of order √D, giving cosine
 *     similarity that grows with √D for clean bindings.
 *   - We use the naive O(D²) algorithm because D is typically small
 *     (≤ 256). For larger vectors, swap in an FFT implementation; the
 *     surface stays the same.
 *   - Vectors are sampled from a zero-mean, unit-variance normal
 *     distribution. Sampling is reproducible when a `seed` is supplied.
 */

import type { HRRVector } from "./types.js";

/**
 * Mulberry32 — a tiny seedable PRNG. We do not need cryptographic
 * randomness for HRR sampling; deterministic seeding makes tests
 * reproducible.
 */
function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Box-Muller transform — converts two uniform samples into one sample
 * from the standard normal distribution.
 */
function gaussian(rng: () => number): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = rng();
	while (v === 0) v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function assertPositiveDim(dim: number): void {
	if (!Number.isInteger(dim) || dim <= 0) {
		throw new Error(`HRRVector dim must be a positive integer, got ${dim}`);
	}
}

function assertSameDim(a: HRRVector, b: HRRVector, op: string): void {
	if (a.dim !== b.dim) {
		throw new Error(`${op}: dimension mismatch (${a.dim} vs ${b.dim})`);
	}
}

function allocate(dim: number, fill?: number): Float32Array {
	const out = new Float32Array(dim);
	if (fill !== undefined) {
		out.fill(fill);
	}
	return out;
}

/**
 * Sample a fresh HRR vector with the requested dimension. Default `seed`
 * is `Date.now()`; pass an explicit seed for reproducible test fixtures.
 */
function randomHRRVector(dim: number, seed?: number): HRRVector {
	assertPositiveDim(dim);
	const rng = createRandom(seed ?? Date.now());
	const data = allocate(dim);
	for (let i = 0; i < dim; i += 1) {
		data[i] = gaussian(rng);
	}
	return { dim, data };
}

/**
 * Bind `filler` to `role` via circular cross-correlation. The result
 * has the same dimension as both inputs and approximately zero mean.
 *
 *   bound[i] = Σ_j role[j] · filler[(i + j) mod D]
 *
 * The output is not symmetric in the two arguments (a ⊛ b ≠ b ⊛ a);
 * the first argument plays the role of "trace" and the second plays
 * the role of "value".
 */
function bind(role: HRRVector, filler: HRRVector): HRRVector {
	assertSameDim(role, filler, "bind");
	const dim = role.dim;
	const out = allocate(dim);
	const r = role.data;
	const f = filler.data;
	for (let i = 0; i < dim; i += 1) {
		let sum = 0;
		for (let j = 0; j < dim; j += 1) {
			const k = (i + j) % dim;
			sum += r[j] * f[k];
		}
		out[i] = sum;
	}
	return { dim, data: out };
}

/**
 * Recover the filler previously bound to `role`. The result approximates
 * ||role||² times the original filler; quality depends on D.
 *
 *   recovered[i] = Σ_j bound[j] · role[(i - j) mod D]
 *
 * In the high-D limit the noise (cross terms j ≠ i) averages out and
 * the recovered vector is aligned with the original filler.
 */
function unbind(bound: HRRVector, role: HRRVector): HRRVector {
	assertSameDim(bound, role, "unbind");
	const dim = bound.dim;
	const out = allocate(dim);
	const b = bound.data;
	const r = role.data;
	for (let i = 0; i < dim; i += 1) {
		let sum = 0;
		for (let j = 0; j < dim; j += 1) {
			// (i - j) mod D == ((i - j) + D) mod D
			const k = (i - j + dim) % dim;
			sum += b[j] * r[k];
		}
		out[i] = sum;
	}
	return { dim, data: out };
}

/**
 * Element-wise sum (HRR superposition). Each input contributes 1/N to the
 * output scale; callers may want to normalise after superposition.
 */
function superpose(vectors: HRRVector[]): HRRVector {
	if (vectors.length === 0) {
		throw new Error("superpose: at least one vector is required");
	}
	const dim = vectors[0].dim;
	for (const v of vectors) {
		if (v.dim !== dim) {
			throw new Error(`superpose: dimension mismatch (${v.dim} vs ${dim})`);
		}
	}
	const out = allocate(dim);
	for (const v of vectors) {
		for (let i = 0; i < dim; i += 1) {
			out[i] += v.data[i];
		}
	}
	return { dim, data: out };
}

function dot(a: HRRVector, b: HRRVector): number {
	assertSameDim(a, b, "dot");
	let sum = 0;
	for (let i = 0; i < a.dim; i += 1) {
		sum += a.data[i] * b.data[i];
	}
	return sum;
}

function norm(a: HRRVector): number {
	return Math.sqrt(dot(a, a));
}

function cosineSimilarity(a: HRRVector, b: HRRVector): number {
	const denom = norm(a) * norm(b);
	if (denom === 0) {
		return 0;
	}
	return dot(a, b) / denom;
}

/**
 * Pick the vocabulary entry with the highest cosine similarity to the
 * candidate. Returns the best match. The candidate is returned as-is
 * when the vocabulary is empty.
 */
function cleanup(candidate: HRRVector, vocabulary: HRRVector[]): HRRVector {
	if (vocabulary.length === 0) {
		return candidate;
	}
	let best = vocabulary[0];
	let bestScore = cosineSimilarity(candidate, best);
	for (let i = 1; i < vocabulary.length; i += 1) {
		const entry = vocabulary[i];
		const score = cosineSimilarity(candidate, entry);
		if (score > bestScore) {
			bestScore = score;
			best = entry;
		}
	}
	return best;
}

export {
	allocate,
	assertPositiveDim,
	assertSameDim,
	bind,
	cleanup,
	cosineSimilarity,
	createRandom,
	dot,
	gaussian,
	norm,
	randomHRRVector,
	superpose,
	unbind,
};
export type { HRRVector } from "./types.js";
