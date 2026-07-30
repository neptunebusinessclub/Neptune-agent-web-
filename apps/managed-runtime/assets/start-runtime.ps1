param(
  [switch]$Repair
)

$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:LOCALAPPDATA 'Neptune\Hermes'
$HermesHome = Join-Path $Root 'hermes-home'
$HermesInstall = Join-Path $Root 'hermes-agent'
$LlamaRoot = Join-Path $Root 'llama'
$ModelPath = Join-Path $Root 'models\Qwen3-4B-Q4_K_M.gguf'
$Logs = Join-Path $Root 'logs'
$StatePath = Join-Path $Root 'runtime-state.json'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

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
  $path = Join-Path $Root 'connection.json'
  if (-not (Test-Path $path)) { throw 'connection.json absent' }
  return Get-Content $path -Raw | ConvertFrom-Json
}

function Stop-TrackedProcesses {
  if (-not (Test-Path $StatePath)) { return }
  try {
    $state = Get-Content $StatePath -Raw | ConvertFrom-Json
    foreach ($pidValue in @($state.llamaPid, $state.hermesPid)) {
      if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
  Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
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

function Start-LlamaBackend {
  param(
    [ValidateSet('vulkan', 'cpu')][string]$Backend,
    [string]$Executable
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
    '--ctx-size', '65536',
    '--threads', [string]$threads,
    '--parallel', '1',
    '--jinja',
    '--rope-scaling', 'yarn',
    '--rope-scale', '2',
    '--yarn-orig-ctx', '32768',
    '--flash-attn', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--n-gpu-layers', $gpuLayers
  )
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $timeout = if ($Backend -eq 'vulkan') { 75 } else { 180 }
  if (Wait-Endpoint -Url 'http://127.0.0.1:8080/v1/models' -TimeoutSeconds $timeout) {
    return $process
  }
  if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  return $null
}

if ($Repair) { Stop-TrackedProcesses }
$connection = Read-Connection
$apiKey = [string]$connection.apiKey

if ((Test-Endpoint 'http://127.0.0.1:8080/v1/models') -and (Test-Endpoint "$($connection.endpoint)/health" $apiKey)) {
  exit 0
}

if (-not (Test-Path $ModelPath)) { throw 'Le modèle local Neptune est absent. Relancez NeptuneSetup.exe.' }
$hermesExe = Find-HermesExecutable

$llamaProcess = $null
$selectedBackend = 'existing'
if (-not (Test-Endpoint 'http://127.0.0.1:8080/v1/models')) {
  $vulkanExe = Find-LlamaExecutable -Backend 'vulkan'
  $cpuExe = Find-LlamaExecutable -Backend 'cpu'
  if ($vulkanExe) {
    $llamaProcess = Start-LlamaBackend -Backend 'vulkan' -Executable $vulkanExe
    if ($llamaProcess) { $selectedBackend = 'vulkan' }
  }
  if (-not $llamaProcess -and $cpuExe) {
    $llamaProcess = Start-LlamaBackend -Backend 'cpu' -Executable $cpuExe
    if ($llamaProcess) { $selectedBackend = 'cpu' }
  }
  if (-not $llamaProcess) {
    throw "Le modèle local n'a démarré ni avec Vulkan ni avec le moteur CPU. Utilisez Réparer Hermes depuis Neptune."
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
  contextLength = 65536
  backend = $selectedBackend
}
$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
