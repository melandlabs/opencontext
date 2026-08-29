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
#   .\run_aml_local.ps1 -Bench personamem -Limit 1 -MaxQuestions 5 -Reasoning iterative -Tag iterative  # enhanced retrieval
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
  [string]$JudgeModel = "qwen/qwen3.7-plus",
  # retrieval reasoning strategy forwarded to /v1/search (daemon must be started
  # with OPENCONTEXT_LLM_API_KEY — see README "Enhanced retrieval")
  [ValidateSet("none","rewrite","iterative")][string]$Reasoning = "none",
  # redirect artifacts to outputs-<Tag>/ instead of outputs/ (keeps enhanced
  # runs separate from the baseline results)
  [string]$Tag = ""
)

$startedAt = [DateTimeOffset]::UtcNow
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$amlRepo = Join-Path $here "..\AML-agent-memory-leaderboard"
$python = Join-Path $amlRepo ".venv\Scripts\python.exe"

# load .env (OPENROUTER_API_KEY etc.)
$envFile = Join-Path $here ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $k, $v = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
  }
}

$dataDir = @{ longmemeval = "longmemeval-s"; locomo = "locomo-refined"; clbench = "clbench"; beam = "beam"; personamem = "personamem"; scriptmem = "scriptmem" }[$Bench]
$outRoot = if ($Tag) { "outputs-$Tag" } else { "outputs" }
$outDir  = Join-Path $here "$outRoot\$dataDir"
$env:AML_REASONING_STRATEGY = $Reasoning
$env:AML_OUT_DIR = Join-Path $here $outRoot
$input   = Join-Path $outDir "input.jsonl"
$answers = Join-Path $outDir "answers.jsonl"
$judged  = Join-Path $outDir "judged.jsonl"
$pipelineFile = if ($Bench -eq "personamem") { "pipeline_v2.py" } else { "pipeline.py" }
$pipeline = Join-Path $amlRepo "data\$dataDir\$pipelineFile"
# run pipelines through the runtime shim so the vendored AML repo stays unmodified
$shim = Join-Path $here "run_pipeline.py"
$retrieve = Join-Path $here "retrieve.py"
$datasetPath = switch ($Bench) {
  "longmemeval" { Join-Path $here "..\longmemeval\dataset\longmemeval_s_cleaned.json" }
  "locomo" { Join-Path $here "..\locomo\dataset\locomo_v2.json" }
  "clbench" { Join-Path $here "..\clbench-official\CL-bench-Life.jsonl" }
  "beam" {
    if ([IO.Path]::IsPathRooted($Dataset)) { $Dataset } else { Join-Path $here "..\beam\dataset\$Dataset" }
  }
  "personamem" { Join-Path $here "..\personamem-v2\dataset\benchmark.csv" }
  "scriptmem" { Join-Path $here "..\scriptmem\dataset\raw" }
}

$retrieveArgs = @($retrieve, $Bench)
if ($Limit -gt 0)   { $retrieveArgs += @("--limit", $Limit) }
if ($Samples)       { $retrieveArgs += @("--samples", $Samples) }
if ($Bench -eq "beam") { $retrieveArgs += @("--dataset", $Dataset) }
if ($SkipIngest)    { $retrieveArgs += "--skip-ingest" }
if ($MaxQuestions -gt 0) { $retrieveArgs += @("--max-questions", $MaxQuestions) }

function Test-WritableTarget([string]$TargetPath) {
  $candidate = [IO.Path]::GetFullPath($TargetPath)
  while (-not (Test-Path -LiteralPath $candidate)) {
    $parent = Split-Path -Parent $candidate
    if (-not $parent -or $parent -eq $candidate) { return $false }
    $candidate = $parent
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { return $false }
  $probe = Join-Path $candidate (".opencontext-preflight-{0}.tmp" -f [Guid]::NewGuid())
  try {
    [IO.File]::WriteAllText($probe, "")
    return $true
  } catch {
    return $false
  } finally {
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
  }
}

$preflightErrors = [Collections.Generic.List[string]]::new()
if ($Limit -lt 0) { $preflightErrors.Add("-Limit must be zero or a positive integer") }
if ($MaxQuestions -lt 0) { $preflightErrors.Add("-MaxQuestions must be zero or a positive integer") }
if (-not $env:OPENROUTER_API_KEY) { $preflightErrors.Add("OPENROUTER_API_KEY is missing; set it in the process or $envFile") }
foreach ($requiredFile in @($retrieve, $shim, $pipeline)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    $preflightErrors.Add("required AML file is missing: $requiredFile")
  }
}
if (-not (Test-WritableTarget $env:AML_OUT_DIR)) {
  $preflightErrors.Add("AML output path is not writable: $($env:AML_OUT_DIR)")
}

$topK = 10
if ($env:AML_TOP_K) {
  $parsedTopK = 0
  if (-not [int]::TryParse($env:AML_TOP_K, [ref]$parsedTopK) -or $parsedTopK -lt 1) {
    $preflightErrors.Add("AML_TOP_K must be an integer of at least 1")
    $env:AML_TOP_K = "10"
  } else {
    $topK = $parsedTopK
  }
}

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  $preflightErrors.Add("AML Python interpreter is missing: $python")
  if (-not (Test-Path -LiteralPath $datasetPath)) {
    $preflightErrors.Add("benchmark dataset is missing: $datasetPath")
  }
  $daemonUrl = if ($env:OPENCONTEXT_URL) { $env:OPENCONTEXT_URL.TrimEnd("/") } else { "http://127.0.0.1:7421" }
  try {
    $null = Invoke-WebRequest "$daemonUrl/health" -TimeoutSec 5
  } catch {
    $preflightErrors.Add("OpenContext daemon is unavailable at $daemonUrl")
  }
} else {
  $null = & $python -c "import httpx" 2>&1
  if ($LASTEXITCODE -ne 0) {
    $preflightErrors.Add("AML Python dependency is missing: httpx")
  }
  $retrievePreflight = @(& $python @retrieveArgs --preflight-only 2>&1)
  if ($LASTEXITCODE -ne 0) {
    foreach ($line in $retrievePreflight) {
      $message = "$line".Trim()
      if ($message -and $message -ne "AML retrieval preflight failed:") {
        $preflightErrors.Add($message)
      }
    }
  }
}

if ($preflightErrors.Count -gt 0) {
  $uniqueErrors = $preflightErrors | Select-Object -Unique
  throw "AML benchmark preflight failed:`n$($uniqueErrors | ForEach-Object { "- $_" } | Out-String)"
}

$ErrorActionPreference = "Stop"
# AML api_config.py env surface; only set after every preflight check passed.
$env:ANSWER_API_BASE = "https://openrouter.ai/api/v1"
$env:ANSWER_API_KEY  = $env:OPENROUTER_API_KEY
$env:ANSWER_MODEL    = $AnswerModel
$env:JUDGE_API_BASE  = "https://openrouter.ai/api/v1"
$env:JUDGE_API_KEY   = $env:OPENROUTER_API_KEY
$env:JUDGE_MODEL     = $JudgeModel

Write-Host "=== [1/3] retrieve ($Bench) ==="
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

function Get-DatasetIdentity([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer) {
    $files = @(Get-ChildItem -LiteralPath $item.FullName -File -Recurse)
    $size = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $size) { $size = 0 }
    return [ordered]@{
      path = $item.FullName
      size_bytes = [long]$size
      mtime_ms = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds()
      sha256 = $null
    }
  }
  $hash = if ($item.Length -le 268435456) { (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  return [ordered]@{
    path = $item.FullName
    size_bytes = [long]$item.Length
    mtime_ms = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds()
    sha256 = $hash
  }
}

$finishedAt = [DateTimeOffset]::UtcNow
$gitCommit = $null
try {
  $gitCommit = (& git -C (Join-Path $here "..\..") rev-parse HEAD 2>$null).Trim()
  if (-not $gitCommit) { $gitCommit = $null }
} catch {
  $gitCommit = $null
}
$manifest = [ordered]@{
  schema_version = 1
  benchmark = "aml-local/$Bench"
  git_commit = $gitCommit
  dataset = Get-DatasetIdentity $datasetPath
  answerer_model = $AnswerModel
  judge_model = $JudgeModel
  retrieval = [ordered]@{ strategy = $Reasoning; top_k = $topK }
  resume = $false
  started_at = $startedAt.ToString("o")
  finished_at = $finishedAt.ToString("o")
  wall_clock_ms = [long]($finishedAt - $startedAt).TotalMilliseconds
  token_usage = [ordered]@{ prompt_tokens = $null; completion_tokens = $null; total_tokens = $null }
  parameters = [ordered]@{
    limit = if ($Limit -gt 0) { $Limit } else { $null }
    samples = if ($Samples) { $Samples } else { $null }
    max_questions = if ($MaxQuestions -gt 0) { $MaxQuestions } else { $null }
    mode = if ($Bench -eq "personamem") { $Mode } else { $null }
    skip_ingest = [bool]$SkipIngest
  }
}
$manifestPath = Join-Path $outDir "run-manifest.json"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "manifest: $manifestPath"

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
