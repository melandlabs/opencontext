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
#   .\run_aml_local.ps1 -Bench personamem -Limit 1 -MaxQuestions 5              # 1 persona, 5 questions, MCQ mode
#   .\run_aml_local.ps1 -Bench personamem -Limit 1 -MaxQuestions 5 -Mode generative
#   .\run_aml_local.ps1 -Bench scriptmem -MaxQuestions 5                        # ScriptMem: first 5 QA per script
param(
  [Parameter(Mandatory=$true)][ValidateSet("longmemeval","locomo","clbench","beam","personamem","scriptmem")][string]$Bench,
  [int]$Limit = 0,
  [string]$Samples = "",
  [string]$Dataset = "sample_conversation.json",
  [switch]$SkipIngest,
  [int]$MaxQuestions = 0,
  [ValidateSet("mcq","generative")][string]$Mode = "mcq",
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

$dataDir = @{ longmemeval = "longmemeval-s"; locomo = "locomo-refined"; clbench = "clbench"; beam = "beam"; personamem = "personamem"; scriptmem = "scriptmem" }[$Bench]
$outDir  = Join-Path $here "outputs\$dataDir"
$input   = Join-Path $outDir "input.jsonl"
$answers = Join-Path $outDir "answers.jsonl"
$judged  = Join-Path $outDir "judged.jsonl"
$pipelineFile = if ($Bench -eq "personamem") { "pipeline_v2.py" } else { "pipeline.py" }
$pipeline = Join-Path $amlRepo "data\$dataDir\$pipelineFile"
# run pipelines through the runtime shim so the vendored AML repo stays unmodified
$shim = Join-Path $here "run_pipeline.py"

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
if ($Bench -eq "personamem") {
  & $python $shim $pipeline answer --input $input --output $answers --mode $Mode
} else {
  & $python $shim $pipeline answer --input $input --output $answers
}
if ($LASTEXITCODE -ne 0) { throw "answer failed" }

Write-Host "=== [3/3] evaluate ($JudgeModel) ==="
if ($Bench -eq "personamem") {
  if ($Mode -eq "mcq") {
    & $python $shim $pipeline evaluate-mcq --answers $answers --output $judged
  } else {
    & $python $shim $pipeline evaluate-narrow --input $input --answers $answers --output $judged
  }
} elseif ($Bench -eq "scriptmem") {
  $submission = Join-Path $outDir "submission.json"
  $summaryFile = Join-Path $outDir "summary.json"
  $detailsFile = Join-Path $outDir "details.json"
  & $python $shim $pipeline convert-jsonl-answers --answers $answers --output $submission
  if ($LASTEXITCODE -ne 0) { throw "convert-jsonl-answers failed" }
  & $python $shim $pipeline evaluate --data-dir (Join-Path $here "..\scriptmem\dataset\raw") --submission $submission --output $summaryFile --details $detailsFile
} else {
  & $python $shim $pipeline evaluate --input $input --answers $answers --output $judged
}
if ($LASTEXITCODE -ne 0) { throw "evaluate failed" }

# ---- summary ----
if ($Bench -eq "scriptmem") {
  $s = Get-Content (Join-Path $outDir "summary.json") -Raw | ConvertFrom-Json
  Write-Host ("`n>>> scriptmem: accuracy = {0:P2} ({1}/{2}), missing predictions = {3}" -f $s.accuracy, $s.score, $s.count, $s.missing_prediction_count)
  foreach ($d in $s.by_dataset.PSObject.Properties) {
    Write-Host ("    {0,-10} {1:P2} ({2}/{3})" -f $d.Name, $d.Value.accuracy, $d.Value.score, $d.Value.count)
  }
  Write-Host "summary: $(Join-Path $outDir 'summary.json')`ndetails: $(Join-Path $outDir 'details.json')"
  exit 0
}
$rows = @(Get-Content $judged | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
$total = $rows.Count
if ($Bench -in @("longmemeval","locomo")) {
  $ok = @($rows | Where-Object { $_.is_correct }).Count
  Write-Host ("`n>>> {0}: accuracy = {1:P2} ({2}/{3})" -f $Bench, ($ok / $total), $ok, $total)
} elseif ($Bench -eq "clbench") {
  $sum = ($rows | Measure-Object -Property rubric_clbench_score -Sum).Sum
  Write-Host ("`n>>> clbench: solving rate = {0:P2} ({1}/{2})" -f ($sum / $total), $sum, $total)
} elseif ($Bench -eq "personamem") {
  if ($Mode -eq "mcq") {
    $ok = @($rows | Where-Object { $_.is_correct }).Count
    Write-Host ("`n>>> personamem (mcq): accuracy = {0:P2} ({1}/{2})" -f ($ok / $total), $ok, $total)
  } else {
    $mean = ($rows | Measure-Object -Property score -Average).Average
    Write-Host ("`n>>> personamem (generative, narrow judge): score mean = {0:N4} over {1} questions" -f $mean, $total)
  }
} else {
  $mean = ($rows | Measure-Object -Property llm_judge_score -Average).Average
  Write-Host ("`n>>> beam: llm_judge_score mean = {0:N4} over {1} questions" -f $mean, $total)
}
Write-Host "judged: $judged"
