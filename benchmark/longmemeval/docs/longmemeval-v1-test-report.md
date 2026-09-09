# LongMemEval V1 OpenContext Evaluation Report

- Report version: v1
- Status: completed, 500 / 500 Answerer-and-Judge records persisted; no final execution errors
- Dataset: `longmemeval_s_cleaned.json` (500 questions)
- Result: [longmemeval-opencontext-v1.json](../results/longmemeval-opencontext-v1.json)
- Run manifest: [longmemeval-opencontext-v1.json.manifest.json](../results/longmemeval-opencontext-v1.json.manifest.json)
- Question trace: [longmemeval-opencontext-v1.trace.jsonl](../results/longmemeval-opencontext-v1.trace.jsonl)
- Session-ingest trace: [longmemeval-opencontext-v1.sessions.jsonl](../results/longmemeval-opencontext-v1.sessions.jsonl)

> `results/`, checkpoints, runtime databases, and model caches are excluded by `.gitignore`. This report is the committable summary; retain the linked raw artifacts for response-, source-, and trace-level audit. It intentionally does not create a separate question index.

## 1. Purpose and scope

This report records the completed OpenContext LongMemEval run. For each dataset question, the harness maps each source session to one `RawMessage`, gives it to the local OpenContext daemon for daemon-owned chunking, indexing, retrieval, fusion, and reranking, then supplies the daemon's final Top-8 results to the benchmark Answerer prompt. The benchmark judges that answer with an LLM and records retrieval and ingest evidence.

The result is an end-to-end diagnostic, not a pure retrieval score: it includes the daemon's retrieval behavior, the supplied context, the Answerer model, and the Judge model. It is also **not** an AML/official-leaderboard LongMemEval score: this directory uses OpenContext's custom F1/BLEU metrics and custom LLM-judge prompt rather than the vendored AML pipeline.

## 2. System and evaluation configuration

| Item | Configuration |
|---|---|
| Dataset | `dataset/longmemeval_s_cleaned.json` |
| Dataset size / SHA-256 | 277,383,467 bytes / `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| Questions | 500 |
| Answerer | `openrouter:deepseek/deepseek-v4-flash-0731` |
| Judge | `openrouter:qwen/qwen3.8-flash` |
| Store | isolated local `sqlite-vec` daemon, with SQLite lexical search available |
| Embedding | local `Xenova/all-MiniLM-L6-v2`, 384 dimensions |
| Reranker | local `Xenova/ms-marco-MiniLM-L-6-v2` |
| Parent record | one complete LongMemEval session per `RawMessage` |
| Child chunking | daemon-owned, roughly 400 estimated tokens with 80-token overlap |
| Retrieval | daemon-default final Top-8 |
| Trace schema | `1.0` |
| Manifest commit | `554238ad07bf1768e90a6cd0777471140ca431d1` |

The manifest records `resume: true` and `git_dirty: true`. Completed checkpoints—including judged incorrect answers—were reused, while execution-error checkpoints were retried until no errors remained. This is a complete end-to-end artifact, but it is not a clean fresh-database, `--no-resume` baseline and should not be used for a formal version-to-version or leaderboard comparison.

During recovery, the harness found that a small number of dataset haystacks repeat a `session_id` within the same question. The raw-message mapping now appends the session index only for duplicate occurrences; ordinary IDs remain stable. This prevents two different sessions from sharing a daemon message ID and merging their chunks. The final session trace records the corrected mapping.

## 3. Evidence completeness and execution

| Metric | Result |
|---|---:|
| Scheduled questions / persisted predictions | 500 / 500 |
| Completed Answerer + Judge records | 500 / 500 |
| Final execution errors | 0 / 500 (0.00%) |
| Question traces | 500; 500 unique question IDs |
| Retrieval, Answerer, and Judge traces present | 500 / 500 each |
| Session-ingest records | 23,867 |
| Final session-ingest errors | 0 |
| Recorded prompt tokens | 3,982,026 |
| Recorded completion tokens | 782,427 |
| Recorded total tokens | 4,764,453 |
| Mean recorded total tokens / question | 9,529 |

Recorded token totals reflect completed provider responses represented in the final checkpoints. Failed attempts during the recovery process can have provider-side usage that is not included, so these values are not a billing total.

## 4. Overall result

All scheduled records completed, so the all-record and completed-only views are identical.

| Metric | Result |
|---|---:|
| LLM-judge accuracy | 241 / 500 (48.20%) |
| Mean token F1 | 0.1143 |
| Mean BLEU-1 | 0.0820 |
| Mean BLEU-4 | 0.0059 |

The judge accuracy is the primary end-to-end outcome for this harness. F1 and BLEU provide lexical overlap diagnostics, but they should not be interpreted as substitutes for the LLM-judge result.

## 5. Results by question type

| Question type | Questions | LLM-judge accuracy | Mean F1 | Mean BLEU-1 |
|---|---:|---:|---:|---:|
| `single-session-user` | 70 | 46 / 70 (65.71%) | 0.1464 | 0.1153 |
| `multi-session` | 133 | 42 / 133 (31.58%) | 0.0532 | 0.0406 |
| `single-session-preference` | 30 | 14 / 30 (46.67%) | 0.1417 | 0.0945 |
| `temporal-reasoning` | 133 | 46 / 133 (34.59%) | 0.1258 | 0.0783 |
| `knowledge-update` | 78 | 41 / 78 (52.56%) | 0.0982 | 0.0681 |
| `single-session-assistant` | 56 | 52 / 56 (92.86%) | 0.1995 | 0.1597 |

`single-session-assistant` is the strongest category. `multi-session` and `temporal-reasoning` are substantially weaker, so any next iteration should focus on multi-evidence selection and temporal context use rather than treating the overall score as a single undifferentiated retrieval failure.

## 6. Retrieval evidence

All 500 questions have dataset answer-session references and pre-merge retrieval diagnostics. The following metrics are session-level: a retrieved result is relevant when its source session ID matches an official `answer_session_id`.

| Metric | Result |
|---|---:|
| Retrieval-applicable questions | 500 / 500 |
| Dataset source coverage | 1.0000 |
| Pre-merge diagnostics available | 500 / 500 |
| Semantic candidate answer-session recall | 0.7938 |
| Lexical candidate answer-session recall | 0.9889 |
| Final answer-session recall@8 | 0.9123 |
| Hit@8 | 0.9640 |
| All answer sessions retrieved@8 | 0.8500 |
| Precision@8 | 0.2155 |
| MRR | 0.8960 |

The trace includes the final retrieved sessions plus semantic, lexical, hybrid/entity, fused-before-rerank, and reranker evidence where the daemon exposed those channels. The `hybrid` diagnostic channel's mean recall is zero in this artifact; this denotes no separately surfaced hybrid channel, not proof that the daemon omitted its own fusion path. The result should be interpreted from the observed final Top-8 evidence and the recorded channel fields rather than from a run label alone.

## 7. End-to-end failure analysis

The `failure_stage` label is an evidence classification for non-passing records, not a causal proof about any one subsystem.

| Failure stage | Count |
|---|---:|
| `none` (judge-correct) | 241 |
| `context_present_answer_failed` | 192 |
| `retrieval_miss` | 18 |
| `retrieval_partial` | 49 |
| Execution/provider errors | 0 |

Of 259 non-passing records, 67 have a final retrieval miss or only partial answer-session coverage, while 192 have all required answer sessions represented in final context but still fail the end-to-end judge. This supports investigating answer construction, prompt following, temporal reasoning, and multi-session synthesis in addition to retrieval coverage. It does **not** prove that the remaining 192 failures were caused only by the Answerer: judging and evidence quality still remain part of the measurement.

## 8. Artifact boundaries and follow-up

This artifact proves that every scheduled question reached a terminal, judged record with session-ingest, retrieval, Answerer, and Judge evidence. It does not prove a clean-baseline comparison because it used a dirty worktree and resume semantics.

The narrow next steps are:

1. Run a fresh database with `--no-resume` and a recorded clean commit or explicit patch identity before comparing systems or publishing a baseline.
2. Analyze the 192 `context_present_answer_failed` records by question type and prompt/evidence sufficiency, especially temporal and multi-session questions.
3. Improve final Top-8 coverage selection for the 67 retrieval-miss/partial records, preserving the daemon-owned ingestion and retrieval boundary.
4. Use the AML-local path separately if an AML-comparable LongMemEval score is required; do not conflate it with this custom harness result.
