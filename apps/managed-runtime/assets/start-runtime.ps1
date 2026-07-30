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
    $Connection.runtimeVersion = '1.8.2'
  } else {
    $Connection | Add-Member -NotePropertyName runtimeVersion -NotePropertyValue '1.8.2'
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

function Wait-Endpoint {
  param([string]$Url, [int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-Endpoint $Url) { return $true }
    Start-Sleep -Milliseconds 800
  } while ((Get-Date) -lt $deadline)
  return $false
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

function Start-LlamaBackend {
  param(
    [ValidateSet('vulkan', 'cpu')][string]$Backend,
    [string]$Executable,
    [int]$ContextLength
  )
  $threads = [math]::Max(2, [math]::Min([Environment]::ProcessorCount - 1, 12))
  $gpuLayers = if ($Backend -eq 'vulkan') { '999' } else { '0' }
  $stdout = Join-Path $Logs "llama-$Backend.out.log"
  $stderr = Join-Path $Logs "llama-$Backend.err.log"
  $arguments = @(
    '--model', $ModelPath,
    '--alias', 'Qwen3-4B-Q4_K_M',
    '--host', '127.0.0.1',
    '--port', '8080',
    '--ctx-size', [string]$ContextLength,
    '--threads', [string]$threads,
    '--parallel', '1',
    '--jinja',
    '--rope-scaling', 'yarn',
    '--rope-scale', '2',
    '--yarn-orig-ctx', '32768',
    '--flash-attn', 'on',
    '--cache-type-k', 'q4_0',
    '--cache-type-v', 'q4_0',
    '--n-gpu-layers', $gpuLayers
  )
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $timeout = if ($Backend -eq 'vulkan') { 90 } else { 240 }
  if (Wait-Endpoint -Url 'http://127.0.0.1:8080/v1/models' -TimeoutSeconds $timeout) {
    $reportedContext = Get-ReportedContextLength
    if ($reportedContext -eq 0 -or $reportedContext -ge 64000) { return $process }
  }
  if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  return $null
}

$connection = Read-Connection
$apiKey = [string]$connection.apiKey
$configuredContext = 0
if ($connection.PSObject.Properties.Name -contains 'contextLength') {
  $configuredContext = [int]$connection.contextLength
}
$contextLength = [math]::Max($MinimumHermesContext, $configuredContext)
$requiresMigration = $configuredContext -lt $MinimumHermesContext

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

$llamaProcess = $null
$selectedBackend = 'existing'
if (-not (Test-Endpoint 'http://127.0.0.1:8080/v1/models')) {
  $vulkanExe = Find-LlamaExecutable -Backend 'vulkan'
  $cpuExe = Find-LlamaExecutable -Backend 'cpu'
  if ($vulkanExe) {
    $llamaProcess = Start-LlamaBackend -Backend 'vulkan' -Executable $vulkanExe -ContextLength $contextLength
    if ($llamaProcess) { $selectedBackend = 'vulkan' }
  }
  if (-not $llamaProcess -and $cpuExe) {
    $llamaProcess = Start-LlamaBackend -Backend 'cpu' -Executable $cpuExe -ContextLength $contextLength
    if ($llamaProcess) { $selectedBackend = 'cpu' }
  }
  if (-not $llamaProcess) {
    throw "Le modèle local n'a pas démarré avec un contexte Hermes 64K, ni avec Vulkan ni avec le moteur CPU. Consultez les journaux dans $Logs."
  }
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
  llamaPid = if ($llamaProcess) { $llamaProcess.Id } else { $null }
  hermesPid = if ($hermesProcess) { $hermesProcess.Id } else { $null }
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  model = 'Qwen3-4B-Q4_K_M'
  contextLength = $contextLength
  cacheType = 'q4_0'
  backend = $selectedBackend
}
$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
