# eval_only.ps1
# Run only eval.py on an existing infer output (skips infer entirely).
# Designed to run in parallel with run_openloomi_eval.ps1 — it does not
# touch openloomi, only OpenRouter.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File eval_only.ps1
#
# Override:
#   $env:INPUT_FILE  - default outputs/openloomi-cl.jsonl
#   $env:OUTPUT_FILE - default outputs/openloomi-cl_graded.jsonl

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptDir

$InputFile  = if ($env:INPUT_FILE)  { $env:INPUT_FILE }  else { "outputs/openloomi-cl.jsonl" }
$OutputFile = if ($env:OUTPUT_FILE) { $env:OUTPUT_FILE } else { "outputs/openloomi-cl_graded.jsonl" }
$Workers    = if ($env:WORKERS)     { [int]$env:WORKERS } else { 1 }

$QwenModel   = "qwen/qwen3.7-plus"
$QwenBaseUrl = "https://openrouter.ai/api/v1"

# OpenRouter key: env > .env in this dir > clbench_life .env fallback
$OpenRouterKey = $env:OPENROUTER_KEY
if (-not $OpenRouterKey) {
  $EnvFile = Join-Path $ScriptDir ".env"
  if (Test-Path -LiteralPath $EnvFile) {
    $OpenRouterKey = (Get-Content -LiteralPath $EnvFile | Select-String -Pattern '^OPENROUTER_API_KEY=').ToString().Split('=', 2)[1].Trim()
  }
}
if (-not $OpenRouterKey) {
  $EnvFile = "D:\opencontext\benchmark\clbench_life\.env"
  if (Test-Path -LiteralPath $EnvFile) {
    $OpenRouterKey = (Get-Content -LiteralPath $EnvFile | Select-String -Pattern '^OPENROUTER_API_KEY=').ToString().Split('=', 2)[1].Trim()
  }
}
if (-not $OpenRouterKey) {
  throw "OpenRouter API key not found. Set OPENROUTER_KEY or create .env with OPENROUTER_API_KEY=..."
}

if (-not (Test-Path -LiteralPath $InputFile)) {
  throw "input not found: $InputFile"
}

Write-Output ("[eval-only] input  : $InputFile")
Write-Output ("[eval-only] output : $OutputFile")
Write-Output ("[eval-only] judge  : $QwenModel  @ $QwenBaseUrl  (reasoning=high)")
Write-Output ("[eval-only] workers: $Workers")

$args = @(
  "--input", $InputFile,
  "--output", $OutputFile,
  "--judge-model", $QwenModel,
  "--base-url", $QwenBaseUrl,
  "--api-key", $OpenRouterKey,
  "--workers", "$Workers",
  "--reasoning-effort", "high"
)
python eval.py @args
if ($LASTEXITCODE -ne 0) { throw "eval.py failed" }