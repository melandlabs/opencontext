# BEAM 10M: Query Rewrite, Pinned-Provider Local Evaluation

## Scope and reproducibility

This is a **complete local** BEAM run, not an AML platform submission. The public BEAM answer and judge prompts, rubric parser, event-alignment algorithm, and metric were left unchanged. The local adapter used Top-12 rather than the public flow's Top-100; scores should not be presented as an official leaderboard result. The run reused 39,920 previously committed Add batches in the same 10M SQLite database; it did not independently rebuild the ingestion corpus.

| Setting | Value |
| --- | --- |
| Branch / frozen commit | `experiment/beam10m-query-rewrite` / `753c13d` |
| Dataset | `beam_10m.json`, 200 questions |
| Retrieval | Query rewrite, local MiniLM-L6-v2 embeddings, SQLite semantic + FTS5 BM25, RRF, local ms-marco-MiniLM-L-6-v2 reranker, Top-12 |
| Retrieval planner and answerer | `deepseek/deepseek-v4-flash-0731`, OpenInference, reasoning disabled |
| Judge, including event alignment | `qwen/qwen3.8-flash`, Alibaba, reasoning disabled |
| Artifacts | `benchmark/aml-local/outputs-beam10m-pinned-rewrite-20261002/beam/` |

Coverage is 200/200 retrieval traces, 200/200 answers, and 200/200 judgements, with no skipped questions. All 200 successful answer requests reported OpenInference. All 1,346 successful judge subrequests reported Alibaba; 58 failed attempts were recovered without changing provider. The reranker was enabled in all 200 retrieval traces. Query rewriting reported degradation on four traces.

The retrieval state records dataset SHA256 `f80b3ca1236c6933300cd89cc65f1062535b18ca86c733eb34a73309e8439978`. Provider fallback was disabled for the planner, answerer, rubric judge, and event-alignment judge. The public answer/judge prompts were not edited to obtain these scores.

## Core repairs and validation

The shared core was repaired before this comparison: FTS5's ascending negative rank is converted to a monotonically correct relevance score; exhausted vector widening retains partial matches and falls back to an exact search within the requested user's scope; parent deduplication and RRF fusion retain distinct matched child excerpts instead of only combining scores. Regression tests cover real FTS5 through parent deduplication and RRF, overlapping/distant source windows, and exhausted vector scans. A later test strengthens the vector case by putting the owned result behind every foreign-user vector within the widening budget. A subsequent regression also exposed aliasing of a source-chunk-ID array during evidence fusion; copying that array now prevents mutation of the original channel hits. This later repair concerns trace attribution, not a demonstrated QA-score gain in the frozen run.

The known 512-token **reranker input** truncation issue remains deferred, as requested. It was not silently treated as fixed.

The 200 successful answer API responses reported a mean of **8,382.34 input tokens**, median 8,481, nearest-rank P95 12,527, and maximum 13,408. These are provider-reported model-native counts for the complete answer prompt, not estimates from the 400-token chunk setting. Mean answer output was 67.865 tokens, maximum 417; all 200 finished with `stop`, at the official initial 512-token output budget, with zero reported reasoning tokens. These records do not show answer-output budget exhaustion; they do not establish the absence of every possible server-side input transformation.

## Outcome

The mean BEAM judge score was **0.2462** over all 200 questions. Query rewrite did not provide a meaningful retrieval lift against the fixed-code, same-database Top-12 baseline: annotated source-turn recall moved from **0.3374 to 0.3423** (+0.0049), with five questions improved, one worsened, and 170 unchanged. The baseline comparison is retrieval-only, not a paired answer-score comparison.

| Category | Questions | Mean judge score | Mean annotated source recall@12 |
| --- | ---: | ---: | ---: |
| Information extraction | 20 | 0.55 | 0.70 |
| Knowledge update | 20 | 0.50 | 0.69 |
| Abstention | 20 | 0.45 | N/A |
| Preference following | 20 | 0.44 | 0.30 |
| Instruction following | 20 | 0.31 | 0.12 |
| Multi-session reasoning | 20 | 0.07 | 0.34 |
| Event ordering | 20 | 0.06 | 0.01 |
| Contradiction resolution | 20 | 0.04 | 0.59 |
| Temporal reasoning | 20 | 0.03 | 0.23 |
| Summarization | 20 | 0.01 | 0.04 |

The reported source metric uses annotated source-turn IDs. It establishes that a parent turn was retrieved, **not** that the answer-bearing child span was visible or used correctly by the answerer.

## Evidence chain

Among 176 questions with source-turn annotations, all required source turns were present in the indexed dataset. Mean required-source recall changed as follows:

| Stage | Mean recall | Questions with any required source | Questions with all required sources |
| --- | ---: | ---: | ---: |
| Available in indexed corpus | 1.0000 | 176 | 176 |
| Candidate channels combined | 0.5017 | 133 | 63 |
| Fused, before reranking | 0.4010 | 110 | 46 |
| Final Top-12 | 0.3423 | 99 | 36 |

At least one required source disappeared entirely for 23 questions during candidate fusion and for another 11 during the final rerank/truncation step. These losses deserve inspection, but **disabling the reranker is not supported by the aggregate ablation**: at the same Top-12 budget, fused-before-rerank recall was 0.2822 and final-after-rerank recall was 0.3423. Keyword-only and semantic-only candidate orderings gave 0.2258 and 0.2637 respectively at Top-12. BM25 and semantic channels were wired; the CLI's optional entity-search provider was not wired, so entity candidates were zero. No insight or knowledge corpus was created for this raw-chat run.

The final results contained 738 hits with multiple matched spans, demonstrating that multi-span evidence was carried through the repaired path. The exact answer-bearing span still needs case-level inspection; this count alone is not proof that every answer was visible.

Source coverage is a strong but incomplete predictor of score. The 36 questions with all annotated source turns in Top-12 averaged 0.55, but 13 of those still scored zero. The 77 questions with no annotated source in Top-12 averaged 0.15; 59 scored zero. Thus both retrieval loss and answer/interpretation failure matter.

## Case-level cautions

The following are **apparent question/rubric ambiguities**, not evidence that the system should be tuned to repeat the rubric's number:

- `10m_2_q_7` asks how many points were simulated while mocking sensor APIs with `unittest.mock`. A retrieved user message explicitly says **10,000 Lidar points**, and the answerer said 10,000. The rubric requires **5,000**, drawn from another message about mocked sensor inputs and coverage. Those are not obviously the same event.
- `10m_2_q_10` asks what capacity the log tool *supports* without downtime. A retrieved message says it supports **1,000 events/minute** and proposes increasing to **1,200**; another zero-downtime log-tool message also says **1,000**. The answerer said 1,000, while the rubric requires 1,200.
- `10m_1_q_3` has both annotated source turns in the final context, but the answer was only “Yes” and received zero. The rubric expects a detailed contradiction and clarification. Its cited statements (“always include exact error messages” and “never logged errors”) are also not logically contradictory by themselves. This is a mixture of insufficient answer explanation and questionable rubric framing.

These are examples, not a quantified dataset error rate. The official judge output is reported unchanged.

Two failures also have **directly visible answer-bearing text**, without relying only on source IDs:

- `10m_9_q_6`: the first returned user excerpt explicitly says a **50-page album for $75**, but the answer discusses selecting photos for an album with eight pages to fill. It addresses a historical question rather than the evaluation question.
- `10m_9_q_13`: returned user excerpts at ranks 1 and 5 explicitly allocate **1.5 hours** to the first island and **2 hours** to the second. The answer says the combined duration is unspecified, despite these visible inputs supporting 3.5 hours.

These cases establish an answerer/question-following problem in addition to retrieval loss. They do not prove that every full-source zero-score case has adequate answer-bearing context.

## Optimization priorities

A read-only lexical ablation covered all 200 questions on the unchanged database. It removed common English function words and deduplicated keywords **before** the existing 16-keyword cap; 115 questions exceeded that cap under the original tokenizer. Original FTS5 candidate order was reconstructed, including a replay to correct the analysis tokenizer's treatment of `x_n`. Exact source mappings came from the existing BEAM adapter helper, not guessed message sequence values.

Across 176 annotated questions, mean BM25 **candidate recall@48** moved from **0.3165 to 0.3357** (+0.0192): 21 improved, 10 worsened, and 145 were unchanged. This is not a reranked Top-12 or QA-score gain. The small lift and regressions do not justify enabling this normalization globally without a final-ranking and answer-score ablation. The combined stopword-filtering prototype was not enabled in production. A later minimal deduplication-only core change is evaluated separately in the iterative final report. Detailed results are in the ignored local artifact `benchmark/aml-local/outputs-beam10m-keyword-ablation-20261003/beam/analysis.json`.

1. Improve **answer-bearing source coverage** before adding more query rewrites. The candidate stage has relevant turns that are lost during fusion and Top-12 selection; use stage-level traces and matched spans to improve candidate ranking without hardcoding benchmark answers.
2. Treat event ordering and broad summarization as **coverage-limited tasks**. Event-ordering questions require a mean of 38 annotated turns; 19/20 require more than Top-12 can hold if each turn needs its own hit. A separate Top-K/context-budget ablation is needed before claiming these categories can be solved under the current cap.
3. Investigate answerer interpretation on full-source failures, especially contradiction resolution and temporal reasoning, while keeping official answer/judge prompts unchanged. Distinguish missing exact spans, conflicting historical facts, and rubric ambiguity from model failure.
4. Compare the independently pinned iterative-union result before selecting a default reasoning strategy. Query rewrite's measured gain here is small and does not justify an unconditional extra LLM call. The complete union run subsequently scored 0.2844 versus 0.2462 here; most of the difference came from abstention, not a substantial annotated-source recall lift. See the iterative final report for the matched comparison and core ablations.

## Optional modules and bounded follow-up experiments

Query rewrite and iterative recall are existing optional core modules, now supplied with the pinned Flash completion callback by the CLI. Iterative union retains the original-query semantic and BM25 channels and adds planner evidence; internal planner searches also fuse the two channels by RRF rather than comparing raw BM25 and cosine scores.

The CLI still does not implement `entitySearch`. That is an optional host dependency, not an environment toggle that can activate an already-populated entity index. Insights and knowledge search have selectable CLI backends, but this run's AML Add path ingests raw messages only, and Search requests the memory source. Merely enabling those backends would not create extracted facts or an evidence-linked knowledge corpus. They are not claimed as tested improvements here. Lifecycle/dreaming work remains outside this experiment.

Two follow-up diagnostics use the same preselected 20 question IDs (two per category, selected by the lowest SHA256 of question IDs), the unchanged database, the same models/providers, and unmodified official prompts. Both completed all 20 answers and judgements on 2026-10-04 after resuming the previously rate-limited questions. Existing answers were preserved; failed questions were not scored zero:

- Lossless quoting of historical excerpts kept retrieval fixed. The mean score was **0.0750**, versus **0.2600** for the same 20 original answers: zero improvements, five regressions, and fifteen unchanged. The regression on `10m_4_q_8` was 1.0 to 0.0. All 20 successful answer requests reported OpenInference and all 50 successful judge subrequests reported Alibaba, with zero provider mismatches. This presentation prototype is not enabled in production.
- A structured-chat iterative-union diagnostic preserves real system/user/assistant roles instead of flattening the planner's history into one user message. All 20 retrievals, answers, and judgements completed; all 20 successful answer responses reported DeepSeek Flash/OpenInference and all 50 successful judge subrequests reported Qwen Flash/Alibaba, with zero provider mismatches. Its mean score was **0.2500**; the 18 source-annotated questions had mean source recall **0.3750**, and 12 planner traces were degraded. The isolated real-CLI protocol check completed search -> note -> finish using OpenInference with zero reasoning tokens; this establishes correct transport, not a full-run score gain. Comparing 0.2500 with the rewrite subset's 0.2600 changes both retrieval strategy and planner transport, so it does not isolate the chat-role fix. The completed matched flat-history union subset scored **0.2250**: two scores improved, one worsened and seventeen were unchanged. This small diagnostic does not establish a full-run improvement.

Top-12 also imposes a mean annotated-source recall ceiling of 0.4314 on the 20 event-ordering questions, even with an ideal ranking: 19 questions require more than twelve distinct source turns. This is a ceiling for the source-ID metric, not proof that a smaller number of retrieved messages can never contain a useful timeline summary. Neither 20-question diagnostic score is substituted for a complete 200-question result. A score above 0.5 has not been demonstrated under this run's constraints.

The full iterative-union comparison and the completed wider-window, lexical-deduplication and planner-budget core ablations are documented in [the iterative final report](10m-aml-local-iterative-recall-final-20261004.md). The wider rerank window and default planner-budget hints were withdrawn after regressions; the apparent lexical-deduplication score gain came entirely from unchanged contexts and is not attributed to the core change. No default score improvement above the complete frozen runs is claimed.

No code or benchmark artifacts from this run were pushed.
