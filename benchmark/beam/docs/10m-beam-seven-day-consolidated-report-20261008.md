# BEAM 10M Seven-Day Local Experiment Report

Date: 2026-10-08
Scope: 2026-09-29 to 2026-10-08
Status: local experiments consolidated; no online AML submission was made

## Scope and comparison rules

This report consolidates the BEAM 10M local experiments covering retrieval,
reranking, context construction, model selection, and the Answer/Judge path.
The dataset contains 10 conversations and 200 questions. Except where marked
as historical, complete runs used the official BEAM questions, rubrics,
parsers, and event metrics.

The local evaluation used final Top-12 evidence. The public AML flow records a
Top-100 retrieval setting, so these numbers are local diagnostic results and
are not online leaderboard scores. Answers primarily used DeepSeek Flash and
judgements used Qwen Flash, with reasoning disabled. The local reranker was
`Xenova/ms-marco-MiniLM-L-6-v2`. QA score is the mean rubric score over 200
questions, not a pass rate. Source Recall is computed on 176 questions with
annotated source IDs and does not prove that the exact answer-bearing sentence
was visible to the Answer model.

Different models, indexes, candidate budgets, and resumed states are not
treated as direct causal comparisons. A change is considered useful only when
its paired control uses the same input, provider, Judge configuration, and
evaluation path.

## Complete result tables

### Models and main retrieval paths

| Experiment | Answer / Judge setup | Mean QA | Source Recall@12 | Decision |
| --- | --- | ---: | ---: | --- |
| DeepSeek Flash Answer + Qwen Flash Judge | complete local Top-12 re-evaluation | 0.2693 | 0.3169 | early model baseline |
| Qwen3-14B Answer + Qwen Flash Judge | reused the same retrieval input | 0.3145 | 0.3169 | model effect; not a retrieval effect |
| Historical query rewrite | original complete branch run | 0.24625 | 0.34230 | keep disabled |
| Historical iterative union | original complete branch run | 0.28442 | 0.34510 | keep disabled |
| Current native FTS control | matched current-code control | 0.29561 | 0.34053 | historical current baseline |
| Current lexical rewrite | paired with native control | 0.27532 | 0.35376 | recall up, QA down |
| Native evidence plus lexical rewrite | fresh paired control | 0.31407 | 0.35394 | small gain; no promotion |
| Fixed-pool pointwise evidence scorer | paired with fresh MiniLM control | 0.31368 | 0.31445 | uncertain; recall down |
| Six-user-message selection | fixed-pool replay | 0.28063 | 0.36052 | no promotion |
| Twelve-user-message selection | fixed-pool replay | 0.24555 | 0.39141 | clear regression |

### Index and candidate architecture experiments

| Experiment | Mean QA | Source Recall@12 | Decision |
| --- | ---: | ---: | --- |
| BGE-M3 1024-dimensional control | 0.282875 | historical comparison | below current baseline |
| BGE-M3 1024-dimensional changed | 0.285295 | historical comparison | no stable end-to-end gain |
| 384-dimensional MiniLM baseline | 0.305306 | 0.338851 | selected end-to-end baseline |
| Weighted RRF 0.7 / 0.3 | retrieval only | 0.315097 | reject |
| Weighted RRF 0.5 / 0.5 | retrieval only | 0.338851 | same ordering as 1:1 |
| Weighted RRF 0.3 / 0.7 | retrieval only | 0.287990 | reject |
| Session neighbor N1 | retrieval only | 0.328110 | reject |
| Session neighbor N2 | 0.278960 | 0.346332 | recall up, QA down |
| Session neighbor N3 | retrieval only | 0.346096 | exceeds latency gate |
| Top-12 / candidate pool 80 | retrieval only | 0.341249 | retrieval gain only |
| Top-20 / candidate pool 48 | 0.289167 | 0.359923 | QA down |
| Top-38 / candidate pool 80 | 0.282486 | 0.417150 | highest recall, QA down |

A separate fixed-pool BGE comparison scored MiniLM `0.2844167` and BGE
`0.2598712`. Its input and control scope differ from the BGE-M3 1024-dimensional
full run, so the two BGE results must not be merged.

## Did query rewriting and iterative retrieval expand the candidate range?

They expanded the intermediate search coverage, but they did not expand the
final answer budget. The important distinction is:

```text
more query/search results
        -> channel union
        -> bounded fusion pool (48 candidates)
        -> reranker
        -> final Top-12 context
```

The iterative path performs several searches and unions their candidates. In
the recorded full run, the available channel union had mean source recall
`0.4723`, the fused 48-candidate pool had `0.4125`, and final Top-12 had
`0.3451`. Thus the intermediate candidate range was wider, but 13 questions
lost their last annotated source at fusion and another 18 lost one at final
ranking or truncation. The public Top-100 setting was not used in this local
run.

Query rewriting also generated additional query expressions and could bring
more lexical or semantic hits into the channel union. The fusion budget still
remained 48 and the final answer budget remained Top-12. In the matched native
run, source recall rose from `0.34053` to `0.35376`, while QA fell from
`0.2956136` to `0.2753182`.

The lower QA score has three observed causes:

1. The extra queries added related but non-answer-bearing messages. More parent
   IDs reached fusion, but the 48-item cap forced competition between specific
   evidence and generic background.
2. The reranker still had to select twelve items from the same final budget.
   A source found in the expanded union could still be removed during fusion,
   reranking, or context truncation.
3. Query variants changed the score and rank distribution. They improved
   parent-level recall in some cases without guaranteeing that the exact
   answer sentence survived into the context shown to the Answer model.

Iterative union also had 136 degraded traces in the historical run. A later
twenty-question action audit found that most degradation came from failing to
commit useful new evidence, rather than simply having too few search actions.
The full run's QA gain over historical query rewrite was driven largely by
abstention (`0.45` to `0.80`); excluding abstention, the remaining 180
questions were approximately `0.2236` versus `0.2271`. This does not support
enabling iterative retrieval by default.

## Seven-day experiment record

### September 29: model and Judge path

DeepSeek Flash and Qwen3-14B Answer runs were compared under Qwen Flash Judge.
Both runs completed all 200 answers and judgements and confirmed that the local
reranker was active. Provider routing, disabled reasoning, bounded retries, and
checkpoint resume were recorded for later runs.

### September 30 to October 2: evidence chain and message boundaries

The work fixed and tested BM25 score direction, partial vector results after
window expansion, loss of multiple matched spans under parent deduplication,
and reranker input-window handling. Parents remain complete messages while
search children are used for retrieval. Supplied timestamps are preserved;
missing timestamps remain missing; `messageSequence` describes ingestion order
for one user and does not replace an event date.

The traces now preserve source parents, matched spans, semantic hits, keyword
hits, fusion, reranker output, final context, and stage timings. This prevents
an ID-level source hit from being mistaken for visible answer evidence.

### October 3 to October 4: query rewriting and iterative retrieval

Historical query rewrite scored `0.24625`, while iterative union scored
`0.28442`. The aggregate difference came mainly from abstention. Event ordering
and temporal reasoning remained weak, so both features remain opt-in.

The matched current lexical rewrite increased Source Recall but reduced QA. The
expanded intermediate candidate coverage did not translate into better final
answers because the fusion and Top-12 budgets stayed fixed.

### October 4 to October 5: reranking, evidence selection, and BGE-M3

The fixed-pool pointwise scorer raised the QA point estimate from `0.27079` to
`0.31368`, but Source Recall fell from `0.34510` to `0.31445`; its paired
bootstrap interval included zero. It remains a candidate direction rather than
a default replacement.

BGE-M3 1024-dimensional embeddings with tokenizer-aware 1024/128 chunking
completed a 200-question comparison. They did not consistently exceed the
384-dimensional MiniLM baseline. The embedding, chunking, and reranker changes
were therefore not combined into the selected default path.

User-message selection increased source IDs in some experiments, but the
twelve-message policy lowered QA. Source selection must be evaluated together
with answer-span visibility and Judge score.

### October 6 to October 7: RRF, session neighbors, and Top-K

Weighted RRF, session-neighbor expansion, and Top-12/20/38 candidate settings
were completed. Top-38 produced the strongest source recall (`0.417150`) but a
lower QA score (`0.282486`). N2 neighbor expansion raised recall to `0.346332`
but lowered QA to `0.278960`.

The selected default is 384-dimensional MiniLM, 1:1 semantic/BM25 RRF, the
existing candidate pool, Top-12, the current local reranker, and the official
evaluation flow. Rewriting, iterative search, user-message quotas, weighted
fusion, neighbors, and wider Top-K remain opt-in.

## Stable failure patterns

- Event ordering and temporal reasoning remain the weakest categories. Message
  sequence helps with ingestion order but cannot replace an explicit event date
  or timestamp.
- A parent message can be retrieved while the specific answer-bearing child
  span is absent from the final context.
- A wider candidate pool often adds similar but irrelevant messages and makes
  final selection harder.
- Contradiction questions require both sides of the conflict and a clear
  explanation of an explicit later correction. A single retrieved side can
  produce a zero even when parent-level recall looks acceptable.
- Provider rate limits, Answer model choice, and repeated inference introduce
  score variance. Paired provider and input identity are required for a fair
  comparison.
- `entitySearch` is still an optional host capability and is not wired by the
  current CLI service. It has not produced a measured gain in these runs.

## Code and evaluation work completed

- Preserve supplied timestamps and message sequence numbers in retrieval
  evidence.
- Correct the monotonic direction of BM25 relevance conversion.
- Preserve partial vector results when the scan budget is exhausted.
- Preserve distinct matched spans when semantic and keyword hits share a
  parent.
- Separate reranker hit text from answer context and record truncation/source
  provenance.
- Add explicit configuration for weighted RRF, session neighbors, candidate
  pool size, and final Top-K.
- Record per-question retrieval, reranking, evidence, timing, retry, and
  checkpoint state in AML-local.
- Add bounded retry, rate-limit backoff, failed-question ledgers, and resume.
- Increase the local adapter upstream health timeout from 5 seconds to a
  default of 15 seconds so model warm-up is not reported as service failure.

Scoped tests, package type checks, and package builds passed. The core daemon
and AML adapter both returned HTTP 200 during final verification. No online AML
submission was made.

## Final branch and next work

The current branch is `opt/beam10m-baseline-readiness`. It keeps the selected
baseline policy as the default and retains the experimental switches for
separate follow-up work. The branch has not been pushed.

The next priority is candidate generation and answer-span visibility for event,
multi-session, contradiction, and temporal questions. Simply increasing Top-K,
changing the embedding, or adding neighbors has not passed the end-to-end
acceptance gate.

## Reports and raw artifacts

- [Retrieval architecture ablation](10m-aml-local-retrieval-ablation-final-20261007.md)
- [Iterative retrieval and evidence chain](10m-aml-local-iterative-recall-final-20261004.md)
- [Query rewriting](10m-aml-local-query-rewrite-final-20261003.md)
- [DeepSeek Flash / Qwen Flash evaluation](10m-aml-local-deepseek-answer-qwen-flash-judge-20260929.md)
- [Qwen3-14B / Qwen Flash evaluation](10m-aml-local-qwen14b-answer-qwen-flash-judge-20260929.md)

Raw outputs remain under `benchmark/aml-local/outputs-*` and include inputs,
retrieval traces, answers, judgements, request ledgers, status files, and timing
summaries. Historical interrupted or incomparable runs remain preserved in
their original directories and are excluded from the final score tables above.
