# aml-local — Local pre-evaluation for AML (Agent Memory Leaderboard)

Replays the [Agent Memory Leaderboard](https://github.com/AML-memory/agent-memory-leaderboard)
evaluation pipeline locally, with the **OpenContext daemon** (`http://127.0.0.1:7421`)
as the memory backend:

```
dataset -> retrieve.py -> OpenContext (POST /v1/raw-messages ingest, per-sample userId isolation)
                        -> per-question POST /v1/search -> AML-format input.jsonl
        -> official AML pipeline.py answer (generate answers)
        -> official AML pipeline.py evaluate (scoring)
        -> judged.jsonl + aggregate score
```

## Prerequisites

- The OpenContext daemon is running (`curl http://127.0.0.1:7421/health`):

```powershell
cd benchmark\.opencontext-data
$env:LOCAL_EMBEDDING_REMOTE_HOST='https://hf-mirror.com'
node ..\..\packages\opencontext\dist\cli\opencontext.js http --embedding-provider local --memory-backend sqlite-vec
```

- AML pipeline environment (vendored at `benchmark/AML-agent-memory-leaderboard/`):

```powershell
cd benchmark\AML-agent-memory-leaderboard
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
```

- `.env`: `OPENROUTER_API_KEY=...` (both answering and judging go through OpenRouter;
  the answer model defaults to `qwen/qwen3-14b`, matching the AML public pipeline
  default; the judge defaults to `qwen/qwen3.7-plus`)

## Running

```powershell
.\run_aml_local.ps1 -Bench longmemeval -Limit 5          # first 5 LongMemEval-S questions
.\run_aml_local.ps1 -Bench locomo -Samples conv-26       # one LoCoMo conversation (150 QA)
.\run_aml_local.ps1 -Bench clbench -Limit 2              # first 2 CL-bench-Life tasks
.\run_aml_local.ps1 -Bench beam -Limit 1                 # BEAM sample conversation
.\run_aml_local.ps1 -Bench personamem -Limit 1 -MaxQuestions 5                  # PersonaMem-v2: 1 persona, 5 questions (MCQ)
.\run_aml_local.ps1 -Bench personamem -Limit 1 -MaxQuestions 5 -Mode generative # PersonaMem-v2 generative + narrow judge
.\run_aml_local.ps1 -Bench scriptmem -MaxQuestions 5                            # ScriptMem: first 5 QA per script
```

All six AML textual benchmarks (`beam`, `clbench`, `locomo-refined`, `longmemeval-s`,
`personamem`, `scriptmem`) are covered.

Common flags: `-Limit N` (number of samples; for personamem = number of personas),
`-MaxQuestions N` (cap questions per sample/persona), `-SkipIngest` (reuse
already-ingested memories, re-retrieve only), `-Dataset beam_1m.json` (switch BEAM
dataset), `-Mode mcq|generative` (personamem only, default mcq).

PersonaMem-v2 reads `benchmark/personamem-v2/dataset/benchmark.csv` plus the
per-persona 32k chat histories — fetch them with
`python benchmark/personamem-v2/dataset/download.py --max-personas 5`. Each
persona's history is ingested once (per-persona userId isolation), then each
question retrieves top-k memories which are injected as the `chat_history` system
context consumed by the official AML `data/personamem/pipeline_v2.py`.

ScriptMem reads `benchmark/scriptmem/dataset/raw/{angry,enemy,friends,man_earth}.json`
— fetch them with `python benchmark/scriptmem/dataset/download.py`. Note: upstream
ScriptMem (CC BY-NC 4.0) does **not** publish the original script text; the
`conversation` field only carries a synthetic schema example, and the AML platform
holds the private conversations. The local run therefore validates the full
Add/Search → answer → `convert-jsonl-answers` → official `evaluate` chain, but the
accuracy numbers are not meaningful locally (there is almost nothing to retrieve).
The evaluate step scores all 457 gold questions; unanswered ones count as wrong,
so use `-MaxQuestions` only for smoke tests and compare on full runs.

Artifacts land in `outputs/<bench>/`: `input.jsonl` (retrieval results),
`answers.jsonl` (generated answers), `judged.jsonl` (scoring details).

## Local smoke baselines (2026-08-18, daemon: sqlite-vec + local embeddings)

| Benchmark | Sample | Score |
|---|---|---|
| longmemeval-s | first 5 questions | accuracy 80% (4/5) |
| locomo | conv-26, full 150 QA | accuracy 54% (81/150) |
| clbench | first 2 CL-bench-Life tasks | solving rate 0/2 (requirement ratio 0.925, all-or-nothing scoring) |
| beam | sample, 1 question | llm_judge_score 1.0000 |
| personamem | persona 521, first 3 questions | mcq accuracy 33% (1/3); generative narrow-judge mean 1.0000 (first 2) |
| scriptmem | first 3 QA per script (12/457) | chain OK (qa_id matching exact, 0 extra predictions); accuracy not meaningful locally — upstream publishes no conversation text |

Note: locally we use the public datasets (locomo_v2 / CL-bench-Life / beam sample /
PersonaMem-v2 public CSV + 32k histories), which differ from AML's refined private
datasets on the leaderboard. These numbers are for development iteration only and
are not leaderboard-comparable. Official scores are produced by the platform after
you apply at agentmemories.ai.

## Enhanced retrieval (AI multi-step reasoning)

The daemon can run `/v1/search` through OpenContext's reasoning layer instead of
one-shot hybrid retrieval. Two strategies are available (per request, via
`reasoningStrategy`):

- `rewrite` — an LLM rephrases the question into first-person "user voice"
  variants before embedding (helps when memories are chat logs)
- `iterative` — an LLM planner drives **multi-step retrieval**: search → note
  evidence → search again (up to `OPENCONTEXT_LLM_REASONING_MAX_ITERATIONS`,
  default 4), which helps on multi-hop / implicit-preference questions

Both degrade gracefully to the baseline hybrid search (BM25 + vector + RRF)
when the LLM call fails. No code changes are needed — the CLI wires the
providers automatically when an LLM key is present. Start the daemon with:

```powershell
cd benchmark\.opencontext-data
$env:LOCAL_EMBEDDING_REMOTE_HOST='https://hf-mirror.com'
$env:OPENCONTEXT_LLM_API_KEY=$env:OPENROUTER_API_KEY          # any OpenAI-compatible key
$env:OPENCONTEXT_LLM_BASE_URL='https://openrouter.ai/api/v1'  # this is the default
$env:OPENCONTEXT_LLM_MODEL='qwen/qwen3-14b'                   # reasoning model (planner/rewriter); any cheap chat model works
node ..\..\packages\opencontext\dist\cli\opencontext.js http --embedding-provider local --memory-backend sqlite-vec
# expect in the log: reasoning wired (model=...; request reasoningStrategy=rewrite|iterative to use it)
```

Then run with `-Reasoning` (forwarded as `reasoningStrategy` on every search)
and `-Tag` (writes to `outputs-<tag>/` so the baseline `outputs/` stays intact):

```powershell
# smoke: 1 persona, 5 questions, iterative multi-step retrieval
.\run_aml_local.ps1 -Bench personamem -Limit 1 -MaxQuestions 5 -Reasoning iterative -Tag iterative -SkipIngest

# full personamem retrieval with parallel workers (search is per-question
# independent; workers only affect wall-clock):
$env:AML_REASONING_STRATEGY='iterative'
$env:AML_OUT_DIR="$PWD\outputs-iterative"
$env:AML_RETRIEVE_WORKERS='8'
python retrieve.py personamem --skip-ingest
```

Reasoning retrieval costs extra LLM calls (rewrite: 1 per question; iterative:
up to maxIterations per question), so full 5,000-question runs should use
`-SkipIngest` (memories are already embedded) and `AML_RETRIEVE_WORKERS`.
A reranker plug-in exists in the SDK (`unified.reranker`) but is not wired by
the CLI; consolidation (`/v1/consolidate:apply`) is a separate write-side
endpoint not used by these benchmarks.

## serve.py — AML Add/Search adapter (for official submission)

Implements the [AML API Guide](https://agentmemories.ai/api-guide) contract and
forwards the platform's Add/Search calls to the OpenContext daemon:

```
AML platform -> POST /add    {request_id, messages[], user_id, session_id}
                          -> daemon /v1/raw-messages (embedOnInsert; returns 200 only once stored)
             -> POST /search {query, options?, user_id, top_k}
                          -> daemon /v1/search (user_id passed through as the OpenContext userId,
                             so samples stay isolated by construction)
             -> GET  /health
```

Key properties:
- **Idempotent**: the OpenContext messageId is derived from `request_id`, so platform
  retries of the same Add request never create duplicate memories
- **Synchronously searchable**: Add returns only after embeddings are stored,
  satisfying the contract's "200 means searchable" requirement
- **Dual-key auth**: two distinct keys are supported —
  `AML_SYSTEM_KEY` (the Memory System Key you generate and share with the platform;
  accepted as `Authorization: Bearer <key>` or `X-Api-Key: <key>`) and
  `AML_EVAL_KEY` (the Eval Key the platform issues to you after approval; accepted
  as `X-Eval-Key: <key>` — adjust `EVAL_KEY_HEADERS` at the top of `serve.py` if the
  platform's real header differs). With both unset, auth is off (local testing only)
- **Retry semantics**: 4xx responses are marked non-retriable; transient upstream
  failures return 502/500 with `retriable: true` and a `Retry-After` header,
  matching the AML retry contract (Add: 408/409/425/429/5xx, Search: 408/425/429/5xx)
- **gpt-4o-mini constraint**: this chain calls no LLM at all (local ONNX embeddings),
  so it is compliant by construction

Run:

```powershell
$env:AML_SYSTEM_KEY='a-strong-random-key-you-generate'   # optional for local testing
$env:AML_EVAL_KEY='<issued-by-platform-after-approval>'  # optional until then
python serve.py                                          # listens on :7422 (override via AML_ADAPTER_PORT)
```

For the official evaluation this service must be publicly reachable — see
[DEPLOY.md](./DEPLOY.md) for the Docker image, three exposure options
(Cloudflare Tunnel / fly.io / VPS+Caddy) and the 30-day stability checklist,
and [SUBMISSION.md](./SUBMISSION.md) for the application materials
(system name, method description, attribution, Run Label).

Contract artifacts:

- `contract/*.schema.json` — JSON Schemas for the Add/Search request bodies and
  the Add/Search/Health response bodies
- `fixtures/*.example.json` — one example payload per schema
- `python test_contract.py` — offline schema validation of every fixture;
  `python test_contract.py --live http://127.0.0.1:7422` additionally round-trips
  the fixtures against a running adapter (use before applying, and again after
  the Eval Key smoke test)

## Running the vendored AML pipelines unmodified

The published AML pipelines pass plain `open()` file objects into `async with`
(unsupported by CPython). Instead of patching the vendored files,
`run_pipeline.py` patches `pathlib.Path.open` at runtime (write/append handles
gain the async context-manager protocol) and then executes the target pipeline —
answering/scoring logic and the vendored repo stay untouched:

```powershell
python run_pipeline.py ..\AML-agent-memory-leaderboard\data\personamem\pipeline_v2.py answer --input in.jsonl --output out.jsonl --mode mcq
```

`run_aml_local.ps1` routes every pipeline invocation through this shim, so
`benchmark/AML-agent-memory-leaderboard/` requires no local modifications.
