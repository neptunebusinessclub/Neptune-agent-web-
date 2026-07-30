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
  $candidate = Get-ChildItem -Path $LlamaRoot -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $candidate) { throw 'llama-server.exe est introuvable.' }
  return $candidate.FullName
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

if ($Repair) { Stop-TrackedProcesses }
$connection = Read-Connection
$apiKey = [string]$connection.apiKey

if ((Test-Endpoint 'http://127.0.0.1:8080/v1/models') -and (Test-Endpoint "$($connection.endpoint)/health" $apiKey)) {
  exit 0
}

if (-not (Test-Path $ModelPath)) { throw 'Le modèle local Neptune est absent. Relancez NeptuneSetup.exe.' }
$llamaExe = Find-LlamaExecutable
$hermesExe = Find-HermesExecutable

$llamaProcess = $null
if (-not (Test-Endpoint 'http://127.0.0.1:8080/v1/models')) {
  $ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
  $threads = [math]::Max(2, [math]::Min([Environment]::ProcessorCount - 1, 12))
  $context = if ($ramGb -ge 24) { 65536 } elseif ($ramGb -ge 16) { 49152 } else { 32768 }
  $llamaArgs = @(
    '--model', $ModelPath,
    '--host', '127.0.0.1',
    '--port', '8080',
    '--ctx-size', [string]$context,
    '--threads', [string]$threads,
    '--parallel', '1',
    '--jinja',
    '--n-gpu-layers', '999'
  )
  $llamaProcess = Start-Process -FilePath $llamaExe -ArgumentList $llamaArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Logs 'llama.out.log') -RedirectStandardError (Join-Path $Logs 'llama.err.log')
  Wait-Until -TimeoutSeconds 240 -Failure 'Le modèle local n’a pas démarré.' -Condition { Test-Endpoint 'http://127.0.0.1:8080/v1/models' }
}

$env:HERMES_HOME = $HermesHome
$env:API_SERVER_ENABLED = 'true'
$env:API_SERVER_HOST = '127.0.0.1'
$env:API_SERVER_PORT = '8642'
$env:API_SERVER_KEY = $apiKey
$env:API_SERVER_CORS_ORIGINS = 'chrome-extension://mhjkecpebpekcdbnhfmdiemlkfaafidh'
$env:PYTHONUTF8 = '1'

$hermesProcess = $null
if (-not (Test-Endpoint "$($connection.endpoint)/health" $apiKey)) {
  $hermesProcess = Start-Process -FilePath $hermesExe -ArgumentList @('gateway') -WorkingDirectory $HermesInstall -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Logs 'hermes.out.log') -RedirectStandardError (Join-Path $Logs 'hermes.err.log')
  Wait-Until -TimeoutSeconds 240 -Failure 'Hermes Agent n’a pas démarré.' -Condition { Test-Endpoint "$($connection.endpoint)/health" $apiKey }
}

$state = [ordered]@{
  llamaPid = if ($llamaProcess) { $llamaProcess.Id } else { $null }
  hermesPid = if ($hermesProcess) { $hermesProcess.Id } else { $null }
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  model = 'Qwen3-4B-Q4_K_M'
}
$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
