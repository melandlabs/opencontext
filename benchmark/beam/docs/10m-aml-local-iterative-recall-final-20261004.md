# BEAM 10M: pinned-provider iterative-union final report

## Result and comparison

The complete iterative-union run scored **0.2844167 over 200 questions**, compared with **0.2462462** for the complete query-rewrite run. The difference is **+0.0381705**, not a demonstrated score above 0.5. Both runs completed 200 retrievals, 200 answers and 200 judgements; neither result treats failed questions as zero.

| Measure | Query rewrite | Iterative union |
| --- | ---: | ---: |
| Mean official judge score | 0.2462 | 0.2844 |
| Perfect / partial / zero scores | 42 / 22 / 136 | 50 / 19 / 131 |
| Mean annotated-source Recall@12, 176 questions | 0.3423 | 0.3451 |
| Questions with all annotated sources / no annotated source | 36 / 77 | 38 / 81 |
| Degraded reasoning traces | 4 | 136 |
| Reranker-enabled traces | 200 | 200 |

The score is a mean rubric score, **not a binary pass rate**. Perfect-score frequency is 25% for iterative union. Across the same 200 questions, 29 scores improved, 28 worsened and 143 were unchanged. Annotated-source recall improved on four questions, worsened on six and was unchanged on 166.

Most of the aggregate score gain came from abstention: 0.45 to 0.80 contributes 0.0350 to the overall mean. Excluding abstention, the remaining 180 questions averaged approximately **0.2236 versus 0.2271**. This is not evidence of a large general memory-reasoning improvement.

## Frozen experiment identity

- Branch: `experiment/beam10m-iterative-recall`; frozen run commit: `897656dce67cd44aadc4d46e4446098529bff4d9`.
- Tag: `beam10m-pinned-union-hybrid-rrf-20261003`; finished on 2026-10-04.
- Artifact directory: `D:/opencontext-iterative-recall/benchmark/aml-local/outputs-beam10m-pinned-union-hybrid-rrf-20261003/beam`.
- Dataset SHA256, independently verified after completion: `f80b3ca1236c6933300cd89cc65f1062535b18ca86c733eb34a73309e8439978`. The generated run manifest itself has a null dataset hash; this independent hash must not be described as a manifest field.
- Reused ingestion database: `beam10m-retrieval-experiments-20261001.db`, with 39,920 committed Add batches and 416,437 embedded search children. Individual messages remain separate parents; Add batching does not create a twenty-turn parent message.
- Planner and answer model: `deepseek/deepseek-v4-flash-0731`, pinned to **OpenInference**, reasoning disabled.
- Rubric judge and event-equivalence model: `qwen/qwen3.8-flash`, pinned to **Alibaba**, reasoning disabled. Provider fallbacks were disabled.
- Embedding: `Xenova/all-MiniLM-L6-v2`, fp32. Local reranker: `Xenova/ms-marco-MiniLM-L-6-v2`, q8, batch size eight, 512-token pair limit.
- Top-12 is the user's local override of the public Top-100 setting. This resumed, reused-database experiment is a local diagnostic comparison, not a fresh official leaderboard submission.

The vendored official question rendering, judge prompts, rubric parser and event metrics were used without experiment-specific changes. The three repaired core defects are shared with the rewrite branch: monotonic BM25 relevance conversion, preservation of partial vector results with bounded user-scoped fallback, and preservation of multiple matched spans during parent fusion. The fourth issue, reranker input truncation and context-window construction, remains deferred.

## Runtime and provider verification

All 200 successful answer responses reported OpenInference. All 590 successful judge subrequests reported Alibaba. There were zero successful-provider mismatches. One answer attempt (`10m_4_q_12`) reached the initial 512-token limit; two rubric attempts (`10m_2_q_5`, `10m_5_q_5`) reached the initial 1,024-token limit. Bounded recovery completed all three questions. No questions remained pending.

For the 200 successful answers, native provider usage reported mean input **8,392 tokens**, median **8,313**, nearest-rank P95 **12,360**, maximum **14,821**; mean output **41.2**, maximum **276**, and zero reasoning tokens. These are provider-reported units, not the ingestion chunker's estimated tokens. Planner routing was enforced in the core callback, but planner calls do not have the same per-request audit artifact as answer/judge calls; the 136 degraded traces cannot be attributed to a particular failure cause from the existing trace alone.

The manifest's approximately 47-minute wall time covers the final resumed invocation, not the entire experiment across pauses. Event-equivalence requests explain why one event-ordering question can remain active for minutes while its request count increases; that alone does not establish an infinite retry loop.

## Categories

Each category contains twenty scored questions. Abstention has no source annotations; summarization has sixteen annotated questions, and the other categories have twenty.

| Category | Rewrite score | Union score | Union source Recall@12 |
| --- | ---: | ---: | ---: |
| Abstention | 0.4500 | 0.8000 | N/A |
| Information extraction | 0.5500 | 0.6500 | 0.7500 |
| Knowledge update | 0.5000 | 0.5500 | 0.6858 |
| Preference following | 0.4375 | 0.3750 | 0.2583 |
| Instruction following | 0.3125 | 0.2875 | 0.1250 |
| Contradiction resolution | 0.0438 | 0.0563 | 0.5888 |
| Multi-session reasoning | 0.0750 | 0.0500 | 0.3433 |
| Summarization | 0.0092 | 0.0400 | 0.0238 |
| Temporal reasoning | 0.0250 | 0.0250 | 0.2542 |
| Event ordering | 0.0595 | 0.0104 | 0.0124 |

Event ordering did not improve: nineteen questions scored zero and one had a partial score. Temporal reasoning remained poor. A higher overall score must not be presented as improvement in these categories.

## Evidence chain and ranking ablations

| Stage, 176 annotated questions | Mean source recall | Any required source | All required sources |
| --- | ---: | ---: | ---: |
| Available in the indexed corpus | 1.0000 | 176 | 176 |
| Candidate-channel union | 0.4723 | 126 | 58 |
| Fused candidate pool before reranking | 0.4125 | 113 | 48 |
| Final Top-12 | 0.3451 | 95 | 38 |

All required source turns existed in the indexed corpus. Thirteen questions lost their last annotated source at fusion and eighteen more at final ranking/truncation. The keyword candidate channel had mean source recall 0.3165, semantic candidates 0.3839, and planner evidence 0.1858. Entity candidates were zero: `entitySearch` is an unwired optional host dependency, not an environment switch. Insights/knowledge were not populated or searched in this raw-message experiment.

At the same Top-12 budget, keyword order achieved source recall **0.2258**, semantic order **0.2637**, fused order **0.2998**, and final reranked order **0.3451**. Thus the aggregate evidence does not support disabling the reranker. There were 737 final hits with multiple matched spans, and four final hits used exact user-scoped vector fallback. These counts demonstrate executed paths, not proof that every answer-bearing sentence was shown.

The canonical JavaScript RRF counterfactual replayed all 200 traces with zero ranking mismatches. For 176 annotated questions, pre-rerank Recall@12 was **0.29983 with planner evidence versus 0.30129 without it**. This isolates channel fusion only, not final reranking or QA. The Python approximation differs on three tie-breaks and is not substituted for this exact replay. A later shared repair prevents source-chunk ID array mutation during fusion; the frozen run predates it, so exact per-channel child attribution needs that caveat.

Source-turn IDs establish parent retrieval, not visibility or use of the correct child span. This distinction remains necessary even with complete trace files.

## Cases that distinguish retrieval from answer failure

- `10m_9_q_6`: the album source was returned at rank one. The union answer correctly said **50 pages, $75**, whereas the rewrite answer addressed a historical photo-selection question.
- `10m_9_q_13`: both annotated sources were returned at ranks one and six, but the answer still said the combined island duration could not be determined. The visible excerpts allocate 1.5 and 2 hours, supporting 3.5 hours. Retrieval alone did not fix answer interpretation.
- `10m_1_q_3`: both annotated sources occupied ranks one and two, yet the answer was only **"No."** and received zero. The rubric asks for an explained contradiction/clarification. The source statements also warrant the ambiguity caution documented in the rewrite report.
- `10m_3_q_19`: source recall increased from 0.5 to 1.0, but the answer was **0** and received zero. The retrieved text gives testing on January 21 and deployment setup on February 1, 2025. That is eleven elapsed days or twelve dates counted inclusively; the rubric requires twelve. This is an interpretation and rubric-convention issue, not justification for hardcoding a gold number.

## Completed core follow-up ablations

All use the same fixed twenty IDs: two per category selected by lowest SHA256 of question ID, independently of answers and rubrics. They use the same Flash models and fixed providers and keep official prompts unchanged. Small-subset scores are not substitutes for a full 200-question confirmation.

1. **Structured planner chat roles:** the existing core fix preserves actual system/user/assistant roles instead of placing a flattened transcript into one user message. The matched subset scored **0.2500 versus 0.2250** in the frozen flat-history union run: two improvements, one regression and seventeen unchanged. Twelve traces were still degraded. A real-CLI protocol smoke completed search -> note -> finish. This supports the transport correction, but not a large or statistically established full-run gain.
2. **Wider fused rerank window:** actual frozen and modified core implementations were replayed on identical candidates. Baseline Top-12 IDs and full answer contexts were reconstructed exactly for all twenty questions. Increasing the pre-rerank window from 48 to approximately 70-101 candidates changed annotated-source recall **0.3750 to 0.3630** and QA **0.2250 to 0.2188**. Two scores improved, one worsened and seventeen were unchanged. The wider default was withdrawn; the compiled prototype and manifests remain in ignored local artifacts.
3. **Deduplicate lexical terms before the sixteen-term cap:** a minimal core change preserves Unicode, numbers, negation terms and first-occurrence order; it adds no dataset-specific stopword rules. Original FTS5 order/content and original final contexts were verified against the frozen run. The semantic and planner candidates, fusion window, local reranker and Top-12 were held fixed. All eighteen annotated questions retained identical source recall, mean **0.3750**. QA was **0.2438 versus 0.2250**, but all gain came from two questions whose full retrieved contexts were byte-for-byte unchanged. Four questions had changed contexts; their scores did not change. Therefore **no answer-score gain is attributed to keyword deduplication**. Twenty answer calls reported OpenInference and fifty successful judge calls reported Alibaba.
4. **Remaining-action budget hints:** a core-only prompt prototype was compared with a fresh control using the same structured roles, lexical deduplication, four-action limit and fixed twenty question IDs. Both completed all retrievals, answers and judgements. Degraded/no-note traces fell from **11 to 1**, with zero completion errors in both runs; planner-channel source recall rose from **0.1389 to 0.2454**. However, final source Recall@12 remained **0.3750 on every paired annotated question**, and QA fell from **0.25625 to 0.18125**: one improvement, two regressions and seventeen unchanged. Seventeen full answer contexts changed; the three unchanged contexts had unchanged scores. The regressions were `10m_2_q_15` and `10m_5_q_10`, each 1.0 to 0.0; `10m_4_q_8` improved from 0.0 to 0.5. Twenty answer calls reported OpenInference and fifty successful judge subrequests reported Alibaba, with no failed attempts or provider mismatches. **The default budget hints were withdrawn.** Improved protocol compliance alone does not demonstrate better answers; this negative subset result does not establish the size of a full-run regression.

The budget prototype was frozen at commit `8b8bfa9b3217d9cd097cf6650d2b084a410d9a18`; its CLI bundle SHA256 was `409ee6983150e9bc21169edbb267003de1ac76e177feb2ba2d18119bae1e665b`. The compiled CLI and manifest remain in ignored local artifacts under `outputs-beam10m-planner-budget-ablation-20261004`. The later source withdrawal does not alter its completed artifacts. The opt-in bounded action ledger remains, with a regression test confirming that enabling diagnostics does not change planner prompts or selected evidence.

The lexical replay initially used Node's bundled SQLite 3.51.2, which chose a slow user-first nested FTS scan. It was restarted, before producing a scored result, with the actual production `better-sqlite3` driver, SQLite 3.53.4. Both corpus and SQL were unchanged. Four previously unseen parent IDs were mapped with the unchanged adapter's `beam_source_ids` helper; no sequence-number-to-source-ID guess was used.

## Next optimization priorities

1. Establish **why iterative planning degraded**, especially the 100 traces with four iterations, five fallback candidates and a degraded marker. The frozen full-run records do not distinguish unparseable actions, request failures and failure to commit evidence. A later opt-in core action ledger was exercised on the same twenty selected questions with structured roles and deduplicated lexical terms: eleven degraded because no evidence was noted, zero completion requests failed, and only one action was unparseable. This fresh diagnostic does not retroactively establish the cause of all 136 frozen-run degradations. The completed budget-awareness ablation above shows that reducing this degradation marker is not sufficient: prioritise useful new evidence and its survival through final ranking, rather than only increasing the number of note actions.
2. Improve coverage for broad questions through general, evidence-linked retrieval or summary capabilities. Event questions require a mean of 37.95 annotated turns; nineteen require more than twelve. The ideal Top-12 parent-source recall ceiling averages 0.4314, not a QA ceiling. Raw parent retrieval alone is an unsuitable basis for claiming complete timeline coverage.
3. Address answer interpretation where exact text is already visible. The failed context-quoting diagnostic in the rewrite report shows that a plausible formatting change cannot simply be assumed beneficial. Any replacement belongs in core evidence presentation and needs its own matched experiment.
4. Keep the useful core correctness repairs, provider checks and complete evidence traces. Reject unproved ranking changes and distinguish replay/subset diagnostics from full-run results. The deferred cross-encoder truncation issue remains explicitly outside this round.

## Final code and handoff state

The shared post-run correctness fixes and diagnostics were synchronized to both experiment branches after preserving the frozen iterative CLI and search bundle. Default wider reranking and planner-budget hints are absent. Structured planner chat transport, immutable matched-evidence provenance, lexical-term deduplication and opt-in action diagnostics remain. The two original complete scores belong to their frozen run commits, **not to a new complete evaluation of these later changes**.

Scoped verification covered 109 TypeScript tests across retrieval, provenance, CLI reasoning transport and SQLite child retrieval, 24 Python adapter/analysis/ablation tests, and three native replay tests. Both worktrees' memory-store and opencontext packages built successfully and passed their relevant type checks. The initial iterative-worktree opencontext type check saw a stale dependency declaration; rebuilding memory-store regenerated its exported types, after which the check passed. No full CI suite was run.

All test stages finished. The test-owned core and adapter services were stopped; corpus databases, checkpoints, provider logs and frozen experiment bundles remain in ignored local artifacts. Both local experiment branches contain the same final shared source repairs and these two English reports. A score above 0.5 was not demonstrated, and no default ranking/prompt change is presented as an established score gain. Further work should target the coverage and answer-interpretation gaps above rather than continue tuning this small subset.

Only the rewrite and iterative final reports are retained for these experiments. No experiment code, report or artifact has been pushed.

## Subsequent optimization continuation

The user subsequently made a complete score **above 0.5** an explicit completion requirement. The optimization goal is active again; the completed comparisons above are evidence, not satisfaction of that new gate.

A new opt-in core experiment performs query-conditioned **verbatim evidence selection after Top-12 ranking**. It does not change candidate retrieval, cross-encoder inputs, ranking, source IDs, official question/judge prompts or the persisted corpus. Each passage must match a unique substring of an original retrieved span; its UTF-16 offsets and original evidence remain available for audit. Unknown sources, invented/paraphrased passages, malformed output and oversized requests retain the original evidence instead. This is an unproven prototype, not an enabled default or a demonstrated score gain.

The first matched experiment replays the fresh twenty-question diagnostic control, verifies every original full answer context exactly, then changes only the core-produced excerpts. Selection calls are pinned to DeepSeek Flash/OpenInference with reasoning disabled; normal answer and judge stages use the existing pinned providers. The experiment is running under `outputs-beam10m-extractive-evidence-ablation-20261004`. Small-subset results, including any score above 0.5, will not satisfy the complete-200-question gate.

A separate numerical audit found 299 keyword candidate scores rounded to 1 across the original two-hundred-question rewrite traces. This is a precision risk, but the single lexical channel uses stable sorting and preserves database order on ties; it is **not established as a cause of the current failures**. No new BM25 score change was enabled on the strength of this count alone.
