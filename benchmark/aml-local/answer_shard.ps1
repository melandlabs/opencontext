# Answer shards sequentially with retry supervision, one lane per invocation.
# Memory-safe: only one pipeline process runs per lane, shards are small.
# Usage: powershell -NoProfile -File answer_shard.ps1 <Dir> <Arm> <Lane> <NumLanes>
#   e.g. answer_shard.ps1 "outputs\personamem-full-none\personamem" none 0 3
# Processes input.ashard{i}.jsonl where i % NumLanes == Lane, in order.
param(
    [Parameter(Mandatory=$true)][string]$Dir,
    [Parameter(Mandatory=$true)][string]$Arm,
    [Parameter(Mandatory=$true)][int]$Lane,
    [Parameter(Mandatory=$true)][int]$NumLanes
)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $k,$v = $_ -split '=',2
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
}
$env:ANSWER_API_BASE = 'https://openrouter.ai/api/v1'
$env:ANSWER_API_KEY  = $env:OPENROUTER_API_KEY
$env:ANSWER_MODEL    = 'qwen/qwen3-14b'

$PY   = 'd:\opencontext\benchmark\AML-agent-memory-leaderboard\.venv\Scripts\python.exe'
$PIPE = 'd:\opencontext\benchmark\AML-agent-memory-leaderboard\data\personamem\pipeline_v2.py'

$shards = Get-ChildItem (Join-Path $Dir 'input.ashard*.jsonl') | Sort-Object { [int]($_.BaseName -replace '\D','') }
$mine = for ($i = 0; $i -lt $shards.Count; $i++) { if ($i % $NumLanes -eq $Lane) { $shards[$i] } }
$log = "answer-$Arm-lane$Lane.log"
foreach ($f in $mine) {
    $out = $f.FullName -replace 'input\.a', 'answers.a'
    for ($t=1; $t -le 40; $t++) {
        & $PY run_pipeline.py $PIPE answer --input $f.FullName --output $out --mode mcq *>> $log
        if ($LASTEXITCODE -eq 0) { break }
        Add-Content $log "=== $Arm shard $($f.Name) relaunch $t (exit $LASTEXITCODE) ==="
        Start-Sleep 15
    }
}
Add-Content $log "=== lane $Lane done ==="
