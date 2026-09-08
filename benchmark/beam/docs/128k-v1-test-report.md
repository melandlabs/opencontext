# BEAM 128k First Full Evaluation Report

- Report version: v1
- Status: diagnostic baseline; not a formal performance baseline
- Dataset scale: BEAM `128k`
- Completed at: 2026-09-01 06:22
- Result: [beam-128k-v1_1-full-20260831.json](../results/beam-128k-v1_1-full-20260831.json)
- End-to-end trace: [beam-128k-v1_1-full-20260831.trace.jsonl](../results/beam-128k-v1_1-full-20260831.trace.jsonl)
- Ingest records: [beam-128k-v1_1-full-20260831.chunks.jsonl](../results/beam-128k-v1_1-full-20260831.chunks.jsonl)

> `results/`, checkpoints, and database files are excluded by `.gitignore` by default. This report preserves a committable summary; the raw artifacts must be retained separately.

## 1. Purpose

This evaluation measured OpenContext's end-to-end memory question-answering behavior on BEAM 128k and collected enough evidence to distinguish among the following stages:

1. whether the dataset supplied usable gold sources;
2. whether the conversation was ingested into OpenContext;
3. whether Top-K retrieval contained the gold sources;
4. whether the Answerer used retrieved evidence correctly; and
5. whether the Judge scored the answer against the nugget atoms.

The end-to-end score is not interpreted as a pure retrieval metric. Answerer, Judge, benchmark-adapter, and dataset problems must not be attributed directly to the OpenContext memory implementation.

## 2. Configuration

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
| Retrieval | `memory-search`, Top-K=8 |
| Conversation grouping | One memory message per 20 turns |
| Trace schema | `1.1` |
| Manifest commit | `d722484d759f176c269523fe9958ce75a8f78956` |
| Resume | `true` |

The result manifest did not record the daemon's memory backend, embedding provider/model, embedding token limit, merge strategy, database path, or Git dirty state. The daemon and actual working-tree configuration therefore cannot be reconstructed completely from the manifest alone.

## 3. Execution completeness and cost

| Metric | Result |
|---|---:|
| Completed questions | 400 / 400 |
| Execution errors | 0 |
| Wall-clock | 942,760 ms, approximately 15m 43s |
| Prompt tokens | 30,046,468 |
| Completion tokens | 1,409,917 |
| Total tokens | 31,456,385 |
| Mean total tokens per question | approximately 78,641 |

The provider returned token usage for all completed questions. This report does not estimate monetary cost because the actual amount depends on OpenRouter pricing and routing at execution time.

## 4. Overall result

| Metric | Result |
|---|---:|
| Nugget Mean | 0.5305 |
| Pass Count | 227 / 400 |
| Pass Rate | 56.75% |
| Failed | 173 / 400 |

All 400 questions received Answerer and Judge results, so the run is usable for diagnosis. The score remains a diagnostic baseline because of the retrieval-channel, grouping, and reproducibility limitations described below.

## 5. Results by category

| Category | Nugget Mean | Pass Rate | Passed |
|---|---:|---:|---:|
| abstention | 0.8250 | 82.50% | 33 / 40 |
| preference_following | 0.7146 | 80.00% | 32 / 40 |
| information_extraction | 0.6292 | 65.00% | 26 / 40 |
| contradiction_resolution | 0.4906 | 60.00% | 24 / 40 |
| instruction_following | 0.5563 | 57.50% | 23 / 40 |
| multi_session_reasoning | 0.4855 | 52.50% | 21 / 40 |
| summarization | 0.4341 | 52.50% | 21 / 40 |
| temporal_reasoning | 0.4500 | 50.00% | 20 / 40 |
| knowledge_update | 0.4750 | 47.50% | 19 / 40 |
| event_ordering | 0.2444 | 20.00% | 8 / 40 |

Abstention, preference following, and information extraction were the strongest categories. Event ordering was the weakest, followed by summarization, temporal reasoning, and knowledge update. The overall pattern suggests that single-fact retrieval and refusal were more stable than multi-evidence composition, chronological reasoning, and fact updates.

## 6. Retrieval evidence

The following metrics cover the 355 questions that provide upstream gold source IDs:

| Metric | Result | Meaning |
|---|---:|---|
| Hit@8 | 92.11% | At least one gold source occurred in Top-8 |
| Mean Source Recall@8 | 0.8027 | Approximately 80.27% of required source turns were covered on average |
| All Required Sources Retrieved | 65.35% | Every required source occurred in Top-8 |
| Precision@8 | 0.2011 | The proportion of Top-8 blocks covering gold sources was low |
| MRR | 0.2958 | The first relevant block was often not ranked near the top |
| Dataset Source Coverage | 1.0000 | All supplied source IDs could be found in the dataset |

Retrieval usually found at least one relevant source, but often returned only part of the evidence required by multi-event or multi-session questions. Top-8 also contained substantial unrelated content.

### 6.1 Final results were almost entirely lexical

The 400 questions produced 3,200 final Top-K hits:

- `lexical-only`: 3,199;
- `lexical + semantic`: 1; and
- `semantic-only`: 0.

The evidence given to the Answerer was therefore almost entirely supplied by the lexical channel. The trace recorded only the merged Top-K, not the pre-merge semantic and lexical candidate lists. It could not determine whether semantic ANN returned no candidates or whether semantic candidates were removed during merge and ranking.

This run must not be treated as an effective measurement of OpenContext semantic memory until that distinction is observable.

### 6.2 Blocks greatly exceeded the local embedding input range

The evaluator grouped every 20 turns into one memory message. The run produced 296 such blocks:

| Block characters | Result |
|---|---:|
| Mean | 41,712 |
| P50 | 40,834 |
| P95 | 58,259 |
| Maximum | 376,965 |

The repository's local embedding provider defaulted to `maxTokens=512` and explicitly enabled tokenizer truncation. If the daemon used that path, a block containing tens of thousands of characters could not be represented completely; later content would not participate in its embedding.

Because the manifest did not record the actual embedding provider or token limit, this is a high-risk configuration issue rather than a uniquely proven root cause.

## 7. Answerer evidence

The Answerer received eight complete memory blocks for each question:

| Answerer input | Result |
|---|---:|
| Mean context characters | 343,439 |
| Mean prompt tokens | 74,191 |
| P50 prompt tokens | 71,928 |
| P95 prompt tokens | 100,504 |
| Maximum prompt tokens | 105,620 |

Although these inputs did not cause execution errors, the context was extremely large and contained substantial irrelevant material. The model had to locate a small amount of evidence inside approximately 70,000 to 100,000 prompt tokens, increasing cost and making chronology, conflict resolution, and multi-evidence composition less reliable.

### 7.1 Failure stages

| Failure Stage | Count | Interpretation |
|---|---:|---|
| `context_present_answer_failed` | 94 | All gold sources occurred in Top-K, but the final answer failed |
| `retrieval_partial` | 64 | Only part of the required sources was retrieved |
| `retrieval_miss` | 14 | No gold source was retrieved |
| `dataset_reference_missing` | 1 | The upstream question did not provide source IDs |
| `none` | 227 | Passed |

The 94 `context_present_answer_failed` cases do not prove that retrieval was correct and only the model failed. They show only that a large block containing each gold source was present in the prompt. The relevant text could still have been obscured by the oversized blocks and prompt.

These failures were concentrated in:

- knowledge update: 18;
- contradiction resolution: 13;
- temporal reasoning: 13;
- instruction following: 12; and
- multi-session reasoning: 10.

Smaller evidence units or a gold-evidence control would be required to separate context-construction failures from Answerer limitations.

## 8. Attribution and judging limitations

Among the 355 questions requiring source evidence:

| Attribution | Count | Rate |
|---|---:|---:|
| supported | 153 | 43.10% |
| unsupported | 110 | 30.99% |
| uncited | 92 | 25.92% |

The diagnostics recognized only forms such as `Excerpt 3`, `Memory excerpt 3`, or `[3]`. An Answerer citation containing an actual chunk ID such as `beam_9__chunk_1` could still be classified as `uncited`. Attribution was useful for detecting problems but was not a precise citation-accuracy metric.

Two dataset-quality issues were also confirmed:

1. `128k_18_q_16` had no upstream source IDs, so retrieval attribution could not be computed; and
2. the gold answer for `128k_1_q_18` said `4 weeks`, while its nugget atom required `8 weeks`.

The Judge scored against the atom, so this inconsistency could not be attributed directly to the Answerer or memory system. Using different models for the Answerer and Judge was not itself a problem. The main risks were Answerer input construction and consistency among the source references, gold answers, and atoms.

## 9. Conclusions

This diagnostic baseline established that:

1. all 400 questions completed with no provider or execution error;
2. abstention, preference following, and single-fact extraction were comparatively strong;
3. event ordering, multi-session composition, temporal reasoning, and knowledge updates were weak;
4. complete multi-evidence retrieval and ranking needed improvement;
5. final Top-K was almost entirely lexical, so semantic retrieval had not been demonstrated;
6. 20-turn grouping and a mean Answerer prompt near 74,000 tokens created substantial efficiency and quality risks; and
7. some failures came from inconsistent dataset references or atoms and could not be counted as OpenContext defects.

The run should remain a `BEAM 128k diagnostic baseline v1`. It is not a formal public BEAM score and should not be compared directly with published agent results.

## 10. Recommended remediation

### P0: prove that semantic retrieval is active

1. Record the requested and effective merge strategy.
2. Trace semantic and lexical candidates before merge and their contribution to final results.
3. Record the daemon backend, embedding provider/model/token limit, reasoning configuration, and database identity.
4. Require a known-fact calibration query to produce observable semantic candidates before a full run.

### P1: reduce retrieval-unit and Answerer-context size

1. Use one upstream source turn as the parent retrieval record.
2. Split only an oversized turn into embedding-safe child chunks while retaining its source ID.
3. Keep every embedding input within the provider's real token limit.
4. Deduplicate and rerank after retrieval, then return only the relevant excerpt and necessary local context.
5. Preserve timestamps and source IDs so chronological evidence remains reconstructable.
6. Enforce an explicit Answerer context budget.

### P2: improve diagnostic reliability

1. Use structured citations or recognize actual result IDs.
2. Check source IDs, gold answers, and nugget atoms for date and numeric consistency.
3. Compare actual retrieval context with gold evidence on stratified weak-category samples.
4. Review a stratified sample manually or with a stronger Judge without changing the official nugget scoring rules.

## 11. Minimum acceptance criteria for the next 128k run

Before another full 128k evaluation:

- semantic candidates must be visible in calibration and trace output instead of silently degrading to lexical-only retrieval;
- retrieval units must remain within the actual embedding token limit;
- the manifest must identify the daemon, embedding, merge strategy, database, and working-tree state needed for reproduction;
- Answerer prompt size must have a defined budget and report mean and P95 values;
- the run must use a fresh database and `--no-resume`;
- official nugget scoring must remain unchanged, with diagnostics excluded from the score;
- all 400 questions must complete with zero final execution errors; and
- raw scores, dataset anomalies, and evidence-chain metrics must be reported separately.
