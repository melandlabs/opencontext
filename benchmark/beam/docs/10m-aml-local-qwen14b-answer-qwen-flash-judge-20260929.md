# BEAM 10M local evaluation: Qwen3-14B answers, Qwen Flash Judge

Date: 2026-09-29. Status: completed local diagnostic re-evaluation, not a hosted AML leaderboard score.

## Scope and configuration

This run applies the `qwen/qwen3.8-flash` Judge to 200 previously saved `qwen/qwen3-14b` answers. It reuses the same AML-local BEAM 10M input and Top-12 retrieval evidence. No new ingestion, search, reranking, or answer generation was performed during this re-evaluation.

| Stage | Recorded value |
|---|---|
| Dataset | BEAM 10M; 10 conversations, 200 questions |
| Retrieval | Saved Top-12 evidence; 48 fused candidates per trace |
| Reranker in saved traces | Local `Xenova/ms-marco-MiniLM-L-6-v2`, enabled in all 200 searches |
| Saved Answerer | `qwen/qwen3-14b` |
| New rubric and event Judge | `qwen/qwen3.8-flash` via OpenRouter automatic routing |
| Judge reasoning | Disabled; all 2,103 successful Judge responses report zero reasoning tokens |
| Initial Judge output budgets | 1,024 tokens for rubric scoring; 8 for event equivalence |

The judge configuration records at most three attempts per model request, a 120-second attempt timeout, and an 8,192-token recovery ceiling. Truncated responses can receive a larger budget on retry. The 2,103 successful model responses reflect the BEAM event matcher's repeated event-pair checks as well as rubric judgements; they are not 2,103 questions or unbounded retries. Forty-four request attempts failed transiently and were retried or recovered without leaving a missing final judgement.

The reused input SHA-256 is `0c7ca8cc0244b982452c2b05f0ba78a26b5dd266e444434981b8f37ccc8d47fb`. Top-12 is a local setting that differs from the public Top-100 setting recorded in the saved retrieval manifest. The original retrieval/answer work used resumed local state. The present result should therefore be treated as a complete local diagnostic re-evaluation, not as an exact hosted AML run.

## Completion and score

Final status is `complete` at 2026-09-29 15:39:08 UTC. There are **200 distinct judged question IDs**, no pending questions, no missing answers, and no answer-hash mismatches. All 20 event-ordering questions have event metrics.

| Measure | Result |
|---|---:|
| Mean per-question rubric score | **0.3145** |
| Perfect-score questions | 49/200 |
| Partially scored questions | 40/200 |
| Zero-score questions | 111/200 |
| Mean event-ordering rubric score | 0.1713 |
| Mean event F1 | 0.1111 |
| Mean event-alignment score | 0.0245 |

The 0.3145 figure is the mean of per-question rubric scores, not a pass rate. Perfect-score questions account for 24.5% of the set. Event F1 and event alignment are separate metrics.

| Question category | Questions | Mean rubric score | Zero | Perfect | Mean annotated-source recall@12 |
|---|---:|---:|---:|---:|---:|
| Abstention | 20 | 0.5000 | 10 | 10 | N/A |
| Contradiction resolution | 20 | 0.0000 | 20 | 0 | 0.5221 |
| Event ordering | 20 | 0.1713 | 7 | 0 | 0.0124 |
| Information extraction | 20 | 0.6250 | 7 | 12 | 0.6500 |
| Instruction following | 20 | 0.2750 | 13 | 4 | 0.1250 |
| Knowledge update | 20 | 0.6750 | 6 | 13 | 0.6483 |
| Multi-session reasoning | 20 | 0.1800 | 15 | 3 | 0.3171 |
| Preference following | 20 | 0.4708 | 9 | 7 | 0.2833 |
| Summarization | 20 | 0.2225 | 5 | 0 | 0.0226 across 16 annotated questions |
| Temporal reasoning | 20 | 0.0250 | 19 | 0 | 0.2125 |

Source recall measures the share of annotated required source-turn IDs appearing in the final evidence. It does not establish that the answer-bearing text of a matched source was displayed. Twenty-four questions lack annotated source IDs and are excluded from recall calculations.

## Findings

### Evidence coverage constrains multi-event answers

The 176 questions with annotated sources have mean required-source recall@12 of **0.3169**. Eighty-six retrieve none of their annotated sources; 34 retrieve all of them. Event-ordering coverage is **0.0149 among all 48 fused candidates** and **0.0124 in final Top-12 evidence**, with 16 of 20 event questions missing every annotated source in the final evidence. Summarization has final source recall of 0.0226 across its 16 annotated questions.

For example, `10m_6_q_4` asks for seven dated musical ideas. None of its 18 annotated source turns appears in the final evidence. The answer lists seven ideas but scores 0.1429 on the rubric. `10m_2_q_5` asks for a deployment sequence, has zero coverage of 34 annotated source turns, and receives 0.0417. Both cases warrant inspecting candidate search and the displayed passages before changing the Answerer.

All 200 saved traces show the local reranker enabled, with 48 inputs and outputs. Among the 176 annotated questions, mean required-source coverage rises from **0.2534 in fused pre-rerank Top-12** to **0.3169 after reranking**. This is a paired ranking observation, not a separately measured effect on answer score. A reranker cannot recover relevant sources absent from its candidate pool.

### Correct rubric answers do not prove source support

`10m_1_q_7` answers `Milvus 2.3.1` and receives full rubric credit, yet its annotated source turn is absent from the final evidence. The retrieved text also contains near matches about other Milvus versions and document counts. The answer may be correct by chance, inference, or information elsewhere in the context; this trace does not prove that the specified answer-bearing source was retrieved.

### Contradiction and temporal failures need case-level evidence checks

All 20 contradiction-resolution questions receive zero with this Judge. Mean source-turn recall is 0.5221, but a partially retrieved set can omit the opposing statement. `10m_5_q_2` retrieves one of three annotated source turns and answers only `No.`. The rubric requires explaining two conflicting statements and asking which is correct, so the zero score is supported by the answer text. Inspect both the missing source and how the Answerer uses visible conflicts.

Temporal reasoning receives zero on 19 of 20 questions, with mean source recall of 0.2125. Message sequence records ingestion order and can be a secondary clue about conversation order; it does not establish event dates or elapsed time without supporting text or timestamps.

## Recommended work

1. Measure required-source coverage separately for keyword, semantic, fused candidate-48, and final Top-12 evidence on event, summary, and cross-session questions. Inspect the actual answer-bearing child spans. Test bounded query decomposition or date/topic-aware candidate collection without consulting benchmark gold sources at runtime.
2. Preserve distinct dated events and both sides of an apparent contradiction during evidence selection. Check whether repeated topical advice crowds out the specific historical statements needed to answer.
3. Review answer failures with the displayed evidence in hand. Distinguish missing evidence, conflicting evidence, unsupported details, and evidence present but misread before changing the model or prompt.
4. For future comparisons, freeze code, provider route, reasoning settings, retrieval configuration, and dataset, then run a complete isolated evaluation. Keep any local Top-12 experiment distinguishable from the public Top-100 setting.

## Local artifacts

- [Saved answer input](../../aml-local/outputs-beam10m-top12-resume-20260928/beam/input.jsonl), [answers](../../aml-local/outputs-beam10m-top12-resume-20260928/beam/answers.jsonl), and [retrieval traces](../../aml-local/outputs-beam10m-top12-resume-20260928/beam/retrieval-traces.jsonl)
- [New judgements](../../aml-local/outputs-beam10m-oldanswers-flashjudge-20260929/beam/judged.jsonl), [judge configuration](../../aml-local/outputs-beam10m-oldanswers-flashjudge-20260929/beam/judged-config.json), and [final status](../../aml-local/outputs-beam10m-oldanswers-flashjudge-20260929/beam/judged-status.json)
- [Companion report for DeepSeek answers under the same Flash Judge](10m-aml-local-deepseek-answer-qwen-flash-judge-20260929.md)

These raw output directories are locally ignored. Preserve or export the artifacts separately if the report is shared; links to them will not resolve in a checkout without the run data.
