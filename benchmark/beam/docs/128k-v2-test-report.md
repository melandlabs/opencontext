# BEAM 128k Child-Chunk and Local-Reranker Evaluation Report

- Report version: v2
- Status: completed diagnostic comparison; not a formal public performance baseline
- Dataset scale: BEAM `128k`
- Completed at: 2026-09-03 05:15 (UTC+8)
- Result: [beam-128k-top12-local-reranker-20260902-232308.json](../results/beam-128k-top12-local-reranker-20260902-232308.json)
- Run manifest: [beam-128k-top12-local-reranker-20260902-232308.json.manifest.json](../results/beam-128k-top12-local-reranker-20260902-232308.json.manifest.json)
- End-to-end trace: [beam-128k-top12-local-reranker-20260902-232308.trace.jsonl](../results/beam-128k-top12-local-reranker-20260902-232308.trace.jsonl)
- Ingest records: [beam-128k-top12-local-reranker-20260902-232308.chunks.jsonl](../results/beam-128k-top12-local-reranker-20260902-232308.chunks.jsonl)
- Comparison baseline: [128k-v1-test-report.md](128k-v1-test-report.md)

> `results/`, checkpoints, model caches, and database files are excluded by `.gitignore` by default. This report preserves a committable summary; the raw artifacts must be retained separately.

## 1. Purpose and scope

The v1 run exposed two fundamental problems: the BEAM adapter grouped 20 turns into oversized retrieval records, and the final evidence was effectively lexical-only. The v2 run evaluates the OpenContext core after replacing that path with searchable child chunks, hybrid candidate fusion, and optional local reranking.

The following evaluation inputs remained unchanged:

- BEAM dataset and upstream revision;
- Answerer model;
- Judge model;
- Answerer and Judge prompts;
- official nugget atoms and scoring behavior; and
- benchmark categories.

The run is intended to diagnose OpenContext retrieval and context construction. It is not directly comparable with a hosted leaderboard result.

## 2. System and evaluation configuration

| Item | Configuration |
|---|---|
| Dataset | `dataset/beam_128k.json` |
| Dataset size | 13,441,553 bytes |
| Dataset SHA-256 | `8cc3374c9f258bfa91df3f7a0d5d7c9ade64dd704a723829c2095dbeabb43d7e` |
| Upstream dataset | `Mohammadta/BEAM`, config `default`, split `100K` |
| Upstream revision | `3205395e897e7318c7b094ef4e6047b9b82dbb03` |
| Conversations | 20 |
| Questions | 400; 40 per category |
| Answerer | `openrouter:deepseek/deepseek-v4-flash-0731` |
| Judge | `openrouter:qwen/qwen3.7-flash` |
| Backend | `sqlite-vec` dense retrieval plus SQLite FTS5 lexical retrieval |
| Embedding | `Xenova/all-MiniLM-L6-v2`, local, 384 dimensions |
| Parent record | One complete upstream turn per `RawMessage` |
| Search child | 400 estimated tokens, 80-token overlap |
| Merge | Reciprocal Rank Fusion (RRF) |
| Candidate window | 48 for Top-12 |
| Reranker | `Xenova/ms-marco-MiniLM-L-6-v2`, local quantized cross-encoder |
| Final retrieval | Top-12 |
| Trace schema | `1.3` |
| Manifest commit | `564630bef1f79034e7f6fe2219e2889fcdbe9c5f` |

The initial invocation used a new database and `--no-resume`. Later invocations used fair resume semantics: completed answers, including incorrect answers, were reused; only execution errors were retried.

The manifest commit identifies the checked-out revision, but the child-index and reranker implementation was still an uncommitted working-tree change during the run. The result therefore cannot be reconstructed from that commit alone. A formal future baseline must record or eliminate the dirty diff.

## 3. Index construction

The adapter ingested each upstream turn as one complete parent message. OpenContext retained the complete parent text and generated bounded search-only children:

| Index metric | Result |
|---|---:|
| Parent RawMessages | 5,732 |
| Search children | 11,084 |
| Embedded children | 11,084 |
| Mean parent characters | 2,134 |
| Maximum parent characters | 348,853 |
| Mean child characters | 1,297 |
| Maximum child characters | 2,000 |
| Maximum children for one parent | 219 |

This preserves the original turn while preventing oversized turns from being represented by one truncated embedding. A short-message hit returns the complete parent; a long-message hit returns a continuous window around the matched child.

## 4. Execution completeness and token usage

| Metric | Result |
|---|---:|
| Completed questions | 400 / 400 |
| Final execution errors | 0 |
| First-attempt completions | 369 |
| Second-attempt completions | 24 |
| Third-attempt completions | 7 |
| Prompt tokens | 2,842,331 |
| Completion tokens | 1,163,725 |
| Total recorded tokens | 4,006,056 |
| Mean total tokens per completed question | 10,015 |
| Mean Answerer prompt tokens | 6,213 |
| Mean Answerer context characters | 25,958 |

The initial run encountered 31 Answerer execution errors caused by OpenRouter connection/TLS timeouts, empty content, or response-processing failures. Resume retried those errors without selectively retrying incorrect judged answers.

The recorded token total aggregates successful checkpoint records. Failed provider attempts may have incurred additional usage that is not preserved in the final result, so the billed total may be slightly higher.

The observed elapsed time from initial launch through completion was approximately 5h 52m. The manifest's `2,251,212 ms` wall-clock value covers only the final resume invocation and must not be presented as the duration of the complete evaluation.

## 5. Overall result

| Metric | v1 | v2 | Change |
|---|---:|---:|---:|
| Nugget Mean | 0.5305 | 0.6120 | +0.0816 |
| Pass Count | 227 / 400 | 267 / 400 | +40 |
| Pass Rate | 56.75% | 66.75% | +10.00 pp |
| Total recorded tokens | 31,456,385 | 4,006,056 | -87.27% |
| Mean Answerer prompt tokens | 74,191 | 6,213 | -91.62% |
| Mean Answerer context characters | 343,439 | 25,958 | -92.44% |
| MRR | 0.2958 | 0.4783 | +0.1825 |

The v2 path used approximately one eighth of the recorded tokens while improving the pass rate by ten percentage points. This is the principal result of the run: reducing retrieval granularity and reranking bounded evidence improved both efficiency and end-to-end quality.

## 6. Results by category

| Category | v1 Pass Rate | v2 Pass Rate | Change |
|---|---:|---:|---:|
| abstention | 82.50% | 75.00% | -7.50 pp |
| contradiction_resolution | 60.00% | 90.00% | +30.00 pp |
| event_ordering | 20.00% | 25.00% | +5.00 pp |
| information_extraction | 65.00% | 85.00% | +20.00 pp |
| instruction_following | 57.50% | 65.00% | +7.50 pp |
| knowledge_update | 47.50% | 60.00% | +12.50 pp |
| multi_session_reasoning | 52.50% | 72.50% | +20.00 pp |
| preference_following | 80.00% | 90.00% | +10.00 pp |
| summarization | 52.50% | 40.00% | -12.50 pp |
| temporal_reasoning | 50.00% | 65.00% | +15.00 pp |

Contradiction resolution, information extraction, multi-session reasoning, and temporal reasoning improved substantially. Abstention and summarization regressed. Event ordering improved only slightly and remains the weakest category.

## 7. Retrieval and reranking evidence

The following final metrics cover the 355 questions with upstream gold source IDs:

| Metric | v2 Result |
|---|---:|
| Semantic candidate source recall@48 | 0.7080 |
| Lexical candidate source recall@48 | 0.5797 |
| Final source recall@12 | 0.5233 |
| Hit@12 | 0.7014 |
| All Required Sources Retrieved | 0.4141 |
| Precision@12 | 0.0958 |
| MRR | 0.4783 |
| Dataset Source Coverage | 1.0000 |

All 400 questions produced both semantic and lexical candidate lists. No question reported empty semantic candidates or a semantic-degradation warning. This resolves the v1 observability gap: semantic retrieval was active and traceable rather than silently disappearing from the final path.

The local reranker processed all 400 candidate windows and changed their order for every question:

| Reranker metric | Result |
|---|---:|
| Mean latency | 2,853 ms/question |
| P50 latency | 2,843 ms/question |
| P95 latency | 2,987 ms/question |
| Maximum latency | 3,560 ms/question |

### 7.1 Controlled ranking comparison

The v2 trace permits a controlled comparison using the same 48 candidates before and after local reranking:

| Selection | Source Recall | Hit@K | All Required | MRR | Precision |
|---|---:|---:|---:|---:|---:|
| Pre-rerank Top-8 | 0.3203 | 0.5127 | 0.2000 | 0.1684 | 0.0852 |
| Pre-rerank Top-12 | 0.4366 | 0.6394 | 0.3099 | 0.1809 | 0.0779 |
| Post-rerank Top-8 | 0.4721 | 0.6507 | 0.3634 | 0.4734 | 0.1236 |
| Post-rerank Top-12 | 0.5233 | 0.7014 | 0.4141 | 0.4783 | 0.0958 |

At the same Top-8 limit, reranking increased source recall by 15.18 percentage points and All Required Sources by 16.34 percentage points. Expanding the reranked result from Top-8 to Top-12 added approximately 5.12 percentage points of source recall, but reduced precision because four additional results were included.

The v1 and v2 final retrieval-recall metrics are not directly comparable. A single v1 result represented 20 turns and was credited when any gold turn occurred anywhere inside that oversized block. V2 uses much smaller parent and child evidence units, so source matching is substantially stricter. End-to-end scores, token usage, and the controlled v2 pre/post-rerank comparison are more meaningful than a direct v1 Hit@8 versus v2 Hit@12 comparison.

## 8. Failure analysis

| Failure Stage | Count |
|---|---:|
| `none` | 267 |
| `retrieval_miss` | 57 |
| `retrieval_partial` | 38 |
| `context_present_answer_failed` | 33 |
| `dataset_reference_missing` | 5 |

Of the 133 failed questions, 95 were retrieval misses or partial retrievals, 33 had the required evidence in context but still failed, and 5 lacked usable source references. Retrieval completeness is therefore the largest remaining system bottleneck.

The category breakdown makes the next problems more specific:

- **Event ordering:** 23 retrieval misses and 7 partial retrievals. When all required evidence was present, all 10 such questions passed. The immediate problem is retrieving every event, not chronological sorting alone.
- **Summarization:** 10 retrieval misses, 10 partial retrievals, and 4 missing dataset references. A fixed number of local excerpts does not reliably cover a conversation-wide summary.
- **Abstention:** all 10 failures had context but answered when the dataset expected refusal. Filling Top-12 with weakly related evidence can encourage unsupported answers.
- **Temporal reasoning:** 5 partial retrievals and 9 context-present answer failures. Both evidence coverage and explicit temporal presentation remain relevant.
- **Knowledge update:** 2 misses, 5 partial retrievals, and 9 context-present answer failures. New and old facts need clearer temporal and update semantics.

## 9. Improvements demonstrated by v2

1. BEAM no longer owns a 20-turn chunking or ranking policy; one upstream turn maps to one complete parent RawMessage.
2. Oversized parents are represented by independently embedded, bounded search children while complete original text remains retrievable.
3. SQLite dense and FTS5 lexical candidates are generated separately and merged through the OpenContext core RRF path.
4. A four-times candidate window is reranked before final Top-K truncation.
5. The local reranker improves ranking without sending candidate text to another API.
6. Retrieval diagnostics expose backend, channels, pre-merge candidates, pre-rerank order, final order, and degradation reasons.
7. Average Answerer context fell by more than 92%, while Nugget Mean and pass rate improved.
8. Official BEAM nugget scoring remained unchanged.

## 10. Remaining limitations and recommended work

### P0: improve multi-evidence recall

- Reuse the generic query-rewrite/reasoning path to generate atomic subqueries for multi-event or multi-facet questions.
- Retrieve semantic and lexical candidates for each subquery, then merge them before reranking.
- Add lightweight coverage/diversity selection so the final set is not dominated by several excerpts about the same event.
- Treat Top-12 as a maximum, not a quota. Do not expand final Top-K blindly.

### P1: improve evidence sufficiency and temporal context

- Calibrate a generic evidence-sufficiency gate from reranker relevance rather than RRF score.
- Return `insufficient_evidence` when no result directly supports the query, allowing callers to abstain instead of guessing.
- Preserve timestamp, session sequence, and turn sequence in returned evidence.
- Present selected evidence chronologically when a caller needs an answer context, while retaining relevance rank separately.
- Present old and new statements about the same subject together with explicit temporal metadata.

### P2: support broad summarization and complete validation

- Add a higher-level session or phase summary linked back to the original RawMessages; summaries should locate evidence, not replace it as the final authority.
- Batch and cache local reranker inference to reduce its approximately 2.85-second per-question latency.
- Run retrieval-only A/B checks for SQLite, Chroma, LanceDB, and Milvus before assuming a different backend improves quality.
- Record Git dirty state or a patch identity in the next formal manifest.
- Report dataset-reference and atom inconsistencies separately from OpenContext failures.

These changes belong in the OpenContext core. They should not be implemented as BEAM category regexes, benchmark-only ranking rules, or changes to the official scorer.

## 11. Interpretation

V2 is a meaningful improvement over the first diagnostic baseline. It demonstrates that bounded child retrieval, hybrid RRF fusion, and local reranking can reduce recorded token usage by 87.27% while increasing the pass rate by 10 percentage points.

It does not show that retrieval is solved. Only 41.41% of retrieval-applicable questions received every required source, and the weakest categories still depend on retrieving multiple distributed events. The next quality improvement should focus on multi-query recall, coverage-aware evidence-set selection, and evidence sufficiency rather than a larger fixed Top-K.
