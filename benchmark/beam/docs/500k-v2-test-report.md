# BEAM 500K V2 Local-Reranker Evaluation Report

- Report version: v2
- Status: completed with 11 final Answerer execution errors; diagnostic run, not a formal public baseline
- Dataset scale: BEAM `500k`
- Manifest window: 2026-09-04T02:55:00.619Z to 2026-09-04T06:06:43.280Z
- Result: [beam-500k-top12-local-reranker-nograph-20260903-235000.json](../results/beam-500k-top12-local-reranker-nograph-20260903-235000.json)
- Run manifest: [beam-500k-top12-local-reranker-nograph-20260903-235000.json.manifest.json](../results/beam-500k-top12-local-reranker-nograph-20260903-235000.json.manifest.json)
- End-to-end trace: [beam-500k-top12-local-reranker-nograph-20260903-235000.trace.jsonl](../results/beam-500k-top12-local-reranker-nograph-20260903-235000.trace.jsonl)
- Ingest records: [beam-500k-top12-local-reranker-nograph-20260903-235000.chunks.jsonl](../results/beam-500k-top12-local-reranker-nograph-20260903-235000.chunks.jsonl)

> `results/`, checkpoints, model caches, and database files are excluded by `.gitignore` by default. This report and the question index are committable documentation; retain the linked raw artifacts separately for score, response, source, and trace-level audit.

## 1. Purpose and scope

This report records the completed BEAM 500K run using OpenContext's bounded child retrieval, SQLite semantic and lexical candidate generation, RRF fusion, and a local reranker. It preserves the same report shape as the 128K v2 report while keeping the evidence boundaries explicit.

It measures end-to-end memory question answering: retrieved evidence is passed to an Answerer LLM and then scored by an LLM nugget judge. The score therefore reflects retrieval, evidence construction, Answerer behavior, and judging together; it is not a pure retrieval benchmark or a hosted leaderboard result.

There is no matched 500K v1 artifact in this workspace. This report does not infer an improvement over 128K or call the 500K score a regression, because the corpus scale, conversations, and question set differ.

## 2. System and evaluation configuration

| Item | Configuration |
|---|---|
| Dataset | `dataset/beam_500k.json` |
| Dataset size | 83,738,009 bytes |
| Dataset SHA-256 | `a7371969486594be4d38b0aac1c16557d038b6d169a74e1cefabdc9ad694effe` |
| Upstream dataset | `Mohammadta/BEAM`, config `default`, split `500K` |
| Upstream revision | `3205395e897e7318c7b094ef4e6047b9b82dbb03` |
| Conversations | 35 |
| Questions | 700; 70 per category |
| Answerer | `openrouter:deepseek/deepseek-v4-flash-0731` |
| Judge | `openrouter:qwen/qwen3.7-flash` |
| Backend | `sqlite-vec` dense retrieval plus SQLite FTS5 lexical retrieval |
| Embedding | `Xenova/all-MiniLM-L6-v2`, local, 384 dimensions |
| Parent record | One complete upstream turn per `RawMessage` |
| Search child | 400 estimated tokens, 80-token overlap |
| Merge | Reciprocal Rank Fusion (RRF) |
| Candidate window | 48 |
| Reranker | `Xenova/ms-marco-MiniLM-L-6-v2`, local quantized cross-encoder |
| Final retrieval | Top-12 |
| Graph retrieval | Disabled (`nograph`) |
| Trace schema | `1.3` |
| Manifest commit | `7151fd182c267775ab1e1e7b96036ed847c833b8` |

The manifest records `resume: true`. Resume avoids re-running completed judged answers, including incorrect answers, but the 11 remaining execution errors were not resolved. A fresh-database `--no-resume` run is required for a formal, directly comparable baseline.

## 3. Index construction

The ingestion artifact records 38,058 upstream-turn parent messages. The SQLite store generated independently searchable children for oversized parents while retaining complete parent text for response context.

| Index metric | Result |
|---|---:|
| Parent `RawMessage`s | 38,058 |
| Search children | 71,461 |
| Embedded children | 71,461 |
| Mean parent characters | 2,039 |
| Maximum parent characters | 246,463 |
| Mean child characters | 1,273 |
| Maximum child characters | 2,000 |
| Maximum children for one parent | 155 |
| Upstream-turn ingest records completed | 38,058 / 38,058 |

This separates search granularity from answer context: a matched child identifies a bounded relevant window, while the parent remains available to preserve the original turn context.

## 4. Execution completeness and token usage

| Metric | Result |
|---|---:|
| Questions scheduled | 700 |
| Completed Answerer + Judge records | 689 / 700 |
| Final execution errors | 11 / 700 (1.57%) |
| First-attempt completions | 682 |
| Second-attempt completions | 7 |
| Third-or-later completions | 0 |
| Recorded prompt tokens on completed records | 4,675,637 |
| Recorded completion tokens on completed records | 2,057,880 |
| Recorded total tokens on completed records | 6,733,517 |
| Mean total tokens per completed record | 9,773 |

The final errors are Answerer-stage provider/response-processing failures, including connection timeouts, aborted requests, and `Failed to process successful response`. They are not evidence of a retrieval failure. Provider attempts that failed before a completed checkpoint may have incurred additional billed usage; the final result does not contain their token totals.

## 5. Overall result

The official all-record view counts every scheduled question. Because the 11 execution-error records have no judged nugget result, their contribution is zero in that view. The success-only view is shown separately rather than silently discarding them.

| Metric | All 700 scheduled records | Successful 689 records |
|---|---:|---:|
| Nugget Mean | 0.5891 | 0.5985 |
| Nugget Pass Count | 446 / 700 | 446 / 689 |
| Nugget Pass Rate | 63.71% | 64.73% |
| Abstentions | 77 | 77 |

The all-record result is the appropriate completeness-aware run score. The success-only view describes scored Answerer/Judge behavior only; it must not replace the all-record result in comparisons.

## 6. Results by category

| Category | All-record pass rate | Successful-record pass rate | Final execution errors |
|---|---:|---:|---:|
| abstention | 55 / 70 (78.57%) | 55 / 70 (78.57%) | 0 |
| contradiction_resolution | 61 / 70 (87.14%) | 61 / 69 (88.41%) | 1 |
| event_ordering | 5 / 70 (7.14%) | 5 / 64 (7.81%) | 6 |
| information_extraction | 54 / 70 (77.14%) | 54 / 70 (77.14%) | 0 |
| instruction_following | 43 / 70 (61.43%) | 43 / 69 (62.32%) | 1 |
| knowledge_update | 49 / 70 (70.00%) | 49 / 70 (70.00%) | 0 |
| multi_session_reasoning | 42 / 70 (60.00%) | 42 / 70 (60.00%) | 0 |
| preference_following | 57 / 70 (81.43%) | 57 / 70 (81.43%) | 0 |
| summarization | 42 / 70 (60.00%) | 42 / 68 (61.76%) | 2 |
| temporal_reasoning | 38 / 70 (54.29%) | 38 / 69 (55.07%) | 1 |

Contradiction resolution is the strongest completed category. Event ordering is the weakest by a large margin even after excluding its six execution errors, so its low score cannot be explained by provider failures alone.

## 7. Retrieval and reranking evidence

The trace supplies retrieval diagnostics for all 700 scheduled questions. The following final-retrieval metrics cover the 629 questions with applicable upstream source IDs.

| Metric | Result |
|---|---:|
| Retrieval-applicable questions | 629 |
| Pre-merge diagnostics available | 700 / 700 |
| Questions with semantic candidates | 699 / 700 |
| Questions with lexical candidates | 700 / 700 |
| Semantic candidate source recall@48 | 0.6310 |
| Lexical candidate source recall@48 | 0.5187 |
| Final source recall@12 | 0.4939 |
| Hit@12 | 0.6518 |
| All Required Sources Retrieved | 0.3816 |
| Precision@12 | 0.0884 |
| MRR | 0.4499 |
| Dataset Source Coverage | 1.0000 |

The trace reports no separate `hybrid` candidate channel; semantic and lexical candidates are fused by the RRF path before reranking. One question had no semantic candidates, while lexical candidates were present for all 700 questions. That is an observable degradation case, not a reason to describe the retrieval path as uniformly healthy.

The local reranker was enabled for every scheduled question and changed the candidate order in every case:

| Reranker metric | Result |
|---|---:|
| Input / output candidate window | 48 / 48 |
| Final Top-K | 12 |
| Questions reranked | 700 / 700 |
| Questions with changed order | 700 / 700 |
| Mean latency | 2,867 ms/question |
| P50 latency | 2,861 ms/question |
| P95 latency | 3,104 ms/question |
| Maximum latency | 4,644 ms/question |

## 8. Failure analysis

| Failure stage | Count |
|---|---:|
| `none` | 446 |
| `context_present_answer_failed` | 61 |
| `retrieval_miss` | 127 |
| `retrieval_partial` | 55 |
| `answerer_error` | 11 |

Among the 254 all-record non-passes, 182 are classified as retrieval miss or partial retrieval, 61 had the required evidence represented in context but did not produce a passing answer, and 11 are execution errors. The diagnostics support prioritizing multi-evidence retrieval coverage, but they do not establish that every non-pass was caused solely by retrieval: Answerer and judge behavior remain part of this end-to-end measurement.

## 9. Per-question evidence

The raw result artifact preserves every scored question together with its official gold answer, nugget atoms, source references, Answerer response, Judge reasoning, status, and per-question token usage. The trace artifact adds candidate channels, RRF order, reranker output, and retrieved evidence. Those raw artifacts are the authority for individual-question analysis.

## 10. Interpretation and next work

This is a completed but not error-free 500K diagnostic run. Its strongest evidence is the traceable end-to-end coverage: every scheduled question has pre-merge diagnostics and local reranking, and retrieval-specific metrics exist for the 629 questions with upstream source IDs.

It is not a formal v2-versus-v1 claim. The manifest used resume semantics, records no clean-tree/dirty-patch identity, and leaves 11 execution errors. Do not compare its 63.71% all-record pass rate directly with 128K results or a leaderboard.

The next validated work should be narrow and evidence-driven:

1. Resolve or separately replay the 11 Answerer execution errors without selectively retrying already judged incorrect answers.
2. Improve multi-evidence recall and coverage selection for event ordering, where the successful-only pass rate remains 7.81%.
3. Add an evidence-sufficiency/abstention gate so weak Top-12 context does not encourage unsupported answers.
4. Run a fresh-database, `--no-resume` 500K comparison with recorded clean Git revision or patch identity before making a formal performance claim.
