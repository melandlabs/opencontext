# Outer loop - respawns watchdog.ps1 every ~45 minutes so it survives sandbox kill.
# Logs to watchdog_loop.log.

$logFile = 'D:\opencontext\benchmark\clbench-official\watchdog_loop.log'
$watchdog = 'D:\opencontext\benchmark\clbench-official\watchdog.ps1'
$inferOut = 'D:\opencontext\benchmark\clbench-official\outputs\opencontext-cl.jsonl'
$gradedOut = 'D:\opencontext\benchmark\clbench-official\outputs\opencontext-cl_graded.jsonl'
$workDir = 'D:\opencontext\benchmark\clbench-official'

function Log([string]$msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [outer] $msg"
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

Log "outer loop start"

while ($true) {
    # Launch watchdog (it auto-exits after 50 minutes)
    Log "spawning watchdog.ps1"
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $watchdog) -WorkingDirectory $workDir -RedirectStandardOutput "$workDir\watchdog.stdout.log" -RedirectStandardError "$workDir\watchdog.stderr.log" -PassThru -WindowStyle Hidden

    # Wait up to 55 minutes for it to exit on its own
    $exited = $p.WaitForExit(55 * 60 * 1000)
    if ($exited) {
        Log "watchdog exited cleanly (code=$($p.ExitCode))"
    } else {
        Log "watchdog timeout (55 min) - killing"
        try { Stop-Process -Id $p.Id -Force } catch {}
    }

    # Check completion
    $inferN = if (Test-Path $inferOut) { (Get-Content $inferOut | Measure-Object).Count } else { 0 }
    $gradedN = if (Test-Path $gradedOut) { (Get-Content $gradedOut | Measure-Object).Count } else { 0 }
    if ($inferN -ge 405 -and $gradedN -ge 405) {
        Log "all done (infer=$inferN graded=$gradedN), outer loop exit"
        break
    }

    Log "respawning after 30s pause"
    Start-Sleep -Seconds 30
}

Log "outer loop end"
