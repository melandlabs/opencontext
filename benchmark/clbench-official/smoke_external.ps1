# smoke_external.ps1
# Smoke-test the official CL-bench pipeline with EXTERNAL models on the
# OpenRouter API (NOT opencontext). Goal: produce a small baseline we can
# compare against the opencontext agent run on the same N samples.
#
# Workflow:
#   1. Take the first N samples of CL-bench-Life.jsonl.
#   2. For each external model: run infer.py (resumes into its own jsonl).
#   3. Run eval.py on each jsonl using the same qwen judge.
#   4. Print a side-by-side score table.
#
# Env overrides:
#   $env:SAMPLES                 - number of samples (default 10)
#   $env:EXTERNAL_MODELS         - comma-separated OpenRouter model IDs
#                                  (default "deepseek/deepseek-chat,anthropic/claude-3.5-sonnet")
#   $env:JUDGE_MODEL             - judge model (default "qwen/qwen3.7-plus")
#   $env:OPENROUTER_API_KEY      - falls back to .env in this dir
param(
  [int]$Samples = $(if ($env:SAMPLES) { [int]$env:SAMPLES } else { 10 }),
  [string]$Models = $(if ($env:EXTERNAL_MODELS) { $env:EXTERNAL_MODELS } else { "deepseek/deepseek-chat,anthropic/claude-3.5-sonnet" }),
  [string]$Judge = $(if ($env:JUDGE_MODEL) { $env:JUDGE_MODEL } else { "qwen/qwen3.7-plus" })
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptDir

# Resolve OpenRouter key
$OpenRouterKey = $env:OPENROUTER_API_KEY
if (-not $OpenRouterKey) {
  $EnvFile = Join-Path $ScriptDir ".env"
  if (Test-Path -LiteralPath $EnvFile) {
    $OpenRouterKey = (Get-Content -LiteralPath $EnvFile | Select-String -Pattern '^OPENROUTER_API_KEY=').ToString().Split('=', 2)[1].Trim()
  }
}
if (-not $OpenRouterKey) {
  throw "OPENROUTER_API_KEY not found"
}

$Dataset = "CL-bench-Life.jsonl"
if (-not (Test-Path -LiteralPath $Dataset)) { throw "Dataset not found: $Dataset" }

$Results = @()

# Iterate each external model
foreach ($ModelId in ($Models -split ',')) {
  $ModelId = $ModelId.Trim()
  if (-not $ModelId) { continue }

  # Slug: "deepseek/deepseek-chat" -> "deepseek-deepseek-chat"
  $Slug = ($ModelId -replace '[/\\]', '-')
  $InferOut = "outputs/smoke-${Slug}.jsonl"
  $EvalOut  = "outputs/smoke-${Slug}-graded.jsonl"

  Write-Host ""
  Write-Host "=========================================="
  Write-Host "Model: $ModelId"
  Write-Host "Infer output: $InferOut"
  Write-Host "Eval  output: $EvalOut"
  Write-Host "=========================================="

  # -------- infer --------
  # Always start from a clean slate for smoke runs so a stale partial
  # output from a previous run with a different --max-samples cannot
  # silently short-circuit the new run.
  if (Test-Path -LiteralPath $InferOut) {
    Remove-Item -LiteralPath $InferOut -Force
    Write-Host "Cleared previous infer output: $InferOut"
  }
  if (Test-Path -LiteralPath $EvalOut) {
    Remove-Item -LiteralPath $EvalOut -Force
    Write-Host "Cleared previous eval output:  $EvalOut"
  }
  & python infer.py `
    --model "$ModelId" `
    --input "$Dataset" `
    --output "$InferOut" `
    --base-url "https://openrouter.ai/api/v1" `
    --api-key "$OpenRouterKey" `
    --max-samples $Samples
  if ($LASTEXITCODE -ne 0) { Write-Warning "infer failed for $ModelId, skipping eval"; continue }

  # -------- eval --------
  & python eval.py `
    --input "$InferOut" `
    --output "$EvalOut" `
    --judge-model "$Judge" `
    --base-url "https://openrouter.ai/api/v1" `
    --api-key "$OpenRouterKey" `
    --reasoning-effort "high"
  if ($LASTEXITCODE -ne 0) { Write-Warning "eval failed for $ModelId"; continue }

  # -------- tally --------
  if (Test-Path -LiteralPath $EvalOut) {
    $lines = Get-Content $EvalOut
    $score1 = 0
    foreach ($l in $lines) {
      try {
        $j = $l | ConvertFrom-Json
        if ([int]$j.score -eq 1) { $score1++ }
      } catch {}
    }
    $total = $lines.Count
    $rate = if ($total -gt 0) { [math]::Round($score1 / $total, 4) } else { 0 }
    $Results += [pscustomobject]@{ Model = $ModelId; Pass = $score1; Total = $total; Rate = $rate }
  }
}

# -------- comparison table --------
Write-Host ""
Write-Host "=========================================="
Write-Host "SMOKE COMPARISON (judge: $Judge)"
Write-Host "=========================================="
foreach ($r in $Results) {
  Write-Host ("  {0,-40}  {1}/{2}  ({3:P0})" -f $r.Model, $r.Pass, $r.Total, $r.Rate)
}
Write-Host ""
Write-Host "opencontext baseline: see outputs/opencontext-cl_graded.jsonl (filtered to first $Samples samples)"