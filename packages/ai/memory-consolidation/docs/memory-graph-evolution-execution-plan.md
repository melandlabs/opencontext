# Dynamic Memory Cluster Evolution Execution Plan

Status: `PHASE_0_3_SHIPPED_PHASE_4_GATES_MET`

## Objective

Prepare the accepted foundation and controlled write loop, controlled retrieval
loop, and authorized correction loop as three serial, reviewable experimental
Draft PR candidates. The stack remains disabled by default and does not
authorize a runtime cohort or rollout.

That stack shipped, and the Phase 4 demonstrations and gate work shipped on top
of it. The default-off constraint above is unchanged by either: nothing in this
plan has authorized enabling anything for a real user.

## Delivery Rules

- Requirements define product outcomes; architecture defines boundaries and
  invariants; ADRs hold durable decisions; this plan defines authorization and
  gates.
- Keep graph mutation, retrieval, correction, and rollback server-gated.
- Preserve source evidence, owner isolation, applicability, baseline fallback,
  operation identity, and retryable recovery.
- Do not add UI, scheduling, migration, shared memory, real-time LLM
  dependencies, or default-on behavior.
- A Draft PR stack may be published only after each candidate passes its own
  focused gate and the integrated Phase 0-3 gate passes.

## Review Order

| Candidate | Scope                                           | Dependency    |
| --------- | ----------------------------------------------- | ------------- |
| 1         | Phase 0-1 foundation and controlled write loop  | `origin/main` |
| 2         | Phase 2 trusted retrieval loop                  | Candidate 1   |
| 3         | Phase 3 authorized correction and rollback loop | Candidate 2   |

Later-phase imports, exports, route actions, tests, and status claims must not
appear in an earlier candidate.

## Candidate Scope

### Phase 0: control-plane foundation

**Outcome.** Provide owner-scoped graph contracts, staged publication, and
audit helpers.

**Gate.**

- Plans are deterministic, versioned, explainable, and safe to replay.
- Publication preserves visible evidence across partial failures.
- Audit can recover source nodes, edges, and operation identities.

### Phase 1: controlled real write loop

**Outcome.** New saved-chat evidence can evolve durable long-term memory for a
server-selected cohort.

**Included.**

- Persistent owner-scoped graph snapshots and applied-operation history.
- Evidence accumulation, reinforcement, competition, cluster lifecycle, staged
  summary publication, and source soft deprecation.
- Server-resolved owner scope, write allowlist, kill switch, revision
  protection, idempotent replay, and baseline fallback.
- Postgres, SQLite, and IndexedDB-compatible storage boundaries used by the
  existing raw-message runtime.

**Gate.**

- Repetition, temporary override, scope isolation, failure, retry, disablement,
  and kill-switch behavior pass focused runtime tests.
- Untrusted raw writes cannot select graph scope or internal graph metadata.

### Phase 2: controlled real retrieval loop

**Outcome.** Graph judgments can change one authenticated native-agent memory
context without weakening baseline safety.

**Included.**

- `default` retrieval suppresses superseded evidence when a usable
  representative exists.
- `audit` retrieval restores retained sources and provenance.
- `conflict` retrieval exposes only active, applicable alternatives with usable
  provenance.
- Persisted raw and summary materialization, partial graph coverage, trusted
  applicability, owner/workspace/tenant isolation, and prompt framing.
- Artifact-only rollout evaluation reports retrieval and audit scenarios but
  cannot enable a cohort.

**Gate.**

- Default suppression, audit recovery, conflict explanation, representative
  materialization, applicability, owner isolation, and baseline fallback pass.
- Missing, stale, mismatched, or unmaterializable graph state produces an
  explicit no-op or baseline result.

### Phase 3: authorized correction and rollback loop

**Outcome.** An explicitly authorized operator can repair graph outcomes and
recover evidence without direct storage surgery.

**Included.**

- Deterministic correction and rollback planning with reason codes and
  preserved operation ordering.
- Correction of summary content, cluster membership, lifecycle, and
  representative choice.
- Evidence-first rollback with status, reason codes, restored source IDs,
  provenance, idempotence, version checks, and retry convergence.
- Server-derived owner/requester identity, correction enablement, operator
  allowlist, kill switch, and bounded command validation.

**Gate.**

- Wrong merge, wrong representative, lifecycle repair, rollback ordering,
  partial failure, retry, history preservation, authorization, malformed input,
  and scope isolation pass.
- No unresolved high-severity finding remains after integrated review.

## Demonstrated Behaviour

Correctness tests show a mechanism does what it was specified to do. They
cannot show it is worth its complexity, because they never let the failure it
prevents actually happen. These demonstrations assert both arms: what the
baseline does with the same evidence, and what changes with the graph enabled.

Each runs through the real ingestion and retrieval paths, pairs every claim
with a control that removes the graph's knowledge while keeping its mechanics,
and is mutation tested so no arm can pass vacuously.

**Corrections and rollbacks take effect.** `memory_summaries` carries no
deprecation or visibility column, while `raw_messages` carries `deprecatedAt`.
A raw record can therefore be hidden without the graph; a summary cannot.
Baseline retrieval returns a summary a rollback already retired alongside the
one that replaced it, indistinguishable from live content. With the graph both
are absent from default retrieval and still reachable through audit retrieval.
Removing only the supersession record from the snapshot brings the summary
back, so the suppression follows that record rather than incidental filtering.

**Supersession follows evidence, not recency.** One contradicting record leaves
a stable preference at `default` with no cluster superseded; three retire it to
`audit-only` and mark its cluster `superseded`. Identical mechanics, more
evidence. Given the same two-phase evidence with the graph disabled the
baseline creates no summary and deprecates nothing, so this is a capability the
graph adds rather than a baseline defect it repairs.

**A task-scoped exception does not become a preference.** Three contradicting
records claiming global validity retire the standing preference; the same three
scoped to one task leave it standing and produce two coexisting `stable`
clusters. Dose, content, and mechanics are identical and only the applicability
differs, which makes the global arm the control for the scoped one.

**Withheld records can be named.** Given one candidate set that includes the
deprecated sources, both arms return the same single representative. The graph
also reports which three records it withheld and under which rules,
`default_hides_deprecated_raw` and `cluster_representative_prioritized`. The
baseline response carries the results plus three counters and no list-shaped
field at all, so there is nowhere for an account of withheld records to live;
it drops the same three silently. Removing the deprecation record from the
snapshot empties that accounting, so it follows the record rather than the
shape of the query. Nothing about result quality is in question here — the two
arms agree on the answer and differ on whether the answer can be explained,
which is what MR-10 asks for.

**Nothing is withheld anonymously.** The demonstrations above each show
something the capability does. G2 asks the opposite question over the same
machinery: of everything the baseline would have returned, is there anything the
enabled path drops without being able to say which record and under which rule.
Asking it found that there was. Retrieval named only deprecated raw records, so
a summary a rollback retired — the one case where the baseline is simply wrong,
and the most valuable behaviour demonstrated here — was withheld correctly and
reported nowhere. Records dropped for owner scope, applicability, or absence
from the graph were reported as a count with no identities at all.

Retrieval now derives both differences between the baseline candidates and its
own result: `withheldBaselineNodes` names every candidate it dropped with the
rule behind it, and `addedBeyondBaselineNodes` names everything it introduced
with the rule that admitted it. Both are computed from the difference rather
than reported by each filtering path, so a filter added later surfaces as
`unexplained` instead of disappearing, and `unexplained` raises a reason code a
rollout can alert on. The accounting is carried through to the runtime retrieval
type rather than left in the library, so what a rollout can monitor is what the
gate checked.

Two findings came out of building it, both recorded because they change what the
gate means. Audit mode alone does not restore a `deprecated` node — only
`includeDeprecated` does — so the recovery path G2 relies on is audit mode plus
that flag rather than audit mode by itself. And `deprecated` visibility is
readable and distinctly handled but written by nothing in the repository; the
rule is reachable only by constructing that state.

The gate's own wording needed correcting too. It asked that every withheld
result stay reachable through audit retrieval, which is right for a visibility
decision and exactly wrong for a scope one: a record withheld because it belongs
to another owner must stay unreachable in every mode. The two are now asserted
apart.

**A scoped memory widens only on independent agreement.** The one acceptance
scenario that described absent behaviour now has an implementation. Applicability
was inherited from evidence and never widened, so nothing could satisfy MR-4's
allowance for broadening on repeated support across independent contexts.

Building it found the reason nothing could. A support judgment between two
contexts that do not overlap — task A and task B — was dropped as `uncertain`
before any relation was recorded, so cross-context agreement left no trace
anywhere in the graph and there was nothing for broadening to read. That
judgment now records `related` with a distinct reason code, which also gives
MR-1 the outcome it asks for: a topical relation that is not enough to merge is
now distinguishable from no relation at all. Recording it is not merging it, and
clusters stay separate.

Broadening reads that record. Three contexts agreeing, each backed by a source
no other context supplies, widen the scoped clusters to global; two do not, and
the widened memory then competes with the standing global preference under the
ordinary rules rather than replacing it — the preference is still `stable` and
still the active representative. Evidence carrying an end date never widens,
because a global preference outlives it.

Two limits are worth stating. The independence rule cannot be reached through
ingestion, where source-identity deduplication already collapses repeats, so it
is asserted against a snapshot that carries the duplication directly; it is
defence for restored or externally produced state rather than a path the write
loop takes. And three is a threshold, configurable per call: it says repeated
agreement rather than two coincidences, and no measurement chose it.

**Repetition changes what is recalled, not the order it is recalled in.** The
acceptance table asked that consistent observations reinforce one cluster and
improve its retrieval priority. The first half holds and is dose-dependent: with
three consistent observations the cluster reaches `stable`, gains a
representative, and retrieval returns that one record where it previously
returned three sources, which stay reachable through audit. One observation
consolidates nothing, and the same three observations with graph lifecycle
disabled produce no summary at all, so this is a capability the graph adds.

The second half is not the graph's. Given the order the real retriever produces,
graph-aware ranking returns it unchanged — the representative is already first
without the graph. The rule that would lift it exists and applies when handed the
reverse order, but it never has to. Claiming a priority improvement here would be
claiming credit for the baseline's ordering, which is the same error the recall
delta turned out to be, so the acceptance row now states only what the graph
does. Ordering results by how much evidence supports them has no implementation:
`rankNodeIds` orders by kind, and cluster support score reaches retrieval
nowhere.

Two over-determinations surfaced while mutation testing this, both worth knowing
before touching the ranking code. The consolidated summary's first position is
produced independently by representative expansion and by the summary-before-raw
kind split, so disabling either alone changes nothing. And consolidation is
gated by both an evidence count and a support score, of which only the support
score binds at three observations.

**A readiness claim names what it observed.** G6 asked what a
`ready-for-limited-rollout` decision was founded on, and the answer was: not
necessarily anything. The rollout report reached that decision with no runtime
evidence at all — its retrieval scenarios were dry runs, its correction and
rollback gates were satisfied by commands that validated rather than operations
that ran, and the one gate that reads runtime evidence was added only when such
evidence existed, so its absence lowered the gate count instead of failing
anything. The existing test asserted that outcome as correct: twelve gates, all
passed, `dryRun: true`, ready for rollout.

Readiness is now gated on observation. `runtime.observed-evidence` is added
unconditionally and passes only when the report carries operations that actually
ran, so a report built from dry-run inputs is blocked with a nameable reason
rather than declared ready. The correction and rollback gates record whether an
applied operation or a validated command backed them, because those establish
different things and reported the same pass. The runtime evaluation path already
supplies this evidence, so the change blocks fabricated readiness rather than
real evaluation.

The general defect is worth stating separately from its instance: a gate that is
only added when its evidence exists cannot fail, and a decision computed from
`failedGateCount === 0` reads its absence as success. Any gate added later has
to be present whether or not it can be evaluated.

One result is recorded for what it rules out. Deduplication of repeated imports
has a real downstream effect inside the graph — one node instead of three, a
`forming` cluster instead of `stable`, no summary instead of one — but with the
graph disabled neither case consolidates at all. The baseline has no support
counter to inflate, so that rule protects the graph from itself rather than
repairing anything. Claims of that shape cannot be demonstrated against the
baseline, and manufacturing a comparison for them would only produce a
strawman.

## Draft PR Gate

The Phase 0-3 stack is ready only when:

1. Phase 4 persisted comparison evidence and its route policy, metadata, tests,
   and current-state documentation are absent.
2. All feature policies remain default-off and fail closed.
3. Focused write, retrieval, correction, rollback, route, and backend suites
   pass.
4. `apps/web` and memory-consolidation TypeScript checks pass.
5. Formatting, targeted lint, `git diff --check`, and final diff review pass.
6. The PR description references requirements, architecture, and applicable
   ADRs without copying them.

## Deferred Phases

### Phase 4: is it safe to turn on

Not authorized in this candidate. Phase 4 decides one thing: whether the
memory-graph defaults may be enabled for real users. That is a question about
safety and demonstrated behaviour rather than about winning a retrieval
benchmark, and the gates below are ordered accordingly.

**G1 — Demonstrated behaviour.** Every acceptance scenario classified as a
value or capability claim has a demonstration asserting both arms: what the
baseline does with the same evidence, and what changes with the graph enabled.
Each pairs its claim with a control that removes the graph's knowledge while
preserving its mechanics, and each arm is mutation tested. A scenario whose
baseline arm shows no failure is recorded as a safety claim rather than
converted into a comparison.

**G2 — No regression on the path being enabled.** Every result the baseline
would have returned is either still returned, or withheld for a reason the graph
names per record: deprecated, audit-only, out of applicability, out of owner
scope, or absent from the graph. A record withheld by a visibility rule stays
reachable through audit retrieval; a record withheld by a scope or applicability
rule must stay unreachable in every mode, which is why the two are asserted
apart rather than under one "still reachable" claim. Nothing appears that the
baseline would not have surfaced unless the graph names the rule that admitted
it. This is a set relation with stated justifications and needs no threshold.

**G3 — Failure and recovery hold when enabled.** Partial writes, cross-store
divergence, interrupted publication, and replayed operations converge or fail
closed with the raw evidence chain intact.

**G4 — Isolation holds when enabled.** No cross-user, cross-workspace,
cross-tenant, or cross-applicability result is reachable.

**G5 — Cost within budget.** Graph-incremental latency and payload stay within
the recorded budgets.

**G6 — Runtime readiness.** A `ready-for-limited-rollout` decision rests on
behaviour observed in the runtime being enabled, not on dry-run scenarios or
commands that merely validated. A gate that could not be evaluated is
distinguishable from one that passed, and a gate satisfied by a validated
command rather than an applied operation says which of the two backed it.

G3 and G4 are evidenced against the enabled path already, and it is worth being
precise about why rather than asking for a re-run.
`chat-memory-write-route.test.ts` sets the enable flag, cohort membership, and a
released kill switch in `beforeEach`, so every test in it drives the real route
under the enabled policy: adapter-missing fallback, partial write with retry
convergence, replay without duplicate reinforcement, cross-store deprecation
divergence, kill-switch fallback, and four cross-user ownership races. The
native-agent context route adds applicability derived only from an owned
server-side chat.

Beyond that, `resolveMemoryGraphWritePolicy` is consumed as a pure gate — every
caller returns a no-op when it is disabled and otherwise proceeds unchanged — so
the policy decides whether the graph path runs, not how it behaves. Evidence
gathered by calling the library directly is therefore evidence about the enabled
path, and re-running it with the flag on would test the flag. One qualifier
follows honestly from that: interrupted staged publication is proven at the
library level rather than through the route.

Cross-workspace and cross-tenant isolation have no enabled path to test, because
the runtime never populates either scope. That matches the requirement that they
are optional and do not replace user identity, and both stay covered where they
can be constructed, at the library level.

**What this gate deliberately excludes.** Aggregate retrieval quality. A local
cohort's recall against a fixed similarity threshold measures the embedding
model's fit to a set of queries. That is a real product concern and it is
currently poor, but the memory graph neither causes it nor can repair it, and
gating a graph decision on it blocks Phase 4 for reasons unrelated to the
graph. Three facts support this, each checkable in the code rather than
inferred from a measurement: the recall gate scores the product semantic path
and not the graph-aware one; graph-aware retrieval re-ranks and filters
baseline candidates and so cannot manufacture recall the baseline lacked; and
the one behaviour the capability demonstrably changes, withholding a summary a
correction or rollback retired, does not alter whether an expected record was
retrieved.

This is a change of scope and not a lowered bar. Retrieval quality needs its
own workstream and its own evidence, and Phase 5 must not read this gate's
passing as a statement about it.

An evaluation apparatus for the earlier definition of this phase was built and is
deliberately not proposed. It collected paired baseline-versus-graph evidence,
labelled it against one owner's real query history, and reduced both to a
fail-closed verdict. It is complete and tested, and it is held back because it
did not establish that the capability is valuable.

That conclusion is worth keeping even though the instrument is not. Its verdict
was blocked, and its one positive signal — a mean graph recall delta above budget
— was refuted by a negative control: discarding the graph's ranking and keeping
only its record-removal decision reproduces the same recall exactly, so the delta
carried no ranking contribution. Two design faults explain it. The paired
comparison issues no query, so it never measured per-query retrieval quality, and
the recall gate scores the product semantic path rather than the graph-aware path
it was read as scoring. What survived is what this candidate carries: the
demonstrations above, and the method behind them.

### Phase 5: gradual rollout

May begin only after Phase 4 passes and the project owner explicitly approves a
limited rollout. It must retain scope-based expansion, kill-switch containment,
and rollback.

Rollout monitors the same properties Phase 4 gates on, and for the same reason
the gate excludes aggregate retrieval quality: a signal that does not track the
thing being rolled out cannot steer the rollout. Concretely, monitoring watches
for results the enabled path withholds without a nameable reason (G2), for
isolation breaches (G4), and for latency or payload beyond budget (G5). A
retrieval-quality regression is worth knowing about but belongs to the separate
workstream and is not a rollback trigger here.

Enabling is currently coarser than the evidence. Graph write and graph-aware
retrieval share one policy, so the behaviour with the strongest evidence cannot
be enabled without the ones that have none. Phase 5 must either accept that
bundle and gate on the whole of it, or add a retrieval seam first. That choice
is open.

### Phase 6: maturation

Product UX, scheduling, storage optimization, optional artifact generation, and
shared-memory design require separate authorization after validated rollout.
This remains a list of candidates rather than a specification, and should stay
empty until something concrete needs to go in it.

## Stop Line

Stop at `PHASE_0_3_SHIPPED_PHASE_4_GATES_MET`. Phases 0-3 are merged and the six
Phase 4 gates are met, which establishes that enabling the defaults would be
safe — not that it should happen. Everything remains default-off.

Do not enable a default, expand a runtime cohort, collect cohort observations,
or begin Phase 5 without the project owner's explicit approval. Phase 5 also has
an unresolved design question recorded above: graph write and graph-aware
retrieval share one policy, so the behaviour with the strongest evidence cannot
be enabled without the ones that have none. Settle that before any rollout, not
during one.
