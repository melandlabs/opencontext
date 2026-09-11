# PersonaMem-v2 AML-Local MCQ Evaluation Report

- Report version: v1
- Status: completed; 5,000 / 5,000 questions answered and deterministically scored
- Dataset: public PersonaMem-v2 `benchmark.csv` with the text/32K history for every persona
- Result: [judged.jsonl](../../aml-local/outputs/personamem/judged.jsonl)
- Merged answers: [answers.merged.jsonl](../../aml-local/outputs/personamem/answers.merged.jsonl)
- Run manifest: [run-manifest.json](../../aml-local/outputs/personamem/run-manifest.json)

> `outputs/`, raw answer shards, and runtime databases are excluded by `.gitignore`. This report is the committable summary; retain the linked artifacts for record-level audit. It intentionally does not create a separate index.

## 1. Purpose and scope

This report records a full public PersonaMem-v2 MCQ run through OpenContext's AML-compatible local path. For each persona, the adapter reads the 32K chat history, maps every 20 turns to one `RawMessage`, ingests those messages into the OpenContext daemon under a persona-scoped `userId`, and issues the dataset question as a Top-10 search. The returned memory text is supplied to the vendored PersonaMem-v2 MCQ prompt; its stored option mapping is then used for exact scoring.

This is an end-to-end local diagnostic, not a pure retrieval measurement or a hosted AML leaderboard result. It combines adapter-side 20-turn grouping, daemon ingestion/search, supplied memory context, Answerer behavior, option-format compliance, and exact MCQ scoring. In particular, the adapter—not the daemon—chooses the 20-turn input groups, so it is not a strict daemon-owned raw-history chunking evaluation.

## 2. System and evaluation configuration

| Item | Configuration |
|---|---|
| Dataset | `dataset/benchmark.csv` plus 200 public text/32K persona histories |
| Dataset size / SHA-256 | 42,426,457 bytes / `95f2a8a324aab7baf2af937feae12731369e2abf7cad5ab3e170594cb25a3e52` |
| Personas / questions | 200 / 5,000 |
| Memory backend | local OpenContext daemon, `sqlite-vec`, with local semantic, lexical, and reranker components available |
| Input unit | adapter-created 20-turn `RawMessage` groups |
| Retrieval | final Top-10; `reasoningStrategy: none` |
| Answerer | `openrouter:deepseek/deepseek-v4-flash-0731` |
| Prompt and score | vendored `data/personamem/pipeline_v2.py` MCQ prompt and exact mapped-answer scorer |
| Judge | `openrouter:qwen/qwen3.7-flash` configured but not invoked by MCQ scoring |
| Manifest commit | `bb12aea8a8cf985cd43333a044967877ef89f5b3` |

The manifest records `resume: true` and `git_dirty: true`. Retrieval completed before answer generation; answer generation resumed from persisted answer IDs and used up to 24 independent processes. Every final answer was merged by question ID and validated against the 5,000 input IDs before scoring. The multi-process recovery made the run complete, but it is not a fresh, clean-tree, single-configuration baseline for formal system comparison.

## 3. Evidence completeness and execution

| Metric | Result |
|---|---:|
| Scheduled questions / retrieval inputs | 5,000 / 5,000 |
| Distinct final answer IDs | 5,000 / 5,000 |
| Deterministically scored MCQ records | 5,000 / 5,000 |
| Terminal process failures | 0 |
| Empty provider answers | 60 / 5,000 (1.20%) |
| Answers without a parsed option letter | 1,157 / 5,000 (23.14%) |
| Answer model identity in final artifacts | 5,000 / 5,000 `deepseek/deepseek-v4-flash-0731` |
| Provider token usage | not exposed by the vendored pipeline |

The 60 empty answers are terminal persisted records, not missing rows; exact MCQ scoring counts them as incorrect. The remaining unparsed-option records also count as incorrect under the official parser. OpenRouter `content: null` responses were retried by the runtime shim; the final files contain no missing IDs and no duplicate IDs.

## 4. Overall result

| Metric | Result |
|---|---:|
| Official MCQ accuracy, all scheduled questions | **1,945 / 5,000 (38.90%)** |
| Parsed-option answers | 3,843 / 5,000 (76.86%) |
| Accuracy conditional on a parsed option | 1,945 / 3,843 (50.61%) |

The all-question score is the report's primary result. The parsed-option view is a format-compliance diagnostic only, not a replacement score: excluding the 1,157 unparsed records would hide a material end-to-end failure mode.

## 5. Results by PersonaMem preference type

`pref_type` is read from the public CSV and joined to the scored record using its stable `persona{persona_id}_q{index}` ID.

| Preference type | Questions | Correct | MCQ accuracy |
|---|---:|---:|---:|
| `anti_stereotypical_pref` | 855 | 315 | 36.84% |
| `ask_to_forget` | 1,048 | 480 | 45.80% |
| `health_and_medical_conditions` | 568 | 182 | 32.04% |
| `neutral_preferences` | 858 | 333 | 38.81% |
| `sensitive_info` | 511 | 163 | 31.90% |
| `stereotypical_pref` | 533 | 238 | 44.65% |
| `therapy_background` | 627 | 234 | 37.32% |

`ask_to_forget` is the strongest category in this artifact; `sensitive_info` and `health_and_medical_conditions` are the weakest. These are end-to-end outcomes, so they do not by themselves establish whether retrieval, answer construction, or option-format following caused the difference.

## 6. Retrieval evidence boundary

This public PersonaMem-v2 file provides a natural-language `related_conversation_snippet`, but no stable QA-level session ID, turn ID, child ID, or list of canonical source IDs. The public chat-history JSON is likewise a flat role/content sequence without session or turn identifiers. Therefore this run correctly makes **no** Recall@K, Hit@K, Precision@K, MRR, or evidence-coverage claim.

The artifacts establish the operational chain—history group ingestion, scoped search, retrieved text injection, Answerer output, and exact scoring—but cannot establish numeric retrieval recall. A dataset with QA-to-source IDs, or an upstream extension that supplies those identifiers, is necessary for that measurement.

## 7. Interpretation and follow-up

The run is complete and scoreable, but its 38.90% all-question accuracy is materially affected by answer-format loss: 1,157 records did not yield an option letter accepted by the official parser. This should be diagnosed before attributing the aggregate score primarily to memory retrieval.

The narrow next steps are:

1. Inspect unparsed responses and improve answer-format compliance without changing the official MCQ prompt or scorer.
2. If comparing retrieval systems, add or obtain QA-level source identifiers; do not infer Recall/Hit from plain-text related snippets.
3. For a formal comparison, rerun with a fresh daemon database, a clean recorded revision, a fixed answer-generation configuration, and no resume/shard recovery.
