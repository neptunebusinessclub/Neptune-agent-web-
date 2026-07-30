param(
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
try {
  $consoleEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $consoleEncoding
  $OutputEncoding = $consoleEncoding
} catch { }

$Root = Join-Path $env:LOCALAPPDATA 'Neptune\Hermes'
$HermesHome = Join-Path $Root 'hermes-home'
$HermesInstall = Join-Path $Root 'hermes-agent'
$LlamaRoot = Join-Path $Root 'llama'
$ModelPath = Join-Path $Root 'models\Qwen3-4B-Q4_K_M.gguf'
$Logs = Join-Path $Root 'logs'
$StatePath = Join-Path $Root 'runtime-state.json'
$ConnectionPath = Join-Path $Root 'connection.json'
$ConfigPath = Join-Path $HermesHome 'config.yaml'
$MinimumHermesContext = 65536
$RuntimeVersion = '1.8.3'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Test-Endpoint {
  param([string]$Url, [string]$Key = '')
  try {
    $headers = @{}
    if ($Key) { $headers.Authorization = "Bearer $Key" }
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $headers -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch { return $false }
}

function Read-Connection {
  if (-not (Test-Path $ConnectionPath)) { throw 'connection.json absent' }
  return Get-Content $ConnectionPath -Raw | ConvertFrom-Json
}

function Stop-TrackedProcesses {
  if (Test-Path $StatePath) {
    try {
      $state = Get-Content $StatePath -Raw | ConvertFrom-Json
      foreach ($pidValue in @($state.llamaPid, $state.hermesPid)) {
        if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
          Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
      }
    } catch { }
  }
  foreach ($port in @(8080, 8642)) {
    try {
      $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
      foreach ($listener in $listeners) {
        if ($listener.OwningProcess -and (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue)) {
          Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        }
      }
    } catch { }
  }
  Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

function Write-ManagedConfiguration {
  param(
    [object]$Connection,
    [int]$ContextLength
  )

  if ($Connection.PSObject.Properties.Name -contains 'contextLength') {
    $Connection.contextLength = $ContextLength
  } else {
    $Connection | Add-Member -NotePropertyName contextLength -NotePropertyValue $ContextLength
  }
  if ($Connection.PSObject.Properties.Name -contains 'runtimeVersion') {
    $Connection.runtimeVersion = $RuntimeVersion
  } else {
    $Connection | Add-Member -NotePropertyName runtimeVersion -NotePropertyValue $RuntimeVersion
  }
  Write-Utf8NoBom -Path $ConnectionPath -Content ($Connection | ConvertTo-Json)

  $config = @"
model:
  provider: custom
  default: Qwen3-4B-Q4_K_M
  base_url: http://127.0.0.1:8080/v1
  api_key: no-key-required
  context_length: $ContextLength

compression:
  enabled: true
  threshold: 0.50
  target_ratio: 0.20
  protect_last_n: 20
"@
  Write-Utf8NoBom -Path $ConfigPath -Content $config
}

function Find-HermesExecutable {
  $candidates = @(
    (Join-Path $HermesInstall 'venv\Scripts\hermes.exe'),
    (Join-Path $HermesInstall '.venv\Scripts\hermes.exe'),
    (Join-Path $HermesHome 'hermes-agent\venv\Scripts\hermes.exe'),
    (Join-Path $HermesHome 'hermes-agent\.venv\Scripts\hermes.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $found = Get-ChildItem -Path $Root -Filter 'hermes.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  throw 'Hermes Agent est installé mais hermes.exe est introuvable.'
}

function Find-LlamaExecutable {
  param([ValidateSet('vulkan', 'cpu')][string]$Backend)
  $backendRoot = Join-Path $LlamaRoot $Backend
  $candidate = Get-ChildItem -Path $backendRoot -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  return $null
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Failure)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 800
  } while ((Get-Date) -lt $deadline)
  throw $Failure
}

function Get-ReportedContextLength {
  try {
    $props = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/props' -TimeoutSec 5
    if ($props.default_generation_settings -and $props.default_generation_settings.n_ctx) {
      return [int]$props.default_generation_settings.n_ctx
    }
    if ($props.n_ctx) { return [int]$props.n_ctx }
  } catch { }
  return 0
}

function Get-LogTail {
  param([string]$Path, [int]$Lines = 30)
  if (-not (Test-Path $Path)) { return '' }
  try { return ((Get-Content $Path -Tail $Lines -ErrorAction Stop) -join "`n") } catch { return '' }
}

function Start-LlamaProfile {
  param(
    [pscustomobject]$Profile,
    [string]$Executable,
    [int]$ContextLength
  )

  $stdout = Join-Path $Logs "llama-$($Profile.Name).out.log"
  $stderr = Join-Path $Logs "llama-$($Profile.Name).err.log"
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue

  $threads = [math]::Max(2, [math]::Min([Environment]::ProcessorCount - 1, 12))
  $arguments = @(
    '--model', $ModelPath,
    '--alias', 'Qwen3-4B-Q4_K_M',
    '--host', '127.0.0.1',
    '--port', '8080',
    '--ctx-size', [string]$ContextLength,
    '--threads', [string]$threads,
    '--parallel', '1',
    '--batch-size', [string]$Profile.Batch,
    '--ubatch-size', [string]$Profile.UBatch,
    '--jinja',
    '--rope-scaling', 'yarn',
    '--rope-scale', '2',
    '--yarn-orig-ctx', '32768',
    '--flash-attn', $Profile.FlashAttention,
    '--cache-type-k', $Profile.CacheK,
    '--cache-type-v', $Profile.CacheV,
    '--n-gpu-layers', [string]$Profile.GpuLayers,
    '--no-warmup',
    '--log-verbosity', '3'
  )
  if ($Profile.NoKvOffload) { $arguments += '--no-kv-offload' }

  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $deadline = (Get-Date).AddSeconds([int]$Profile.Timeout)
  do {
    if (Test-Endpoint 'http://127.0.0.1:8080/v1/models') {
      $reportedContext = Get-ReportedContextLength
      if ($reportedContext -eq 0 -or $reportedContext -ge 64000) {
        return [pscustomobject]@{
          Process = $process
          Profile = $Profile.Name
          CacheType = "$($Profile.CacheK)/$($Profile.CacheV)"
          Backend = $Profile.Backend
          StdErr = $stderr
        }
      }
    }
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 900
  } while ((Get-Date) -lt $deadline)

  if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  return $null
}

function Start-CompatibleLlama {
  param([int]$ContextLength)

  $vulkanExe = Find-LlamaExecutable -Backend 'vulkan'
  $cpuExe = Find-LlamaExecutable -Backend 'cpu'
  $profiles = @(
    [pscustomobject]@{ Name = 'vulkan-q8-host-kv'; Backend = 'vulkan'; CacheK = 'q8_0'; CacheV = 'q8_0'; FlashAttention = 'auto'; GpuLayers = 999; NoKvOffload = $true; Batch = 256; UBatch = 128; Timeout = 120 },
    [pscustomobject]@{ Name = 'cpu-q8'; Backend = 'cpu'; CacheK = 'q8_0'; CacheV = 'q8_0'; FlashAttention = 'off'; GpuLayers = 0; NoKvOffload = $false; Batch = 256; UBatch = 128; Timeout = 300 },
    [pscustomobject]@{ Name = 'cpu-q4k-f16v'; Backend = 'cpu'; CacheK = 'q4_0'; CacheV = 'f16'; FlashAttention = 'off'; GpuLayers = 0; NoKvOffload = $false; Batch = 128; UBatch = 64; Timeout = 300 }
  )

  foreach ($profile in $profiles) {
    $executable = if ($profile.Backend -eq 'vulkan') { $vulkanExe } else { $cpuExe }
    if (-not $executable) { continue }
    Write-Host "[Neptune] Essai du profil local $($profile.Name)..." -ForegroundColor Cyan
    $result = Start-LlamaProfile -Profile $profile -Executable $executable -ContextLength $ContextLength
    if ($result) { return $result }
  }

  $diagnostics = @()
  foreach ($profile in $profiles) {
    $path = Join-Path $Logs "llama-$($profile.Name).err.log"
    $tail = Get-LogTail -Path $path -Lines 20
    if ($tail) { $diagnostics += "--- $($profile.Name) ---`n$tail" }
  }
  $diagnosticPath = Join-Path $Logs 'last-launch-diagnostic.txt'
  Write-Utf8NoBom -Path $diagnosticPath -Content ($diagnostics -join "`n`n")
  $summary = if ($diagnostics.Count -gt 0) { $diagnostics[-1] } else { 'Aucun journal llama.cpp exploitable.' }
  throw "Le modèle local n'a démarré avec aucun profil 64K compatible. Diagnostic : $diagnosticPath`n$summary"
}

$connection = Read-Connection
$apiKey = [string]$connection.apiKey
$configuredContext = 0
if ($connection.PSObject.Properties.Name -contains 'contextLength') {
  $configuredContext = [int]$connection.contextLength
}
$contextLength = [math]::Max($MinimumHermesContext, $configuredContext)
$requiresMigration = $configuredContext -lt $MinimumHermesContext -or [string]$connection.runtimeVersion -ne $RuntimeVersion

if ($Repair -or $requiresMigration) { Stop-TrackedProcesses }
Write-ManagedConfiguration -Connection $connection -ContextLength $contextLength
$connection = Read-Connection

if ((Test-Endpoint 'http://127.0.0.1:8080/v1/models') -and (Test-Endpoint "$($connection.endpoint)/health" $apiKey)) {
  $reportedContext = Get-ReportedContextLength
  if ($reportedContext -eq 0 -or $reportedContext -ge 64000) { exit 0 }
  Stop-TrackedProcesses
}

if (-not (Test-Path $ModelPath)) { throw 'Le modèle local Neptune est absent. Relancez NeptuneSetup.exe.' }
$hermesExe = Find-HermesExecutable

$llamaResult = $null
if (-not (Test-Endpoint 'http://127.0.0.1:8080/v1/models')) {
  $llamaResult = Start-CompatibleLlama -ContextLength $contextLength
}

$env:HERMES_HOME = $HermesHome
$env:API_SERVER_ENABLED = 'true'
$env:API_SERVER_HOST = '127.0.0.1'
$env:API_SERVER_PORT = '8642'
$env:API_SERVER_KEY = $apiKey
$env:API_SERVER_CORS_ORIGINS = 'chrome-extension://mhjkecpebpekcdbnhfmdiemlkfaafidh'
$env:OPENAI_API_KEY = 'no-key-required'
$env:PYTHONUTF8 = '1'

$hermesProcess = $null
if (-not (Test-Endpoint "$($connection.endpoint)/health" $apiKey)) {
  $hermesProcess = Start-Process -FilePath $hermesExe -ArgumentList @('gateway', 'run') -WorkingDirectory $HermesInstall -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Logs 'hermes.out.log') -RedirectStandardError (Join-Path $Logs 'hermes.err.log')
  Wait-Until -TimeoutSeconds 240 -Failure "Hermes Agent n'a pas démarré." -Condition { Test-Endpoint "$($connection.endpoint)/health" $apiKey }
}

$state = [ordered]@{
  llamaPid = if ($llamaResult) { $llamaResult.Process.Id } else { $null }
  hermesPid = if ($hermesProcess) { $hermesProcess.Id } else { $null }
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  model = 'Qwen3-4B-Q4_K_M'
  contextLength = $contextLength
  cacheType = if ($llamaResult) { $llamaResult.CacheType } else { 'existing' }
  backend = if ($llamaResult) { $llamaResult.Backend } else { 'existing' }
  launchProfile = if ($llamaResult) { $llamaResult.Profile } else { 'existing' }
  runtimeVersion = $RuntimeVersion
}
$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
