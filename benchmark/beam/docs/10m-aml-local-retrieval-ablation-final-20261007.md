# BEAM 10M retrieval architecture ablation report

Date: 2026-10-07

## Scope

All runs used the same 10M BEAM dataset, the existing 384-dimensional MiniLM
index, the local MiniLM cross-encoder reranker, DeepSeek Flash for answers and
Qwen Flash for judging. Reasoning was disabled. No query rewrite, embedding,
chunking or judge-prompt change was mixed into these runs.

## Retrieval-only results

| Arm | Settings | Annotated source recall | Paired change vs baseline | p95 retrieval | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| Baseline | Top-12, default candidate pool, 1:1 RRF | 0.338851 | — | 9.69 s | Keep |
| W1 | Weighted RRF 0.7 dense / 0.3 BM25 | 0.315097 | negative | — | Reject |
| W2 | Weighted RRF 0.5 / 0.5 | 0.338851 | none | — | Same as baseline |
| W3 | Weighted RRF 0.3 dense / 0.7 BM25 | 0.287990 | negative | — | Reject |
| N1 | 12 seeds, session ±1, four protected slots | 0.328110 | negative | — | Reject |
| N2 | 20 seeds, session ±1 | 0.346332 | +0.007481 | 11.33 s | QA regression |
| N3 | 20 seeds, session ±2 | 0.346096 | +0.007245 | 15.38 s | Reject; over latency gate |
| Top-12/c80 | Top-12, candidate pool 80 | 0.341249 | +0.002398 | 13.25 s | Retrieval gain only |
| Top-20/c48 | Top-20, candidate pool 48 | 0.359923 | +0.021071 | 11.06 s | QA regression |
| Top-38/c80 | Top-38, candidate pool 80 | 0.417150 | +0.078299 | 13.36 s | QA regression |

Top-20 improved 11 and worsened 0 of 176 annotated questions. Top-38 improved
34 and worsened 0. This confirms that wider final retrieval improves source-ID
coverage, but source-ID coverage alone does not establish answer-bearing span
visibility or answer quality.

W2 is a uniform 0.5 scaling of both baseline channels, so it preserves the
baseline RRF ordering. For that reason its full Answer/Judge result would be a
duplicate of the baseline; the same applies to W2 combined with N2 versus N2
alone. The complete runs below therefore cover the distinct policies without
spending another 200-question run on an ordering-equivalent configuration.

## Complete Answer/Judge results

| Arm | Answers | Judged | Mean judge score | Paired delta vs baseline | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| Baseline | 200 | 200 | 0.305306 | — | Reference |
| N2 | 200 | 200 | 0.278960 | -0.026346 | Reject |
| Top-20/c48 | 200 | 200 | 0.289167 | -0.016139 (200 paired) | Reject |
| Top-38/c80 | 200 | 200 | 0.282486 | -0.022819 (200 paired) | Reject |
| BGE-M3/1024 control | 200 | 200 | 0.282875 | historical comparison | Reject |
| BGE-M3/1024 changed | 200 | 200 | 0.285295 | historical comparison | Reject |

Top-20 initially hit two transient Alibaba 429 responses and Top-38 initially
hit one; the bounded resume completed all three requests. Their retry history
remains in each run's `judged-errors.jsonl`/request logs, and no failed request
was treated as a zero score.

Per-category mean Judge score (20 questions per category) shows the same risk
on the ordering-sensitive slices:

| Arm | Event ordering | Temporal reasoning | Multi-session reasoning |
| --- | ---: | ---: | ---: |
| Baseline | 0.1001 | 0.0500 | 0.0750 |
| N2 | 0.0883 | 0.0250 | 0.0312 |
| Top-20/c48 | 0.0954 | 0.0250 | 0.0875 |
| Top-38/c80 | 0.0840 | 0.0250 | 0.1625 |

These are Judge scores, not exact answer-accuracy percentages; they are used
to identify regressions by question family.

## Conclusion

The tested retrieval architecture changes are useful diagnostics but do not
pass the end-to-end promotion gate. Weighted RRF does not improve the current 1:1 fusion. Session
neighbor expansion increases source recall but adds noise for the answer model.
Increasing Top-K has the same pattern: Top-38 is the strongest retrieval arm,
yet its answer score is 0.022819 below the matched baseline.

The new branch therefore keeps the existing baseline retrieval policy and does
not enable weighted RRF, session neighbors, Top-20 or Top-38 by default. The
opt-in experiment switches remain available for follow-up work, but are not
activated by the selected baseline. It also carries the local adapter
readiness-timeout fix, which prevents a healthy daemon taking about 5.1 seconds
to answer `/health` from being falsely reported as unavailable by a 5-second
probe.

Future work should target answer-context selection and evidence-span visibility,
not simply widening the source-ID pool. Any future change must be evaluated on
the complete Answer/Judge path with the same provider configuration.
