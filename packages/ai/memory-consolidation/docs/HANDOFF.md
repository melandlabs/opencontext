# Memory Graph Handoff

Status: `PHASE_0_3_SHIPPED_PHASE_4_GATES_MET`

## Authority

The [execution plan](./memory-graph-evolution-execution-plan.md) is the sole
authority for status, phase numbering, and scope. This handoff summarizes; it
never widens what that plan authorizes.

## Where the work stands

Phases 0-3 are merged and ship default-off. Phase 4 has been redefined: it now
decides whether the defaults may be turned on, judged by demonstrated behaviour
and safety rather than by an aggregate retrieval metric. The reasoning and the
six gates are in the execution plan under Deferred Phases.

## What is demonstrated

Seven claims have two-armed demonstrations with controls and mutation testing.
In order of how much they establish:

- Corrections and rollbacks take effect. Baseline retrieval returns a summary a
  rollback already retired; the graph withholds it and audit retrieval still
  reaches it. The only scenario so far where the baseline is simply wrong.
- Withheld records can be named. Identical results from both arms; only the
  graph can say which records it withheld and under which rule.
- Supersession follows evidence, not recency. One contradicting record does not
  retire a stable preference; three do.
- A task-scoped exception does not become a preference. Same dose and content,
  only applicability differs, and the outcomes diverge.
- Nothing is withheld anonymously. Every baseline candidate the enabled path
  drops is named with its rule, everything it adds is named with the rule that
  admitted it, and a drop no rule accounts for is reported as `unexplained`
  rather than absorbed into the nearest plausible label.
- A readiness claim names what it observed. A rollout report built from dry-run
  scenarios and validated commands is blocked rather than declared ready, and
  gates say whether an applied operation or a validated command backed them.
- A scoped memory widens only on independent agreement. Three contexts agreeing,
  each backed by a source no other supplies, widen a task-scoped preference to
  global; two do not, and evidence with an end date never does. The widened
  memory then competes with the standing preference rather than replacing it.
- Repetition changes what is recalled. Three consistent observations consolidate
  into one representative where one observation consolidates nothing and the
  graph-disabled baseline produces no summary at all. It does not change the
  order results come back in; that half of the acceptance row was the baseline's
  doing and has been corrected rather than claimed.

Classification matters here. Of fourteen acceptance scenarios, one is a value
claim, four are capability claims, and nine are safety claims that cannot be
demonstrated against a baseline that lacks the mechanism. No row is unimplemented
any more. Three scenarios were reclassified downward after testing and none moved
up, so the untested rows should be read as optimistic. One acceptance row was
also narrowed, because half of what it asked for turned out to be the baseline's
work rather than the graph's.

## Standing against the redefined gate

| Gate | Status                                                               |
| ---- | -------------------------------------------------------------------- |
| G1   | Met. Five of five, with one acceptance row corrected to match        |
| G2   | Met. The gap it found is closed and the fix is asserted              |
| G3   | Met at the enabled path; one qualifier below                         |
| G4   | Met for cross-user and cross-applicability; the rest has no path     |
| G5   | Measured: P95 graph-incremental latency ~`3.92 ms`, payload `5689` B |
| G6   | Met. The gap it found is closed and both arms are asserted           |

G2 found a real gap rather than confirming an assumption. Retrieval withheld
records it could not name — including the summary a rollback retires, which is
the most valuable behaviour here. It now reports both differences from the
baseline, withheld and added, each with the rule behind it, and carries them
through to the runtime type so a rollout can monitor what the gate checked.

G6 found a gap of the same shape. The rollout report could reach
`ready-for-limited-rollout` having observed nothing: dry-run retrieval
scenarios, correction and rollback gates satisfied by commands that only
validated, and a runtime gate that was added only when runtime evidence existed,
so its absence lowered the gate count rather than failing. Readiness is now
gated on observation, and gates record whether an applied operation or a
validated command backed them.

G3 and G4 were previously recorded as needing an enabled-path re-run. That was
wrong: the route tests already run under the enabled policy, and the policy is a
pure on/off gate that does not change how the graph behaves. The execution plan
records the correction, the coverage, and the one qualifier — interrupted staged
publication is proven at the library level rather than through the route.
Cross-workspace and cross-tenant isolation have no enabled path because the
runtime never populates those scopes.

## Next bounded step

All six gates are met and every acceptance scenario has an implementation, so
Phase 4 has nothing substantive left.

Phase 5 needs one decision before any rollout begins: graph write and
graph-aware retrieval share a single policy, so the behaviour with the strongest
evidence cannot be enabled without the ones that have none. Accept the bundle and
gate on the whole of it, or add a retrieval seam first. That choice is open, and
it is not authorized here — enabling a default, expanding a cohort, or beginning
Phase 5 each still require explicit approval.

## Required reading

- [Requirements](./memory-graph-evolution-requirements.md): the acceptance
  scenario table, MR-4, MR-7, and MR-10.
- [Architecture](./memory-graph-evolution-architecture.md): applicability,
  staged publication, and rollout governance.
- [ADR index](./adr/README.md): ADR-0001 through ADR-0006.
- [Execution plan](./memory-graph-evolution-execution-plan.md): Demonstrated
  Behaviour, Deferred Phases, and Stop Line.

## Method that produced these results

Two rules did the work and should carry forward. Assert both arms, never only
the passing one — a mechanism's value is in the failure it prevents, so a test
that never lets that failure happen cannot show the value. And mutation test
every arm, because an arm that cannot fail is the same defect as a tuned
threshold. Both rules caught real errors here: a baseline arm whose assertions
held whether or not the graph was enabled, a positive result that a control
reproduced with the graph's ranking discarded entirely, and a G2 arm that
asserted over an empty set and so would have passed against any implementation.

One pattern recurred often enough to name. A mutation that leaves a test green
does not always mean the test is weak; it can mean the behaviour is
over-determined, with two independent mechanisms producing the same result so
that disabling either changes nothing. That happened three times here: two
ranking rules both lift a consolidated summary, two thresholds both gate
consolidation, and two justifications both admit an added record. Each time the
useful move was to disable both and record the redundancy, because a reader of
the ranking code needs to know that changing one rule will not change the
output.

The second rule earned its keep again in a subtler way. G2's first version let
the test infer from the snapshot why a record had been added, which meant a
mutation could disable one justification and the test would still pass on
another. A gate that asks whether the graph can explain itself must read the
graph's explanation, not reconstruct one. Mutating an assertion that consults
the wrong source is how that surfaced.

## Stop line

Do not enable any default, expand a cohort, propose the archived apparatus, or
begin Phase 5 without the redefined Phase 4 gate passing and explicit
authorization.
