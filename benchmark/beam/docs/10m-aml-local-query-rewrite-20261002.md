# BEAM 10M local experiment: query rewrite

Date: 2026-10-02. Status: complete local diagnostic run, not a hosted AML score.

## Setup and validity

This experiment used the public BEAM question set (200 questions across 10 conversations), a previously populated local SQLite database, and final Top-12 evidence. The comparison baseline used the same fixed-code retrieval setup without query rewrite. The database was reused; this was not an independent fresh-ingest or hosted evaluation. The baseline has retrieval output only, so answer-score differences cannot be attributed to query rewrite.

| Component | Configuration |
|---|---|
| Retrieval | Original-question semantic and BM25 search with query rewriting, RRF fusion, 48 candidates and Top-12 final hits |
| Reranker | Local `Xenova/ms-marco-MiniLM-L-6-v2` |
| Answerer | `deepseek/deepseek-v4-flash-0731` via OpenRouter; provider reasoning disabled |
| Judge | `qwen/qwen3.8-flash` via OpenRouter; provider reasoning disabled |
| BEAM prompts and scoring | Vendored public BEAM answer, rubric, event-alignment and scoring implementation |
| Recovery policy | Local bounded retries and checkpoints; completed after resuming a provider-rate-limit interruption |

The final artifacts contain 200 distinct retrieval traces, answers and judgements with no missing IDs. All 200 traces have nonempty semantic and lexical candidates, 48 reranker inputs and outputs, and 12 final hits. The final judge status is `complete`, with 200/200 successes and no failures in the completing run. Two retrieval traces report degraded query rewriting; the ordinary retrieval path remained available. The output records 739 final hits with multiple matched spans.

OpenRouter auto-routed 183 of the 200 successful DeepSeek answer requests to OpenInference and the other 17 across eight providers. All 1,090 successful Qwen Judge subrequests report Alibaba as provider, with zero reported reasoning tokens; nine earlier Judge requests received HTTP 429 before recovery. The answer provider was not pinned, which matters when comparing this run with another retrieval strategy.

Top-12 is a deliberate local choice; it is not the public AML Top-100 setting. The run reused a database and was recovered across process/provider interruptions. These details limit formal comparability, even though the final artifacts are complete.

## Retrieval result

Required-source recall is the fraction of annotated source-turn IDs present in the final Top-12 evidence. It does not prove the answer-bearing text within a matched parent message was visible to the answerer. Twenty-four questions have no annotated source IDs and are excluded.

| Measure | Query rewrite | Fixed-code baseline |
|---|---:|---:|
| Annotated questions | 176 | 176 |
| Mean required-source recall@12 | 0.3390 | 0.3374 |
| Paired mean difference | +0.0016 | Reference |
| Paired questions improved / worsened / unchanged | 4 / 2 / 170 | Reference |
| Questions with zero annotated-source recall | 81 | Not used for this comparison |
| Questions with full annotated-source recall | 36 | Not used for this comparison |

The rewrite changed source recall on only six annotated questions. The largest observed improvement was `10m_7_q_14` (preference following, 0 to 1/3); the largest regression was `10m_7_q_17` (summarization, 1/4 to 0). Event ordering improved on one question and worsened on one; their combined category-mean change was only +0.00125. The measured gain is too small to establish query rewriting as a useful BEAM 10M optimization.

## Answer and judge result

The complete 200-question mean rubric score was **0.2521** (not a pass rate): 44 perfect scores, 17 partial scores and 139 zero scores. The event-ordering mean rubric score was 0.1231; mean event F1 was 0.0583 and mean final event-alignment score was 0.0159. Event alignment is a separate metric from the rubric score.

| Question category | Mean rubric score | Mean annotated-source recall@12 |
|---|---:|---:|
| Abstention | 0.5500 | N/A |
| Contradiction resolution | 0.0250 | 0.5888 |
| Event ordering | 0.1231 | 0.0136 |
| Information extraction | 0.5500 | 0.7000 |
| Instruction following | 0.2125 | 0.1250 |
| Knowledge update | 0.5000 | 0.6858 |
| Multi-session reasoning | 0.1000 | 0.3383 |
| Preference following | 0.4125 | 0.2750 |
| Summarization | 0.0356 | 0.0238 across 16 annotated questions |
| Temporal reasoning | 0.0125 | 0.2379 |

The historical local score of 0.2693 used different saved retrieval evidence and recovery state; this experiment does not isolate a causal score change against that run. The fixed-code baseline has no answers or judgements. Retrieval and answer scores should therefore be compared only at their supported evidence level.

One bounded example shows why source recall and answer quality must be separated. For `10m_7_q_2` (the old couch in storage), all three annotated source-turn IDs are in the final evidence. The actual 12-item answer context contains both “I'm thinking of moving my old couch to storage” and “I've never moved my old couch to storage.” Nevertheless, the answer says the context contains no relevant information, and the Judge assigns zero. This is an observed answer-use failure in that question, not evidence that every contradiction failure has the same cause.

## Interpretation and next checks

1. Query rewriting barely moved final source coverage. Keep it experimental rather than treating it as a default improvement on this evidence.
2. Event ordering and summarization still lack most annotated sources in final evidence. Check source coverage at keyword, semantic, fused-candidate and final-reranked stages, and inspect whether the exact answer-bearing child spans are displayed. A parent-turn match alone is insufficient.
3. Contradiction resolution has much higher parent-source recall than rubric score. Review a bounded sample for missing opposing statements, incorrect conflict resolution, or answerer errors before changing prompts or models.
4. Compare this result with the separate iterative-plus-baseline union run on the same dataset and model configuration. A formal confirmation would require a frozen code/configuration and a fresh isolated database, not a resumed local run.

## Local artifacts

- [Retrieval traces](../../aml-local/outputs-beam10m-rewrite-20261001/beam/retrieval-traces.jsonl), [answers](../../aml-local/outputs-beam10m-rewrite-20261001/beam/answers.jsonl), and [judgements](../../aml-local/outputs-beam10m-rewrite-20261001/beam/judged.jsonl)
- [Run configuration](../../aml-local/outputs-beam10m-rewrite-20261001/beam/run-config.json), [answer configuration](../../aml-local/outputs-beam10m-rewrite-20261001/beam/answers-config.json), [judge configuration](../../aml-local/outputs-beam10m-rewrite-20261001/beam/judged-config.json), and [final judge status](../../aml-local/outputs-beam10m-rewrite-20261001/beam/judged-status.json)
- [Fixed-code baseline traces](../../aml-local/outputs-beam10m-fixed-baseline-20261001/beam/retrieval-traces.jsonl)

Raw outputs are locally ignored and must be exported separately if this report is shared outside the run machine.
