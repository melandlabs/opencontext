# Watchdog v3 - monitors eval runs and restarts them if dead.
# Detects death by EITHER:
#   - missing powershell process (CIM match)
#   - file mtime older than threshold (stale file)
# This catches the case where the powershell parent process died but
# a child python was still alive (or vice versa).

param(
    [int]$CheckIntervalSec = 300,
    [int]$MaxRuntimeMinutes = 50,
    [int]$StaleMinutesThreshold = 15
)

$logFile = 'D:\opencontext\benchmark\clbench-official\monitor.log'
$inferOut = 'D:\opencontext\benchmark\clbench-official\outputs\openloomi-cl.jsonl'
$gradedOut = 'D:\opencontext\benchmark\clbench-official\outputs\openloomi-cl_graded.jsonl'
$inferScript = 'D:\opencontext\benchmark\clbench-official\run_openloomi_eval.ps1'
$evalScript = 'D:\opencontext\benchmark\clbench-official\eval_only.ps1'
$workDir = 'D:\opencontext\benchmark\clbench-official'

function Log([string]$msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [watchdog] $msg"
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Check-ScriptsRunning {
    $cmdLines = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine
    $hasInfer = $false; $hasEval = $false
    foreach ($c in $cmdLines) {
        if ($c -match 'run_openloomi_eval\.ps1') { $hasInfer = $true }
        if ($c -match 'eval_only\.ps1') { $hasEval = $true }
    }
    return @{ Infer = $hasInfer; Eval = $hasEval }
}

function Start-Scripts {
    Log "restarting eval scripts"
    $env:MAX_SAMPLES = ""; $env:SKIP_INFER = "0"
    $a1 = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $inferScript)
    $p1 = Start-Process -FilePath 'powershell.exe' -ArgumentList $a1 -WorkingDirectory $workDir -RedirectStandardOutput "$workDir\full_run.log" -RedirectStandardError "$workDir\full_run.err.log" -PassThru -WindowStyle Hidden
    Log "infer started PID=$($p1.Id)"
    $a2 = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $evalScript)
    $p2 = Start-Process -FilePath 'powershell.exe' -ArgumentList $a2 -WorkingDirectory $workDir -RedirectStandardOutput "$workDir\eval_only.log" -RedirectStandardError "$workDir\eval_only.err.log" -PassThru -WindowStyle Hidden
    Log "eval-only started PID=$($p2.Id)"
}

function Calc-Score {
    if (-not (Test-Path $gradedOut)) { return $null }
    $lines = Get-Content $gradedOut -ErrorAction SilentlyContinue
    if (-not $lines -or $lines.Count -eq 0) { return $null }
    $score1 = 0; $byCat = @{}
    foreach ($l in $lines) {
        try {
            $j = $l | ConvertFrom-Json
            $s = [int]$j.score
            if ($s -eq 1) { $score1++ }
            $cat = $j.metadata.context_category
            if (-not $byCat.ContainsKey($cat)) { $byCat[$cat] = @{ total=0; score1=0 } }
            $byCat[$cat].total++
            if ($s -eq 1) { $byCat[$cat].score1++ }
        } catch {}
    }
    $rate = [math]::Round($score1/$lines.Count, 4)
    return @{ graded = $lines.Count; score1 = $score1; rate = $rate; byCat = $byCat }
}

$startTime = Get-Date
Log "watchdog v3 start (max $MaxRuntimeMinutes min, check every $CheckIntervalSec s, stale>$StaleMinutesThreshold min)"

while (((Get-Date) - $startTime).TotalMinutes -lt $MaxRuntimeMinutes) {
    $inferN = if (Test-Path $inferOut) { (Get-Content $inferOut | Measure-Object).Count } else { 0 }
    $gradedN = if (Test-Path $gradedOut) { (Get-Content $gradedOut | Measure-Object).Count } else { 0 }
    $inferTime = if (Test-Path $inferOut) { (Get-Item $inferOut).LastWriteTime } else { $null }
    $gradedTime = if (Test-Path $gradedOut) { (Get-Item $gradedOut).LastWriteTime } else { $null }
    $now = Get-Date

    $running = Check-ScriptsRunning
    $inferStaleMin = if ($inferTime) { ($now - $inferTime).TotalMinutes } else { 999 }
    $gradedStaleMin = if ($gradedTime) { ($now - $gradedTime).TotalMinutes } else { 999 }

    $processOK = $running.Infer -and $running.Eval
    $fileOK = ($inferStaleMin -lt $StaleMinutesThreshold) -and ($gradedStaleMin -lt $StaleMinutesThreshold)
    $status = if ($processOK -and $fileOK) { 'OK' } else { 'DEAD' }

    Log "status=$status (proc:$($running.Infer)/$($running.Eval), stale:${[math]::Round($inferStaleMin,1)}/${[math]::Round($gradedStaleMin,1)}m) infer=$inferN/405 graded=$gradedN/405"

    if ($status -eq 'DEAD') {
        if (-not $processOK) { Log "reason: powershell process missing" }
        if (-not $fileOK) { Log "reason: file stale (>$StaleMinutesThreshold min)" }
        Start-Scripts
        Start-Sleep -Seconds 30
        continue
    }

    $score = Calc-Score
    if ($score) {
        Log ("SCORE: {0}/{1}={2}" -f $score.score1, $score.graded, $score.rate)
        foreach ($k in ($score.byCat.Keys | Sort-Object)) {
            $c = $score.byCat[$k]
            $r = if ($c.total -gt 0) { [math]::Round($c.score1/$c.total, 4) } else { 0 }
            Log ("    {0}/{1}={2}  {3}" -f $c.score1, $c.total, $r, $k)
        }
        if ($score.graded -ge 405 -and $inferN -ge 405) {
            Log "all done, exiting"
            break
        }
    } elseif ($inferN -ge 405 -and $gradedN -ge 405) {
        Log "all done, exiting"
        break
    }

    Start-Sleep -Seconds $CheckIntervalSec
}

Log "watchdog exit (will be respawned by outer loop)"
