# BEAM 10M V2 Local-Retrieval Evaluation Report

- Report version: v2
- Status: completed with 5 final Answerer execution errors; diagnostic run, not a formal public baseline
- Dataset scale: BEAM `10m`
- Manifest window: 2026-09-05T10:05:09.952Z to 2026-09-05T14:06:25.178Z
- Result: [beam-10m-top12-local-reranker-nograph-20260905-145000.json](../results/beam-10m-top12-local-reranker-nograph-20260905-145000.json)
- Run manifest: [beam-10m-top12-local-reranker-nograph-20260905-145000.json.manifest.json](../results/beam-10m-top12-local-reranker-nograph-20260905-145000.json.manifest.json)
- End-to-end trace: [beam-10m-top12-local-reranker-nograph-20260905-145000.trace.jsonl](../results/beam-10m-top12-local-reranker-nograph-20260905-145000.trace.jsonl)
- Ingest records: [beam-10m-top12-local-reranker-nograph-20260905-145000.chunks.jsonl](../results/beam-10m-top12-local-reranker-nograph-20260905-145000.chunks.jsonl)

> `results/`, checkpoints, model caches, and database files are excluded by `.gitignore` by default. This report is the committable summary; retain the linked raw artifacts separately for response, source, trace-level, and error audit. It deliberately does not duplicate the 200 questions as a documentation index.

## 1. Purpose and scope

This report records the first completed 10M BEAM artifact in this workspace. It evaluates OpenContext end to end: upstream turns are ingested into the isolated SQLite-backed daemon, Top-12 evidence is supplied to an Answerer LLM, and an LLM judge scores official BEAM nugget atoms.

The score is therefore not a pure retrieval metric and not a hosted leaderboard result. It combines retrieval, evidence construction, Answerer behavior, provider reliability, and judging. There is no matched 10M v1 result here, so this report does not make a v2-versus-v1 improvement claim or compare the score directly to the 128K and 500K runs.

## 2. System and evaluation configuration

| Item | Configuration |
|---|---|
| Dataset | `dataset/beam_10m.json` |
| Dataset size | 497,484,718 bytes |
| Dataset SHA-256 | `f80b3ca1236c6933300cd89cc65f1062535b18ca86c733eb34a73309e8439978` |
| Upstream dataset | `Mohammadta/BEAM-10M`, config `default`, split `10M` |
| Upstream revision | `9b2096193fe74e2837e4713e483351e19817773c` |
| Conversations / questions | 10 / 200; 20 per category |
| Answerer | `openrouter:deepseek/deepseek-v4-flash-0731` |
| Judge | `openrouter:qwen/qwen3.7-flash` |
| Backend | isolated `sqlite-vec` daemon with SQLite FTS5 available to the store |
| Embedding | `Xenova/all-MiniLM-L6-v2`, local, 384 dimensions |
| Parent record | one complete upstream turn per `RawMessage` |
| Final retrieval | daemon-default Top-12 |
| Graph retrieval | disabled (`nograph`) |
| Trace schema | `1.3` |
| Manifest commit | `1b8ed9cab7f7c172b1c02cad198ee4a7abad8af6` |

The manifest records `resume: true`. Resume reused completed judged answers and retried execution-error checkpoints. During monitoring, an initial checkpoint-only stall rule incorrectly restarted the benchmark while the sixth conversation was still actively writing SQLite/WAL data. The replacement used the same isolated database and checkpoint directory, retained all prior checkpoints, and completed the run. The monitoring rule was corrected to use the newest checkpoint **or** SQLite/WAL write as progress evidence.

This makes the run complete, but not a clean fresh-database `--no-resume` baseline. A formal comparison must use a fresh database, `--no-resume`, and a recorded clean revision or patch identity.

## 3. Ingestion and evidence artifacts

The completed chunk artifact contains 208,696 upstream-turn ingest records, one per source turn across the ten 10M conversations. The trace contains exactly 200 records, matching the scheduled question count. The database, result, trace, and ingest artifacts remain available for independent audit.

Unlike the 128K/500K v2 reports, this trace does **not** contain pre-merge candidate diagnostics or separate semantic, lexical, hybrid, and reranker channels. The result's diagnostic summary reports zero questions with those channels available. Consequently, the run name contains `local-reranker`, but this artifact does not independently prove that local reranking or candidate fusion ran on every question. It must not be cited as a validated reranker-quality measurement.

## 4. Execution completeness and token usage

| Metric | Result |
|---|---:|
| Questions scheduled / predictions persisted | 200 / 200 |
| Completed Answerer + Judge records | 195 / 200 |
| Final execution errors | 5 / 200 (2.50%) |
| First-attempt records | 195 |
| Second-attempt records | 5 |
| Recorded prompt tokens on completed records | 1,849,143 |
| Recorded completion tokens on completed records | 680,762 |
| Recorded total tokens on completed records | 2,529,905 |
| Mean total tokens per completed record | 12,974 |
| Manifest wall-clock | 14,475,226 ms (about 4h 01m) |

The five final errors are `answerer_error` execution records, not judged retrieval outcomes. Their nugget contribution is zero in the all-record view. Failed provider attempts can have unrecorded token usage, so the recorded total is not a billing total.

## 5. Overall result

The all-record view is the completeness-aware run score. The success-only view is included to distinguish judged behavior from provider failures; it must not replace the all-record score in comparisons.

| Metric | All 200 scheduled records | Successful 195 records |
|---|---:|---:|
| Nugget Mean | 0.3685 | 0.3780 |
| Nugget Pass Count | 80 / 200 | 80 / 195 |
| Nugget Pass Rate | 40.00% | 41.03% |
| Abstentions | 43 | 43 |

## 6. Results by category

| Category | Pass rate | Nugget mean | Final execution errors |
|---|---:|---:|---:|
| abstention | 12 / 20 (60.00%) | 0.6000 | 0 |
| contradiction_resolution | 14 / 20 (70.00%) | 0.5313 | 0 |
| event_ordering | 0 / 20 (0.00%) | 0.0734 | 0 |
| information_extraction | 13 / 20 (65.00%) | 0.6500 | 0 |
| instruction_following | 11 / 20 (55.00%) | 0.5000 | 0 |
| knowledge_update | 13 / 20 (65.00%) | 0.5750 | 0 |
| multi_session_reasoning | 4 / 20 (20.00%) | 0.1592 | 0 |
| preference_following | 9 / 20 (45.00%) | 0.3625 | 0 |
| summarization | 4 / 20 (20.00%) | 0.2338 | 0 |
| temporal_reasoning | 0 / 20 (0.00%) | 0.0000 | 5 |

Contradiction resolution is the strongest category by pass rate. Event ordering and temporal reasoning have no passing records. Temporal reasoning also contains all five execution errors, but event ordering's zero pass rate cannot be explained by provider errors alone.

## 7. Retrieval evidence and its limits

The final retrieval trace covers 176 questions with applicable upstream source IDs:

| Metric | Result |
|---|---:|
| Retrieval-applicable questions | 176 |
| Dataset source coverage | 1.0000 |
| Final source recall@12 | 0.2354 |
| Hit@12 | 0.3693 |
| All required sources retrieved | 0.1534 |
| Precision@12 | 0.0507 |
| MRR | 0.2236 |

The values above are final-hit diagnostics. They establish that retrieval coverage is low for this 10M artifact, especially for questions needing several distributed turns. They do not establish a reranker regression or identify a single causal component, because candidate-channel and pre/post-rerank traces are absent.

## 8. Failure analysis

| Failure stage | Count |
|---|---:|
| `none` | 80 |
| `context_present_answer_failed` | 11 |
| `retrieval_miss` | 84 |
| `retrieval_partial` | 18 |
| `answerer_error` | 5 |
| `dataset_reference_missing` | 2 |

Of the 120 all-record non-passes, 102 are labelled retrieval miss or partial retrieval, 11 had required evidence represented in the returned context but still failed to answer, 5 are Answerer execution errors, and 2 are dataset-reference gaps. These labels support prioritizing evidence coverage, but this remains an end-to-end diagnostic: they do not prove that retrieval alone caused every non-pass.

## 9. Per-question evidence

The result JSON is the authority for all 200 questions: it retains official gold answers, nugget atoms, source references, Answerer responses, judge reasoning, status, attempts, and token usage. The trace provides final retrieved evidence and retrieval diagnostics, while the ingest artifact records all 208,696 source turns. No separate question index is needed.

## 10. Interpretation and next work

This is a complete 10M end-to-end diagnostic artifact, but not an error-free or clean-baseline result. It proves that all scheduled questions reached a persisted terminal record and that raw result, trace, ingest, and manifest evidence are available. It does not prove that the run's `local-reranker` label reflects a trace-verified reranking path.

The next work should be narrow and evidence-driven:

1. Restore and verify pre-merge, candidate-channel, and reranker diagnostics before claiming local reranking at 10M.
2. Improve multi-evidence coverage selection for event ordering, temporal reasoning, multi-session reasoning, and summarization; final Top-12 recall is only 0.2354 and all-required-source rate is 0.1534.
3. Investigate the five Answerer errors separately from retrieval quality; retry only those errors in a controlled run without rewriting already judged records.
4. Run a fresh-database, `--no-resume` 10M baseline with clean-revision/patch identity before comparing this 40.00% all-record pass rate with another scale or system version.
