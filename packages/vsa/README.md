# `@melandlabs/vsa`

Vector Symbolic Architecture primitives for the OpenContext runtime.

This package provides:

- **HRR (Holographic Reduced Representation)** primitives: `randomHRRVector`,
  `bind`, `unbind`, `superpose`, `cleanup`, plus the underlying
  `dot` / `norm` / `cosineSimilarity` helpers.
- A small **`FactStore`** contract with an in-memory implementation that
  stores role/filler slots scoped by string.

The math layer is intentionally pure: no I/O, no async, no platform
dependencies. The whole package has zero runtime dependencies.

## Why HRR?

Holographic Reduced Representations compress `(role, filler)` pairs into
a single dense vector that can be stored, transmitted, and recalled.
You bind a `filler` to a `role`, superpose many bindings into one
memory vector, and later unbind with the same `role` to recall a noisy
approximation of the original `filler`. A `cleanup` step against a
vocabulary of known fillers disambiguates the recall.

## Capacity

HRR uses circular convolution; the effective clean-recall capacity is
roughly **√D** before crosstalk dominates:

| `dim` | capacity | use case                                |
| ----- | -------- | --------------------------------------- |
| 64    | ~8       | tiny chat preferences, demos            |
| 128   | ~11      | per-conversation state                  |
| 256   | ~16      | short-term session memory, agent state  |

For dense embeddings the canonical answer is still a vector store; HRR
is for short, structured `(role, filler)` slots where you want to store
many bindings in a single vector and recover any one on demand.

## Installation

```sh
pnpm add @melandlabs/vsa
```

## Quick start

```ts
import { bind, cleanup, randomHRRVector, superpose, unbind } from "@melandlabs/vsa";

const dim = 128;

// Random role/filler vectors.
const roleFavoriteColor = randomHRRVector(dim, 1);
const fillerBlue = randomHRRVector(dim, 2);

const rolePet = randomHRRVector(dim, 3);
const fillerCat = randomHRRVector(dim, 4);

const memory = superpose([
  bind(roleFavoriteColor, fillerBlue),
  bind(rolePet, fillerCat),
]);

// Recall: unbind with the role, then clean up against the known vocabulary.
const recalledPet = cleanup(unbind(memory, rolePet), [fillerBlue, fillerCat]);
// recalledPet ≈ fillerCat
```

See `examples/src/simple/19-vsa.ts` for an end-to-end example that pairs the
HRR layer with the `FactStore` contract (run via `pnpm --filter
@melandlabs/opencontext-examples test`).

## Fact store

Two implementations sit behind the `FactStore` contract (`put` / `get` /
`list` / `clear`):

### Exact, in-memory (`createInMemoryFactStore`)

A plain string KV. Retrieval is lossless and **unbounded** — it does not use
the HRR math, so the √D capacity figure does **not** apply here.

```ts
import { createInMemoryFactStore } from "@melandlabs/vsa";

const store = createInMemoryFactStore();
await store.put("user-42", { role: "favoriteColor", filler: "blue" });
const color = await store.get("user-42", "favoriteColor"); // "blue"
const list = await store.list("user-42"); // [{ role, filler }]
await store.clear("user-42");
```

The in-memory implementation is process-local; bring your own persistence if
you need durability.

### HRR-backed (`createHRRFactStore`)

Packs every `(role, filler)` slot into one superposed vector via `bind`, and
recovers a filler on `get` by `unbind`-ing with the role vector and running
`cleanup` against the filler vocabulary. This is where the **≈ √D** capacity
guidance from the Capacity section actually bites: with few slots recall is
exact, but once crosstalk dominates, `get` returns the nearest filler (an
approximation). Pick this when you want the HRR semantics; pick the exact KV
store above when you need lossless lookup.

```ts
import { createHRRFactStore } from "@melandlabs/vsa";

const store = createHRRFactStore({ dim: 128, seed: 1 });
await store.put("user-42", { role: "favoriteColor", filler: "blue" });
await store.put("user-42", { role: "pet", filler: "cat" });
// Exact while crosstalk is low:
const color = await store.get("user-42", "favoriteColor"); // "blue"
```

## Limitations

- `bind` / `unbind` use the naive O(D²) algorithm. For D ≥ 512, prefer
  an FFT-based circular convolution implementation.
- The in-memory `FactStore` is process-local. There is no persistence
  layer; callers must serialise explicitly if they need durability.
- This package is not an `IVectorStore` adapter. HRR semantics (role
  / filler binding, superposed memory) don't compose with cosine
  similarity over arbitrary query embeddings. The follow-up plan is a
  dedicated `vsa-store` adapter that exposes the HRR contract through
  its own interface.

## License

Apache-2.0.