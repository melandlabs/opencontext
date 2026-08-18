# clbench-official

This directory mirrors the official [Tencent-Hunyuan/CL-bench](https://github.com/Tencent-Hunyuan/CL-bench)
evaluation pipeline (`infer.py` + `eval.py`) but with two tweaks:

1. **Inference** is routed to your local **openloomi** server via its
   OpenAI-compatible proxy at
   `http://127.0.0.1:<port>/v1/chat/completions`
   (see `apps/web/app/api/ai/v1/chat/completions/route.ts`). The agent runtime
   is invoked transparently.
2. **Grading** still uses `eval.py` unchanged, but with `--judge-model
   qwen/qwen3.7-plus` via OpenRouter instead of `gpt-5.1`. Reasoning effort is
   forced to `high` to match the paper spec for CL-bench-Life.

Everything else — the per-task all-or-nothing 0/1 scoring, the prompt format,
the three-step grading rubric (`Grading Rationale / Requirement Satisfaction
Status / Overall Score`), the JSON-parse retry loop, the per-category stats —
is byte-for-byte the same as the upstream `Tencent-Hunyuan/CL-bench`
release.

This directory ships two inference variants:

- **openloomi** (original): `openloomi_proxy.py` + `run_openloomi_eval.ps1`,
  described below. Output slug `openloomi-cl`.
- **opencontext** (new): `opencontext_proxy.py` + `run_opencontext_eval.ps1`,
  which ingests the context into the local opencontext memory-store daemon
  and answers from retrieved memories. Output slug `opencontext-cl`. See
  **OpenContext variant** below.

## Files

| File                       | Source                                                                   |
| -------------------------- | ------------------------------------------------------------------------ |
| `infer.py`                 | upstream Tencent-Hunyuan/CL-bench, untouched                             |
| `eval.py`                  | upstream Tencent-Hunyuan/CL-bench, untouched                             |
| `CL-bench-Life.jsonl`      | `tencent/CL-bench-Life` on Hugging Face (405 tasks)                      |
| `openloomi_proxy.py`       | local: OpenAI-compat proxy → openloomi server                            |
| `run_openloomi_eval.ps1`   | local: glues `infer.py` to openloomi and `eval.py` to OpenRouter qwen    |
| `opencontext_proxy.py`     | local: OpenAI-compat proxy → opencontext memory daemon                   |
| `run_opencontext_eval.ps1` | local: opencontext variant of the pipeline (slug `opencontext-cl`)       |
| `.env.example`             | local: `OPENROUTER_API_KEY=...` for the judge                            |
| `outputs/`                 | created on first run; holds `<model>.jsonl` and `<model>_graded.jsonl`   |

## Setup

```powershell
cd D:\opencontext\benchmark\clbench-official
Copy-Item .env.example .env
# edit .env to put your real OPENROUTER_API_KEY
```

You also need an openloomi token. The default location the script reads from
is `$env:USERPROFILE\.openloomi\token`; override with `$env:TOKEN_FILE` or
`$env:OPENLOOMI_TOKEN`.

## Smoke test (5 samples)

```powershell
$env:MAX_SAMPLES = 5
powershell -ExecutionPolicy Bypass -File run_openloomi_eval.ps1
```

## Full run (405 samples)

```powershell
powershell -ExecutionPolicy Bypass -File run_openloomi_eval.ps1
```

To resume after an interrupted run:

```powershell
powershell -ExecutionPolicy Bypass -File run_openloomi_eval.ps1    # resumes outputs automatically
```

To re-grade an existing inference output without re-running the agent:

```powershell
$env:SKIP_INFER = 1
powershell -ExecutionPolicy Bypass -File run_openloomi_eval.ps1
```

## OpenContext variant

Same pipeline, but inference goes through `opencontext_proxy.py`: each task's
context messages are ingested into the opencontext memory-store daemon
(`POST /v1/raw-messages`, server-side embedding), the question retrieves
relevant memories (`POST /v1/search`), and an answerer LLM (Anthropic-compatible
endpoint if `ANTHROPIC_AUTH_TOKEN` is set, otherwise OpenRouter) answers using
only the retrieved snippets.

Start the daemon first (from the repo root, after build):

```powershell
node packages/opencontext/dist/cli/opencontext.js http --embedding-provider local --memory-backend sqlite-vec
# or: opencontext http   → serves http://127.0.0.1:7421, no auth
```

Then run — no openloomi token needed:

```powershell
# Smoke test (5 samples)
$env:MAX_SAMPLES = 5
powershell -ExecutionPolicy Bypass -File run_opencontext_eval.ps1

# Full run (405 samples); resumes interrupted inference automatically
powershell -ExecutionPolicy Bypass -File run_opencontext_eval.ps1

# Re-grade without re-running inference
$env:SKIP_INFER = 1
powershell -ExecutionPolicy Bypass -File run_opencontext_eval.ps1
```

Variant-specific knobs (everything else from the **Knobs** table applies):

| Env var           | Default                  | Purpose                                       |
| ----------------- | ------------------------ | --------------------------------------------- |
| `OPENCONTEXT_URL` | `http://127.0.0.1:7421`  | opencontext memory daemon base URL            |
| `PROXY_PORT`      | `3800`                   | Port for the local OpenAI-compat proxy        |

Outputs land in `outputs/opencontext-cl.jsonl` and
`outputs/opencontext-cl_graded.jsonl`.

## Knobs

| Env var           | Default                                | Purpose                                                  |
| ----------------- | -------------------------------------- | -------------------------------------------------------- |
| `PORT`            | `3515`                                 | openloomi port                                           |
| `OPENLOOMI_TOKEN` | (read from file)                       | Bearer token for the OpenAI-compat proxy                 |
| `TOKEN_FILE`      | `$env:USERPROFILE\.openloomi\token`    | Fallback location for the openloomi token                |
| `QWEN_MODEL`      | `qwen/qwen3.7-plus`                    | Judge model name (passed to `--judge-model`)             |
| `QWEN_BASE_URL`   | `https://openrouter.ai/api/v1`         | Judge API base URL                                       |
| `OPENROUTER_KEY`  | (read from `.env`)                     | Judge API key                                            |
| `INPUT_FILE`      | `CL-bench-Life.jsonl`                  | Dataset to evaluate                                      |
| `MAX_SAMPLES`     | (all)                                  | Cap the run for debugging                                |
| `WORKERS`         | `1`                                    | Concurrency for both `infer.py` and `eval.py`            |
| `SKIP_INFER`      | `0`                                    | `1` = skip `infer.py`, reuse existing `outputs/<model>.jsonl` |

## What this differs from the previous `benchmark/clbench_life`

| Aspect                                | `benchmark/clbench_life`         | `clbench-official`                  |
| ------------------------------------- | -------------------------------- | ----------------------------------- |
| Judge model                           | qwen3.7-plus                     | qwen3.7-plus (same)                 |
| Judge API                             | direct OpenRouter fetch          | OpenAI SDK against OpenRouter       |
| Prompt                                | custom English JSON-only prompt  | upstream Tencent prompt (CN, three fields, self-reflection) |
| Scoring granularity                   | per-rubric binary → `every`      | per-task all-or-nothing 0/1 (upstream) |
| API calls per task                    | ~13 (one per rubric)             | 1 (one per task)                    |
| Failure mode                          | any rubric `fetch failed` ⇒ 0    | any judge retry failure ⇒ 0         |
| `infer.py` ↔ `eval.py` separation     | merged into one TypeScript script | yes (matches upstream exactly)      |
| Output format                         | bespoke JSON                     | upstream `*_graded.jsonl`          |
| Per-category statistics               | yes                              | yes (upstream)                      |
| Thinking-trace exclusion              | not enforced                     | implicit (judge scores `model_output` only) |

The new numbers in `outputs/openloomi-cl_graded.jsonl` (or
`outputs/opencontext-cl_graded.jsonl` for the opencontext variant) are directly
comparable to the Tencent CL-bench-Life leaderboard.