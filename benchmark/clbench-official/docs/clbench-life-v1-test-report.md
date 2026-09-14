# CL-bench-Life AML-Local Evaluation Report

- Report version: v1
- Status: completed; 405 / 405 answers and terminal scoring records persisted, including one Judge JSON-parse failure counted as zero
- Dataset: public `CL-bench-Life.jsonl`, 405 tasks
- Answer generation completed: 2026-09-11T21:15:26+08:00 (manifest timestamp)
- Evaluation completed: 2026-09-11T22:19:17+08:00 (manifest timestamp)
- Retrieval inputs: [input.jsonl](../../aml-local/outputs/clbench/input.jsonl)
- Answers: [answers.jsonl](../../aml-local/outputs/clbench/answers.jsonl)
- Scores: [judged.jsonl](../../aml-local/outputs/clbench/judged.jsonl)
- Run manifest: [run-manifest.json](../../aml-local/outputs/clbench/run-manifest.json)

> The dataset, runtime databases, and `outputs/` are excluded by `.gitignore`. This report is the committable summary; retain the linked local artifacts for record-level audit. No separate index is created.

## 1. Purpose and scope

This report records the completed CL-bench-Life run through OpenContext's AML-compatible local evaluation path. Although the dataset and this report reside under `clbench-official`, this run used `benchmark/aml-local/retrieve.py` and the vendored AML CLBench answer/evaluation pipeline, not the separate `clbench-official/infer.py` and `eval.py` workflow. It was not a hosted AML leaderboard submission.

Each task supplies historical material, a question, and task-specific scoring rubrics. Historical material can include conversations, activity records, or documents; it is not necessarily a chat session. The adapter submits the historical material to the daemon, searches using the question, and supplies the returned text to the existing benchmark answer prompt. The Judge evaluates the generated answer against the task's rubrics.

The result measures the complete history-to-answer workflow: input mapping, daemon memory ingestion/search, returned context, answer generation, instruction following, and rubric judging. It is neither a standalone memory-recall score nor a direct measure of general agent tool-use ability.

## 2. System and evaluation configuration

| Item | Configuration |
|---|---|
| Dataset | `benchmark/clbench-official/CL-bench-Life.jsonl` |
| Dataset size | 29,262,222 bytes; 405 tasks |
| Dataset SHA-256 | `4a10701a74bc9e53a84136e1ab0c5aa06989bbaf04a03ca6db6f6b3f17eaac34` |
| Context categories | Three categories, 135 tasks each |
| Rubrics per task | 2 to 40 |
| Memory endpoint | local OpenContext daemon at `http://127.0.0.1:7421` |
| Input unit | one historical source message per `RawMessage`; single-message inline records are split at the final `<\|TASK\|>` marker |
| Isolation in adapter | deterministic task-scoped `userId`, shared by that task's ingestion and search |
| Retrieval limit | Top-10; search query limited to the first 2,000 Python string characters |
| Answerer | `deepseek/deepseek-v4-flash-0731`, recorded in all 405 answer rows |
| Judge | `qwen/qwen3.8-flash`, recorded in all 405 scoring rows |
| Answer/scoring implementation | vendored `benchmark/AML-agent-memory-leaderboard/data/clbench/pipeline.py` |
| Manifest revision | `d620bc18fa5e8d2ccefe3e48f0b430eb3b63c1d6` |
| Recovery configuration in manifest | provider reasoning effort `none`; default completion cap 4,096; answer resume enabled |

The run resumed previously persisted answers and included provider-configuration changes during recovery. The manifest's provider settings describe the recorded recovery configuration, not proof that every answer was generated with identical settings. The revision alone also does not capture the local adapter/shim changes used during execution. This is a completed diagnostic run, not a frozen-configuration, clean-revision baseline.

The available manifest does not fingerprint the daemon database, embedding model, reranker, or full retrieval configuration. Those details must not be borrowed from earlier benchmark reports and presented as verified for this run.

## 3. Input mapping and retrieval boundary

The source contains 163 one-message tasks, 147 three-message tasks, 69 five-message tasks, 19 seven-message tasks, six nine-message tasks, and one eleven-message task.

For multi-message tasks, preceding messages become historical `RawMessage` records, and the final message is the evaluation question. For one-message tasks, the adapter splits `history <|TASK|> question`, ingests only the historical portion, and uses the question for search. All 163 one-message source records have nonempty history and question portions under the current splitter. Role labels are retained in the ingested text. The adapter does not divide those historical messages into fixed-size search chunks; that remains the daemon's responsibility.

The current code derives isolation from the benchmark name, dataset filename, and task ID. This is code-level evidence of task scoping, not a runtime audit of database isolation: the persisted AML input rows do not retain the `userId`, ingest acknowledgements, or returned daemon message IDs. In particular, deterministic IDs do not establish a fresh database on a resumed run.

Five final questions exceed the adapter's 2,000-character search limit. Their full questions remain available to the Answerer, but retrieval uses only the prefix. This is a relevant adapter-side constraint when interpreting outcomes.

## 4. Evidence completeness and execution

Counts below were recomputed from the final JSONL files on 2026-09-12; the dataset checksum was also reverified.

| Metric | Result |
|---|---:|
| Retrieval input rows / distinct IDs | 405 / 405 |
| Answer rows / distinct IDs | 405 / 405 |
| Terminal scoring rows / distinct IDs | 405 / 405 |
| Missing answer or scoring IDs relative to input | 0 |
| Duplicate IDs in each artifact | 0 |
| Empty persisted answers | 0 |
| Inputs with nonempty returned retrieval text lists | 405 / 405 |
| Returned items per task | 1 to 9; mean 2.22 |
| Judge JSON-parse failures counted as zero | 1 / 405 (0.25%) |
| Parsed Judge records with too few requirement statuses | 1 |
| Parsed Judge records containing a nonstandard `partial` status | 1 |
| Provider token usage and billing total | not established by these artifacts |

Top-10 is an upper limit, not a promise of ten returned items. Nonempty retrieval lists establish that text was supplied, not that the necessary evidence was retrieved.

The terminal Judge failure is task `25993591-5787-58b8-5355-419f686ad753`: JSON parsing failed after three attempts, and the pipeline persisted score zero, an empty status list, and ratio zero. Task `5b8cf413-c2cd-a40c-4fa9-26a486e08f7a` has 23 rubrics but only 22 returned statuses. Task `cf1a3252-482f-06ed-a726-63317d7b7547` includes one `partial` status, which the existing ratio implementation treats as unsatisfied. These records are retained in the all-task result without rescoring or silently repairing their outputs.

## 5. Overall result

| Metric | Result |
|---|---:|
| Strict task passes | **4 / 405 (0.99%)** |
| Non-passing terminal records | 401 / 405 (99.01%) |
| Mean recorded requirement satisfaction ratio | **36.37%** |

The primary score is the mean of the persisted binary `rubric_clbench_score`: the Judge is instructed to award one only when every rubric requirement is satisfied, and zero otherwise. The recorded score is preserved; it is not independently recomputed from the status list.

The secondary metric is the arithmetic mean of each task's recorded `rubric_clbench_requirement_ratio` (unrounded mean: `0.363720515140469`). The pipeline divides affirmative statuses by the number of returned statuses, then averages across tasks; an empty list contributes zero. It is not a pooled fraction over all gold rubrics. Consequently, the status-count mismatch above is a limitation of this diagnostic. Conditional rubrics can also be marked satisfied when their triggering condition does not apply, so this number is not factual coverage or memory recall.

## 6. Results by context category

Categories are taken from input `metadata.context_category` and joined to final scores by task ID.

| Context category | Tasks | Strict passes | Pass rate | Mean requirement ratio |
|---|---:|---:|---:|---:|
| Behavioral Records & Activity Trails | 135 | 1 | 0.74% | 29.06% |
| Communication & Social Interactions | 135 | 1 | 0.74% | 38.88% |
| Fragmented Information & Revisions | 135 | 2 | 1.48% | 41.17% |
| **All tasks** | **405** | **4** | **0.99%** | **36.37%** |

These are end-to-end category outcomes. With only four strict passes overall, category differences should not be treated as robust evidence that one retrieval capability is stronger than another.

## 7. Concrete task example and judging caveats

The first task, `4ac7eaf6-948e-a848-93f3-38f512b8ac68`, asks:

> ok, from those hands that went to showdown, could you tell me one thing I did well and one thing I can improve? Reference specific hands in your analysis. Additionally, for the area I can improve, pick one illustrative showdown hand and tell me what I should have done differently.

Its source history includes poker hand logs and an earlier assistant summary listing 17 showdown hands. The persisted answer prompt contains two retrieved items: that summary and an excerpt containing detailed hand history around `#2535200281`. The answer uses that hand for both the positive example and the improvement discussion.

The task has 40 rubrics. Requirement 1 asks for a positive example from a specified hand list; requirement 2 asks for an improvement example from a different list. Subsequent requirements check hand facts, interpretations, and proposed alternative actions, many conditionally on whether a hand is referenced. The Judge returned 38 `yes` statuses and two `no` statuses: a 95% requirement ratio but a strict score of zero. This illustrates why a high per-task rubric ratio need not imply a passing answer.

The Judge's rationale is not independent ground truth. For example, its criticism of the five-high straight in hand `#2535200281` overlooks Player_01's hole-card Ace: the retrieved log explicitly shows `[As Ts]` and the five-card straight `[5s 4s 3d 2d As]`. Separately, source rubric 19 denies the presence of a turn flush draw despite listing a two-spade turn board and Hero's two-spade hand; rubrics 30 and 37 give conflicting improvement/standard-play guidance for the same KK hand. These are concrete reasons to inspect source rubrics and Judge decisions rather than attribute every zero solely to OpenContext.

This example is an illustrative spot check, not an audit of all 405 tasks. No rubric was edited and no published aggregate was adjusted on the basis of this inspection.

## 8. Retrieval evidence and interpretation limits

The AML input artifact retains each task's question, rubrics, metadata, and selected retrieval text with available timestamps. The answer artifact retains the exact assembled prompt and model output. The scoring artifact retains the Judge model, rationale, requirement statuses, ratio, and binary score.

This chain supports inspection of what the Answerer saw and how the Judge scored it. It does not retain full ingest acknowledgements, candidate rankings, fusion/rerank traces, or child-source mappings. The task rubrics are answer requirements, not canonical QA-to-source relevance labels. No Recall@K, Hit@K, Precision@K, MRR, or gold-evidence coverage is claimed.

The low strict pass rate therefore cannot establish that memory retrieval alone failed. Relevant factors include context selection, query-prefix truncation, answer completeness, domain reasoning, all-or-nothing requirements, conditional rubric semantics, provider configuration changes, and Judge reliability. Their individual contributions have not been measured by this run.

## 9. Supporting code changes and handoff

The accompanying local changes support this evaluation:

- Split CL-bench-Life inline history/task records before ingestion and retrieval, with a regression test for both boundaries.
- Add bounded HTTP transport-error retries to the local pipeline shim.
- Add opt-in provider reasoning and default completion-limit settings without replacing explicitly supplied request values.
- Document the provider settings and add a transport-retry regression test.

These changes do not modify the vendored benchmark prompts, rubrics, scoring rules, or OpenContext core chunking/retrieval logic. This report does not claim that the new tests or remote CI passed; those are separate validation steps.

Testing stops at this completed artifact. Before using CL-bench-Life for a formal system comparison, fix the configuration for the entire run, record the exact code/patch and daemon state, use a fresh database without resume, and account for Judge output validity. Source-labeled BEAM and LongMemEval evaluations remain more directly suited to numeric retrieval Recall/Hit optimization; this run is best retained as an end-to-end contextual answering diagnostic.
