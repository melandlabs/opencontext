# Local AML-style evaluation driver for OpenContext.
#
# Plays the AML orchestrator locally:
#   1. retrieve.py  — ingest dataset into the OpenContext daemon (:7421), search per question,
#                     emit AML-compatible input JSONL under aml-local/outputs/<bench>/
#   2. AML pipeline answer    — benchmark/AML-agent-memory-leaderboard/data/<bench>/pipeline.py
#   3. AML pipeline evaluate  — same file
#
# Usage (from benchmark/aml-local):
#   .\run_aml_local.ps1 -Bench longmemeval -Limit 5
#   .\run_aml_local.ps1 -Bench locomo -Samples conv-26
#   .\run_aml_local.ps1 -Bench clbench -Limit 2
#   .\run_aml_local.ps1 -Bench beam -Limit 1
param(
  [Parameter(Mandatory=$true)][ValidateSet("longmemeval","locomo","clbench","beam")][string]$Bench,
  [int]$Limit = 0,
  [string]$Samples = "",
  [string]$Dataset = "sample_conversation.json",
  [switch]$SkipIngest,
  [int]$MaxQuestions = 0,
  [string]$AnswerModel = "qwen/qwen3-14b",
  [string]$JudgeModel = "qwen/qwen3.7-plus"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$amlRepo = Join-Path $here "..\AML-agent-memory-leaderboard"
$python = Join-Path $amlRepo ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "AML venv missing: $python (run: uv venv .venv; uv pip install -r requirements.txt in the AML repo dir)" }

# load .env (OPENROUTER_API_KEY etc.)
$envFile = Join-Path $here ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $k, $v = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
  }
}
if (-not $env:OPENROUTER_API_KEY) { throw "OPENROUTER_API_KEY missing — put it in $envFile" }

# AML api_config.py env surface
$env:ANSWER_API_BASE = "https://openrouter.ai/api/v1"
$env:ANSWER_API_KEY  = $env:OPENROUTER_API_KEY
$env:ANSWER_MODEL    = $AnswerModel
$env:JUDGE_API_BASE  = "https://openrouter.ai/api/v1"
$env:JUDGE_API_KEY   = $env:OPENROUTER_API_KEY
$env:JUDGE_MODEL     = $JudgeModel

$dataDir = @{ longmemeval = "longmemeval-s"; locomo = "locomo-refined"; clbench = "clbench"; beam = "beam" }[$Bench]
$outDir  = Join-Path $here "outputs\$dataDir"
$input   = Join-Path $outDir "input.jsonl"
$answers = Join-Path $outDir "answers.jsonl"
$judged  = Join-Path $outDir "judged.jsonl"
$pipeline = Join-Path $amlRepo "data\$dataDir\pipeline.py"

Write-Host "=== [1/3] retrieve ($Bench) ==="
$retrieveArgs = @((Join-Path $here "retrieve.py"), $Bench)
if ($Limit -gt 0)   { $retrieveArgs += @("--limit", $Limit) }
if ($Samples)       { $retrieveArgs += @("--samples", $Samples) }
if ($Bench -eq "beam") { $retrieveArgs += @("--dataset", $Dataset) }
if ($SkipIngest)    { $retrieveArgs += "--skip-ingest" }
if ($MaxQuestions -gt 0) { $retrieveArgs += @("--max-questions", $MaxQuestions) }
& $python @retrieveArgs
if ($LASTEXITCODE -ne 0) { throw "retrieve failed" }

Write-Host "=== [2/3] answer ($AnswerModel) ==="
if (Test-Path $answers) { Remove-Item $answers -Force }
& $python $pipeline answer --input $input --output $answers
if ($LASTEXITCODE -ne 0) { throw "answer failed" }

Write-Host "=== [3/3] evaluate ($JudgeModel) ==="
& $python $pipeline evaluate --input $input --answers $answers --output $judged
if ($LASTEXITCODE -ne 0) { throw "evaluate failed" }

# ---- summary ----
$rows = Get-Content $judged | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
$total = $rows.Count
if ($Bench -in @("longmemeval","locomo")) {
  $ok = ($rows | Where-Object { $_.is_correct }).Count
  Write-Host ("`n>>> {0}: accuracy = {1:P2} ({2}/{3})" -f $Bench, ($ok / $total), $ok, $total)
} elseif ($Bench -eq "clbench") {
  $sum = ($rows | Measure-Object -Property rubric_clbench_score -Sum).Sum
  Write-Host ("`n>>> clbench: solving rate = {0:P2} ({1}/{2})" -f ($sum / $total), $sum, $total)
} else {
  $mean = ($rows | Measure-Object -Property llm_judge_score -Average).Average
  Write-Host ("`n>>> beam: llm_judge_score mean = {0:N4} over {1} questions" -f $mean, $total)
}
Write-Host "judged: $judged"
