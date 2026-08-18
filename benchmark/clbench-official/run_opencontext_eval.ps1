# Run CL-bench-Life using Tencent's official Tencent-Hunyuan/CL-bench pipeline,
# pointed at the local opencontext memory daemon (via opencontext_proxy.py) for
# inference and at qwen/qwen3.7-plus via OpenRouter for grading.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File run_opencontext_eval.ps1
#
# Optional env overrides:
#   $env:OPENCONTEXT_URL   = "http://127.0.0.1:7421"
#   $env:PROXY_PORT        = 3800
#   $env:QWEN_MODEL        = "qwen/qwen3.7-plus"
#   $env:QWEN_BASE_URL     = "https://openrouter.ai/api/v1"
#   $env:OPENROUTER_KEY    = "sk-or-..."   # default = .env file
#   $env:INPUT_FILE        = "CL-bench-Life.jsonl"
#   $env:MAX_SAMPLES       = ""            # blank = all
#   $env:WORKERS           = 1
#   $env:SKIP_INFER        = "0"           # 1 = use existing outputs/<model>.jsonl

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptDir

# -------- Configuration ------------------------------------------------------
$OpenContextUrl    = if ($env:OPENCONTEXT_URL)   { $env:OPENCONTEXT_URL }      else { "http://127.0.0.1:7421" }
$ProxyPort         = if ($env:PROXY_PORT)        { [int]$env:PROXY_PORT }      else { 3800 }
$QwenModel         = if ($env:QWEN_MODEL)        { $env:QWEN_MODEL }           else { "qwen/qwen3.7-plus" }
$QwenBaseUrl       = if ($env:QWEN_BASE_URL)     { $env:QWEN_BASE_URL }        else { "https://openrouter.ai/api/v1" }
$InputFile         = if ($env:INPUT_FILE)        { $env:INPUT_FILE }           else { "CL-bench-Life.jsonl" }
$MaxSamples        = if ($env:MAX_SAMPLES)       { [int]$env:MAX_SAMPLES }     else { 0 }
$Workers           = if ($env:WORKERS)           { [int]$env:WORKERS }         else { 1 }
$SkipInfer         = if ($env:SKIP_INFER)        { $env:SKIP_INFER }           else { "0" }

$ProxyBase         = "http://127.0.0.1:$ProxyPort/v1"

# -------- Preflight ----------------------------------------------------------
function Note($msg) { Write-Output ("[run] " + $msg) }

Note ("opencontext url   : $OpenContextUrl")
Note ("proxy port        : $ProxyPort")
Note ("proxy base (used) : $ProxyBase")
Note ("qwen model        : $QwenModel")
Note ("qwen base url     : $QwenBaseUrl")
Note ("input file        : $InputFile")
$maxSamplesText = if ($MaxSamples -gt 0) { $MaxSamples } else { "(all)" }
Note ("max samples       : $maxSamplesText")
Note ("workers           : $Workers")
Note ("skip infer        : $SkipInfer")

if (-not (Test-Path -LiteralPath $InputFile)) {
  throw "input file not found: $InputFile"
}

# -------- Check opencontext daemon -------------------------------------------
try {
  $health = Invoke-WebRequest -Uri "$OpenContextUrl/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
  Note ("opencontext health: " + $health.Content)
} catch {
  throw "opencontext daemon not reachable at $OpenContextUrl/health - start it first"
}

# -------- Read OpenRouter API key --------------------------------------------
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

# -------- Output paths -------------------------------------------------------
$ModelSlug = "opencontext-cl"
$InferOut  = "outputs/$ModelSlug.jsonl"
$EvalOut   = "outputs/$ModelSlug`_graded.jsonl"
New-Item -ItemType Directory -Force -Path outputs | Out-Null

# -------- Step 1: infer ------------------------------------------------------
$proxyProcess = $null
if ($SkipInfer -ne "1") {
  Note "starting opencontext proxy on $ProxyBase -> $OpenContextUrl..."
  $proxyProcess = Start-Process -FilePath python -ArgumentList @(
    "opencontext_proxy.py",
    "--port", "$ProxyPort",
    "--opencontext-url", "$OpenContextUrl"
  ) -RedirectStandardOutput "outputs\proxy.out.log" -RedirectStandardError "outputs\proxy.err.log" -PassThru -NoNewWindow
  Start-Sleep -Seconds 2

  try {
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
      try {
        $r = Invoke-WebRequest -Uri "$ProxyBase/models" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        $ready = $true
        break
      } catch {
        Start-Sleep -Seconds 1
      }
    }
    if (-not $ready) { throw "proxy did not become ready on $ProxyPort" }
    Note "proxy ready"

    Note "running infer.py (proxy $ProxyBase -> opencontext)..."
    $inferArgs = @(
      "--model", "opencontext-cl",
      "--input", $InputFile,
      "--output", $InferOut,
      "--base-url", $ProxyBase,
      "--api-key", "any-non-empty-value",
      "--workers", "$Workers",
      "--retry-delay", "5"
    )
    if ($MaxSamples -gt 0) {
      $inferArgs += @("--max-samples", "$MaxSamples")
    }
    python infer.py @inferArgs
    if ($LASTEXITCODE -ne 0) { throw "infer.py failed" }
  } finally {
    if ($proxyProcess -and -not $proxyProcess.HasExited) {
      Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
      Note "proxy stopped"
    }
  }
} else {
  Note "skipping infer; using existing $InferOut"
  if (-not (Test-Path -LiteralPath $InferOut)) {
    throw "infer output not found: $InferOut"
  }
}

# -------- Step 2: eval (qwen judge, official eval.py) ------------------------
Note "running eval.py (qwen judge, high reasoning)..."
$evalArgs = @(
  "--input", $InferOut,
  "--output", $EvalOut,
  "--judge-model", $QwenModel,
  "--base-url", $QwenBaseUrl,
  "--api-key", $OpenRouterKey,
  "--workers", "$Workers",
  "--reasoning-effort", "high"
)
python eval.py @evalArgs
if ($LASTEXITCODE -ne 0) { throw "eval.py failed" }

Note "done."
Note "model output : $InferOut"
Note "graded result: $EvalOut"
