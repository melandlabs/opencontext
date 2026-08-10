# Philosophy

This document explains the _why_ behind the shape of opencontext. The
[README](../README.md) and [architecture doc](./architecture.md)
describe what the system is and how it works. This one explains the
choices that made it look the way it does.

## Why a runtime substrate at all

A useful agent needs at least five things:

1. Durable memory (what did the user say before?)
2. Retrieval (what is relevant to the current question?)
3. Connectivity (what can the agent reach into?)
4. Scheduling (when should the agent act without being asked?)
5. Boundaries (what may the agent do, and what must it never do?)

Most agent frameworks today conflate these five concerns into a single
"agent loop" that is really just an LLM-call loop with a tool list.
That works at small scale, and it falls apart at the seams:

- When memory drifts, you do not know whether the bug is in the
  retrieval pipeline, the embedding model, or the chunking logic.
- When the LLM does something the user did not ask for, you do not
  know whether it was a prompt issue, a tool permission, or a missing
  guardrail.
- When the system scales to multiple LLM providers, every abstraction
  leaks.

opencontext refuses to conflate these. Each concern gets its own
package, its own types, and its own test surface. The agent loop in
`@melandlabs/opencontext` is a thin coordinator on top, not the foundation.

## Why four verbs

`remember`, `recall`, `forget`, `improve`. We considered many surfaces
— CRUD, six verbs, a fluent query language, a DSL — and kept coming back
to the observation that **every persistent memory operation fits one of
those four shapes**.

- `remember` covers ingest and re-ingest.
- `recall` covers search, lookup, and graph traversal.
- `forget` covers soft-delete, tombstoning, and GDPR-pending erasure.
- `improve` covers correction, supersession, and merge.

Adding more verbs complicates the API without unlocking new use cases.
Removing verbs breaks legitimate use cases. Four is the minimum that
covers the full lifecycle.

We did not pick these four because a popular open-source memory project
uses similar verbs (it does, with slightly different semantics); we
picked them because after using each of them in production for a year,
they were the only verbs we ever wanted.

## Why a temporal graph, not a flat vector index

A vector index answers "what is semantically close to this query?". It
does not answer:

- "What did the user believe last Tuesday?"
- "Which of these facts supersedes which?"
- "Was this true when the user said it, or has it since been retracted?"

These are temporal questions. They are also the questions that
_matter_ — a personal assistant that does not know the user's
preferences changed last week is not useful.

The temporal context graph records, per fact: when it became true,
when it stopped being true, and why it changed. A recall can ask for
facts as-of a timestamp. Corrections are append-only so that future
callers can audit what the system used to believe.

The graph is implemented as a directed acyclic graph on top of the raw
message store. It is not a separate database; it is a way of looking at
the same data.

## Why a multiple-platform integration mesh

The first version of opencontext had three integrations: Gmail, Slack,
and Google Calendar. Within a year, the user-facing product needed
twenty-three more. Each one came with its own quirks:

- Some require OAuth, some require API keys, some require both.
- Some have rate limits measured in requests-per-second, others in
  requests-per-day.
- Some deliver webhooks with stable IDs, others deliver them with
  ephemeral ones.
- Some have first-class threading, others do not even have stable
  message identifiers.

A naïve abstraction — "an integration is an async function that
returns a list of messages" — collapses on the first platform that does
not fit the shape. So instead, each platform gets its own adapter that
returns a uniform `IntegrationRecord` shape on the read side and accepts
a uniform `IntegrationAction` shape on the write side. The cost is N
packages; the benefit is that each one is small enough to read in one
sitting, and the cost of adding a 28th platform is bounded.

## What we did not do

- We did not build a model provider abstraction. `@melandlabs/opencontext`
  imports the AI SDK directly. Adding an abstraction layer would have
  hidden the parts of each provider that callers actually want to use.
- We did not build a vector-database abstraction. Each backend has its
  own `MemoryStoreConfig` block. The trade-off is duplicated config; the
  benefit is that the abstraction never lies about what a backend can
  do.
- We did not build a plugin system. Every package is just a package.
  Extensions are forks. This is deliberate — plugins make breaking
  changes harder to ship, and breaking changes are how a runtime
  evolves.

## What you can rely on

- The four verbs (`remember`, `recall`, `forget`, `improve`) will not
  change shape before v1.0.
- The `@melandlabs/opencontext` types will only change in a major version.
- The temporal graph semantics (`valid_from`, `valid_until`,
  supersession, contradiction) will not change shape before v1.0.

Everything else — the storage backends, the embedding providers, the
transport surfaces — can change with a minor version, but with a
deprecation period of at least one minor version before removal.
