# LoCoMo V2 OpenContext Evaluation Report

- Report version: v1
- Status: completed; 1,492 / 1,492 Answerer-and-Judge records persisted, with no final execution errors
- Dataset: `locomo_v2_minicpm.json` (LoCoMo V2 MiniCPM, 10 samples)
- Final recovery window: 2026-09-10T00:42:33.356Z to 2026-09-10T01:35:33.633Z
- Result: [locomo-v2-minicpm-dialog-20260909-r2-recovery3.json](../results/locomo-v2-minicpm-dialog-20260909-r2-recovery3.json)
- Run manifest: [locomo-v2-minicpm-dialog-20260909-r2-recovery3.json.manifest.json](../results/locomo-v2-minicpm-dialog-20260909-r2-recovery3.json.manifest.json)
- Question trace: [locomo-v2-minicpm-dialog-20260909-r2-recovery3.trace.jsonl](../results/locomo-v2-minicpm-dialog-20260909-r2-recovery3.trace.jsonl)
- Session-ingest trace: [locomo-v2-minicpm-dialog-20260909-r2-recovery3.sessions.jsonl](../results/locomo-v2-minicpm-dialog-20260909-r2-recovery3.sessions.jsonl)

> `results/`, checkpoints, runtime databases, and model caches are excluded by `.gitignore`. This report is the committable summary; retain the linked raw artifacts for response-, source-, and trace-level audit. It intentionally does not create a separate question index.

## 1. Purpose and scope

This report records the completed LoCoMo V2 MiniCPM OpenContext run. The harness maps every upstream conversation session to one `RawMessage` and submits it to the local OpenContext daemon. The daemon, rather than the evaluator, owns chunking, parent-child construction, embedding, indexing, semantic and lexical retrieval, fusion, reranking, and the final Top-12 returned by search. The evaluator supplies only that final returned context to the existing LoCoMo answer prompt, calls the Answerer, calls the Judge, and records the evidence trail.

The result is an end-to-end diagnostic, not a pure retrieval score: it includes daemon retrieval behavior, the final answer context, Answerer behavior, provider reliability, and judging. It is not an AML or official leaderboard LoCoMo score; this workspace uses its OpenContext harness, answer prompt, lexical metrics, and LLM judge.

## 2. System and evaluation configuration

| Item                   | Configuration                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Dataset                | `dataset/locomo_v2_minicpm.json`                                                     |
| Dataset size / SHA-256 | 3,198,216 bytes / `874685e3fd3ecefe0562637b948f8470b73e32fc72c02407a2797b09dce83959` |
| Dataset rows           | 10 samples; 1,922 raw QA rows; 1,492 answerable rows evaluated                       |
| Answerer               | `openrouter:deepseek/deepseek-v4-flash-0731`                                         |
| Judge                  | `openrouter:qwen/qwen3.7-flash`                                                      |
| Store                  | isolated local `sqlite-vec` daemon with lexical search available                     |
| Embedding              | local `Xenova/all-MiniLM-L6-v2`, 384 dimensions                                      |
| Reranker               | local `Xenova/ms-marco-MiniLM-L-6-v2`                                                |
| Parent record          | one complete upstream conversation session per `RawMessage`                          |
| Retrieval              | daemon-default final Top-12, `dialog` mode                                           |
| Trace schema           | `1.0`                                                                                |
| Manifest commit        | `2f2df851a02849bc1f295fa7b9bda3cb6866041f`                                           |

The final manifest records `resume: true` and `git_dirty: true`. The run began as a fresh run and later used compatible checkpoints to reuse completed judged records and retry provider failures. The final recovery used a 300-second model-request timeout and resolved the two remaining execution errors. This is a complete end-to-end artifact, but not a clean fresh-database, `--no-resume` baseline; do not use it directly for version-to-version or leaderboard comparison.

## 3. Evidence completeness and execution

| Metric                                        |                             Result |
| --------------------------------------------- | ---------------------------------: |
| Scheduled questions / persisted predictions   |                      1,492 / 1,492 |
| Completed Answerer + Judge records            |                      1,492 / 1,492 |
| Final execution errors                        |                  0 / 1,492 (0.00%) |
| Question traces                               |        1,492; 10 unique sample IDs |
| Retrieval, Answerer, and Judge traces present |                 1,492 / 1,492 each |
| Session-ingest records                        | 272; 272 unique daemon message IDs |
| Final session-ingest errors                   |                                  0 |
| Recorded prompt tokens                        |                         18,366,412 |
| Recorded completion tokens                    |                          3,203,813 |
| Recorded total tokens                         |                         21,570,225 |
| Mean recorded total tokens / question         |                             14,457 |
| Final recovery wall-clock                     |           3,180,277 ms (about 53m) |

Two Answerer attempts timed out during recovery, but their in-question retries completed successfully. They are not terminal execution errors. Recorded token totals cover completed provider responses present in final checkpoints; failed attempts can carry provider-side usage that is not represented, so the totals are not a billing total.

## 4. Overall result

All scheduled records completed, so the all-record and completed-only views are identical.

| Metric             |               Result |
| ------------------ | -------------------: |
| LLM-judge accuracy | 931 / 1,492 (62.40%) |
| Mean token F1      |               0.1549 |
| Mean BLEU-1        |               0.1158 |
| Mean BLEU-4        |               0.0172 |

LLM-judge accuracy is the primary end-to-end measure in this harness. F1 and BLEU are lexical-overlap diagnostics and do not replace the Judge result.

## 5. Results by category

| Category      | Questions | LLM-judge accuracy | Mean F1 | Mean BLEU-1 |
| ------------- | --------: | -----------------: | ------: | ----------: |
| `multi_hop`   |       261 | 190 / 261 (72.80%) |  0.0740 |      0.0475 |
| `temporal`    |       308 | 175 / 308 (56.82%) |  0.1006 |      0.0696 |
| `open_domain` |        94 |   49 / 94 (52.13%) |  0.0984 |      0.0811 |
| `single_hop`  |       821 | 512 / 821 (62.36%) |  0.2084 |      0.1595 |
| `adversarial` |         8 |     5 / 8 (62.50%) |  0.0534 |      0.0360 |

`multi_hop` is the strongest category in this artifact, while `open_domain` is the weakest. The category results are end-to-end outcomes, not isolated retrieval measurements.

## 6. Retrieval evidence and its limit

The question trace retains the exact final Top-12 text supplied to the Answerer, plus available candidate, fused-before-rerank, reranker, Answerer, and Judge evidence. Pre-merge diagnostics are present for all 1,492 questions.

LoCoMo V2 MiniCPM does not supply QA-level `evidence` turn IDs. Therefore no question is retrieval-evaluable against gold turns, and the following retrieval metrics are correctly recorded as `null`: Recall@K, retrievable Recall@K, Hit@K, Precision@K, MRR, all-evidence-retrieved rate, and candidate-channel evidence recall. A session-level match or parent metadata must not be substituted for child-turn gold evidence.

This artifact proves that daemon-owned retrieval and its final returned context were recorded for every question. It does not prove a numeric retrieval-recall claim. An evidence-bearing LoCoMo-compatible dataset is required for that claim.

## 7. End-to-end failure interpretation

| Diagnostic classification   | Count |
| --------------------------- | ----: |
| `none` (judge-correct)      |   931 |
| `gold_evidence_unavailable` |   561 |
| Execution/provider errors   |     0 |

The 561 non-passing records are labelled `gold_evidence_unavailable` because this V2 file has no QA-level gold turns. This is an evidence-availability limit, not a causal finding that retrieval, Answerer, or Judge behavior caused those outcomes.

## 8. Artifact boundary and follow-up

This artifact proves that every scheduled question reached a terminal judged record with ingestion, retrieval, Answerer, and Judge evidence. It does not establish a clean-baseline comparison, a standalone retrieval score, or an official leaderboard score.

The narrow next steps are:

1. Use a fresh database, `--no-resume`, and a clean recorded revision or explicit patch identity before comparing systems.
2. Use a LoCoMo-compatible file with QA-level evidence IDs before making Recall@K, Hit@K, Precision@K, or MRR claims.
3. Analyze the 561 non-passing traces by question category and final context quality, while keeping ingestion and retrieval daemon-owned.
