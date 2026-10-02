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

## Optimization priorities

1. Improve **answer-bearing source coverage** before adding more query rewrites. The candidate stage has relevant turns that are lost during fusion and Top-12 selection; use stage-level traces and matched spans to improve candidate ranking without hardcoding benchmark answers.
2. Treat event ordering and broad summarization as **coverage-limited tasks**. Event-ordering questions require a mean of 38 annotated turns; 19/20 require more than Top-12 can hold if each turn needs its own hit. A separate Top-K/context-budget ablation is needed before claiming these categories can be solved under the current cap.
3. Investigate answerer interpretation on full-source failures, especially contradiction resolution and temporal reasoning, while keeping official answer/judge prompts unchanged. Distinguish missing exact spans, conflicting historical facts, and rubric ambiguity from model failure.
4. Compare with the independently pinned iterative-union run before selecting a default reasoning strategy. Query rewrite's measured gain here is small and does not justify an unconditional extra LLM call.

No code or benchmark artifacts from this run were pushed.
