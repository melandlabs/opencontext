param(
  [ValidateRange(1, 65535)]
  [int]$Port = 7421,

  [string]$DatabasePath
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$runtimeRoot = Join-Path $PSScriptRoot "runtime"
$launchTag = Get-Date -Format "yyyyMMdd-HHmmss"
if ($DatabasePath) {
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "Existing database not found: $DatabasePath"
  }
  $dbPath = (Resolve-Path -LiteralPath $DatabasePath).Path
  $runtimeDir = Split-Path -Parent $dbPath
  $stdoutPath = Join-Path $runtimeDir "daemon-resume-$launchTag.stdout.log"
  $stderrPath = Join-Path $runtimeDir "daemon-resume-$launchTag.stderr.log"
} else {
  $runtimeDir = Join-Path $runtimeRoot $launchTag
  $dbPath = Join-Path $runtimeDir "store.db"
  $stdoutPath = Join-Path $runtimeDir "daemon.stdout.log"
  $stderrPath = Join-Path $runtimeDir "daemon.stderr.log"
}
$cliPath = Join-Path $repoRoot "packages\opencontext\dist\cli\opencontext.js"

if (-not (Test-Path -LiteralPath $cliPath)) {
  throw "OpenContext CLI is not built: $cliPath"
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "Port $Port already has a listener; refusing to replace it."
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$previousDbPath = $env:MEMORY_STORE_DB_PATH
$previousRawStoreBackend = $env:OPENCONTEXT_MEMORY_STORE_BACKEND
$previousRerankerDtype = $env:LOCAL_RERANKER_DTYPE
$previousRerankerLocalOnly = $env:LOCAL_RERANKER_LOCAL_ONLY
try {
  $env:MEMORY_STORE_DB_PATH = $dbPath
  $env:OPENCONTEXT_MEMORY_STORE_BACKEND = "sqlite"
  $env:LOCAL_RERANKER_DTYPE = "q8"
  $env:LOCAL_RERANKER_LOCAL_ONLY = "true"

  $arguments = @(
    $cliPath,
    "http",
    "--host", "127.0.0.1",
    "--port", [string]$Port,
    "--embedding-provider", "local",
    "--embedding-model", "Xenova/all-MiniLM-L6-v2",
    "--embedding-cache-dir", (Join-Path $env:USERPROFILE ".cache\opencontext\local-embeddings"),
    "--memory-backend", "sqlite-vec",
    "--reranker-provider", "local",
    "--reranker-model", "Xenova/ms-marco-MiniLM-L-6-v2",
    "--reranker-cache-dir", (Join-Path $env:USERPROFILE ".cache\opencontext\local-reranker"),
    "--reranker-batch-size", "8",
    "--reranker-max-tokens", "512",
    "--insights-backend", "none",
    "--knowledge-backend", "none"
  )
  $process = Start-Process `
    -FilePath "node" `
    -ArgumentList $arguments `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
} finally {
  if ($null -eq $previousDbPath) { Remove-Item Env:MEMORY_STORE_DB_PATH -ErrorAction SilentlyContinue }
  else { $env:MEMORY_STORE_DB_PATH = $previousDbPath }
  if ($null -eq $previousRawStoreBackend) { Remove-Item Env:OPENCONTEXT_MEMORY_STORE_BACKEND -ErrorAction SilentlyContinue }
  else { $env:OPENCONTEXT_MEMORY_STORE_BACKEND = $previousRawStoreBackend }
  if ($null -eq $previousRerankerDtype) { Remove-Item Env:LOCAL_RERANKER_DTYPE -ErrorAction SilentlyContinue }
  else { $env:LOCAL_RERANKER_DTYPE = $previousRerankerDtype }
  if ($null -eq $previousRerankerLocalOnly) { Remove-Item Env:LOCAL_RERANKER_LOCAL_ONLY -ErrorAction SilentlyContinue }
  else { $env:LOCAL_RERANKER_LOCAL_ONLY = $previousRerankerLocalOnly }
}

$healthy = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
    $healthy = $true
    break
  } catch {
    if ($process.HasExited) { break }
    Start-Sleep -Seconds 1
  }
}

if (-not $healthy) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
  $details = if (Test-Path -LiteralPath $stderrPath) {
    (Get-Content -LiteralPath $stderrPath -Tail 80) -join [Environment]::NewLine
  } else {
    "No stderr log was created."
  }
  throw "Daemon failed health check. $details"
}

$metadata = [ordered]@{
  pid = $process.Id
  port = $Port
  database = $dbPath
  stdout = $stdoutPath
  stderr = $stderrPath
  started_at = (Get-Date).ToString("o")
  embedding_provider = "local"
  embedding_model = "Xenova/all-MiniLM-L6-v2"
  memory_backend = "sqlite-vec"
  reranker_provider = "local"
  reranker_model = "Xenova/ms-marco-MiniLM-L-6-v2"
  resumed_database = [bool]$DatabasePath
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir "daemon.json") -Encoding utf8
$metadata | ConvertTo-Json
