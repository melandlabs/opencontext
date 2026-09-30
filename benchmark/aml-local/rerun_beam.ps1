# Reuse saved retrieval evidence; resume only missing answers and judgements.
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [ValidateRange(1, 131072)][int]$AnswerMaxTokens = 512,
  [ValidateRange(1, 131072)][int]$JudgeMaxTokens = 1024
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$here = $PSScriptRoot
$envFile = Join-Path $here '.env'
if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
  }
}
if (-not $env:OPENROUTER_API_KEY -or -not $env:OPENROUTER_ANSWER_MODEL -or -not $env:OPENROUTER_JUDGE_MODEL) {
  throw 'Missing OPENROUTER_API_KEY, OPENROUTER_ANSWER_MODEL or OPENROUTER_JUDGE_MODEL in .env'
}
$InputPath = (Resolve-Path -LiteralPath $InputPath).Path
$OutputDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDir)
$python = Join-Path $here '..\AML-agent-memory-leaderboard\.venv\Scripts\python.exe'
$pipeline = Join-Path $here '..\AML-agent-memory-leaderboard\data\beam\pipeline.py'
$shim = Join-Path $here 'run_pipeline.py'
foreach ($path in @($python, $pipeline, $shim)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing file: $path" }
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$env:ANSWER_API_BASE = 'https://openrouter.ai/api/v1'
$env:JUDGE_API_BASE = $env:ANSWER_API_BASE
$env:ANSWER_API_KEY = $env:OPENROUTER_API_KEY
$env:JUDGE_API_KEY = $env:OPENROUTER_API_KEY
$env:ANSWER_MODEL = $env:OPENROUTER_ANSWER_MODEL
$env:JUDGE_MODEL = $env:OPENROUTER_JUDGE_MODEL
Write-Host "Models from .env: answer=$env:ANSWER_MODEL judge=$env:JUDGE_MODEL"
Write-Host "Reusing retrieval: $InputPath"
$answers = Join-Path $OutputDir 'answers.jsonl'
$judged = Join-Path $OutputDir 'judged.jsonl'
& $python -u $shim $pipeline answer --input $InputPath --output $answers --max-tokens $AnswerMaxTokens
if ($LASTEXITCODE -notin @(0, 2)) { throw "Answer stage failed; see $OutputDir\answers-runtime.log" }
& $python -u $shim $pipeline evaluate --input $InputPath --answers $answers --output $judged --judge-max-tokens $JudgeMaxTokens
if ($LASTEXITCODE -notin @(0, 2)) { throw "Evaluate stage failed; see $OutputDir\judged-runtime.log" }
$status = Get-Content (Join-Path $OutputDir 'judged-status.json') -Raw | ConvertFrom-Json
Write-Host "Final status=$($status.status); scored=$($status.succeeded)/$($status.total); pending=$($status.pending_ids.Count)"
Write-Host "Mean score on scored questions: $($status.mean_score_on_scored_questions)"
Write-Host "Logs and status: $OutputDir"
if ($status.status -ne 'complete') {
  Write-Warning 'Some questions remain unscored. Run the same command again to retry only pending questions.'
  exit 2
}
