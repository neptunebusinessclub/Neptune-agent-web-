param(
  [Parameter(Mandatory = $true)][string]$HostSource,
  [Parameter(Mandatory = $true)][string]$StartScriptSource
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ExtensionId = 'mhjkecpebpekcdbnhfmdiemlkfaafidh'
$HermesTag = 'v2026.7.7.2'
$LlamaTag = 'b9637'
$Root = Join-Path $env:LOCALAPPDATA 'Neptune\Hermes'
$HermesHome = Join-Path $Root 'hermes-home'
$HermesInstall = Join-Path $Root 'hermes-agent'
$LlamaRoot = Join-Path $Root 'llama'
$ModelRoot = Join-Path $Root 'models'
$ModelPath = Join-Path $ModelRoot 'Qwen3-4B-Q4_K_M.gguf'
$HostPath = Join-Path $Root 'NeptuneHermesHost.exe'
$StartScriptPath = Join-Path $Root 'start-runtime.ps1'
$ConnectionPath = Join-Path $Root 'connection.json'
$ManifestPath = Join-Path $Root 'com.neptune.hermes.json'
$StartupPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\NeptuneHermesRuntime.cmd'

function Write-Step([string]$Text) {
  Write-Host "`n[Neptune] $Text" -ForegroundColor Cyan
}

function New-RandomKey {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Test-Endpoint {
  param([string]$Url, [string]$Key = '')
  try {
    $headers = @{}
    if ($Key) { $headers.Authorization = "Bearer $Key" }
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $headers -TimeoutSec 4
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch { return $false }
}

function Download-WithHash {
  param([string]$Url, [string]$Destination, [string]$ExpectedSha256)
  $temporary = "$Destination.download"
  Remove-Item $temporary -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporary
  $actual = (Get-FileHash -Algorithm SHA256 $temporary).Hash.ToLowerInvariant()
  if ($ExpectedSha256 -and $actual -ne $ExpectedSha256.ToLowerInvariant()) {
    Remove-Item $temporary -Force -ErrorAction SilentlyContinue
    throw "Empreinte SHA-256 incorrecte pour $Url"
  }
  Move-Item $temporary $Destination -Force
}

function Ensure-Hermes {
  $hermesCandidates = @(
    (Join-Path $HermesInstall 'venv\Scripts\hermes.exe'),
    (Join-Path $HermesInstall '.venv\Scripts\hermes.exe')
  )
  if ($hermesCandidates | Where-Object { Test-Path $_ }) { return }

  Write-Step 'Installation du moteur Hermes Agent officiel…'
  $installerUrl = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HermesTag/scripts/install.ps1"
  $installerText = [string](Invoke-RestMethod -Uri $installerUrl)
  $installerText = $installerText.TrimStart([char]0xFEFF)
  $installerBlock = [scriptblock]::Create($installerText)
  & $installerBlock -SkipSetup -Tag $HermesTag -HermesHome $HermesHome -InstallDir $HermesInstall

  if (-not ($hermesCandidates | Where-Object { Test-Path $_ })) {
    $found = Get-ChildItem -Path $Root -Filter 'hermes.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { throw "L'installation officielle de Hermes n'a produit aucun exécutable." }
  }
}

function Ensure-Llama {
  if (Get-ChildItem -Path $LlamaRoot -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1) { return }

  Write-Step 'Installation du moteur local llama.cpp…'
  New-Item -ItemType Directory -Force -Path $LlamaRoot | Out-Null
  $release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'Neptune-Installer' } -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LlamaTag"
  $asset = $release.assets | Where-Object { $_.name -match 'bin-win-vulkan-x64\.zip$' } | Select-Object -First 1
  if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -match 'bin-win-cpu-x64\.zip$' } | Select-Object -First 1 }
  if (-not $asset) { throw "Aucun binaire llama.cpp Windows compatible dans $LlamaTag." }
  $digest = [string]$asset.digest
  $sha = if ($digest -match '^sha256:(.+)$') { $Matches[1] } else { '' }
  if (-not $sha) { throw "GitHub n'a pas fourni l'empreinte du binaire llama.cpp." }
  $archive = Join-Path $Root $asset.name
  Download-WithHash -Url $asset.browser_download_url -Destination $archive -ExpectedSha256 $sha
  Expand-Archive -Path $archive -DestinationPath $LlamaRoot -Force
  Remove-Item $archive -Force
  if (-not (Get-ChildItem -Path $LlamaRoot -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    throw 'llama-server.exe manque après extraction.'
  }
}

function Ensure-Model {
  if (Test-Path $ModelPath) {
    $size = (Get-Item $ModelPath).Length
    if ($size -gt 2GB) { return }
    Remove-Item $ModelPath -Force
  }

  Write-Step 'Téléchargement du cerveau local Qwen3 4B — environ 2,5 Go…'
  New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null
  $tree = Invoke-RestMethod -Headers @{ 'User-Agent' = 'Neptune-Installer' } -Uri 'https://huggingface.co/api/models/Qwen/Qwen3-4B-GGUF/tree/main?recursive=false&expand=true'
  $file = $tree | Where-Object { $_.path -eq 'Qwen3-4B-Q4_K_M.gguf' } | Select-Object -First 1
  if (-not $file) { throw 'Le modèle Qwen3-4B-Q4_K_M officiel est introuvable.' }
  $sha = [string]$file.lfs.oid
  if (-not $sha -or $sha.Length -ne 64) { throw "Hugging Face n'a pas fourni l'empreinte du modèle." }
  Download-WithHash -Url 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true' -Destination $ModelPath -ExpectedSha256 $sha
}

function Write-Configuration {
  Write-Step 'Configuration automatique de Hermes et de sa mémoire…'
  New-Item -ItemType Directory -Force -Path $HermesHome | Out-Null
  $apiKey = if (Test-Path $ConnectionPath) {
    try { [string](Get-Content $ConnectionPath -Raw | ConvertFrom-Json).apiKey } catch { '' }
  } else { '' }
  if (-not $apiKey -or $apiKey.Length -lt 24) { $apiKey = New-RandomKey }

  @"
model:
  provider: custom
  default: Qwen3-4B-Q4_K_M
  base_url: http://127.0.0.1:8080/v1
  api_key: no-key-required
  context_length: 65536
"@ | Set-Content -Path (Join-Path $HermesHome 'config.yaml') -Encoding UTF8

  @"
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=$apiKey
API_SERVER_CORS_ORIGINS=chrome-extension://$ExtensionId
"@ | Set-Content -Path (Join-Path $HermesHome '.env') -Encoding UTF8

  [ordered]@{
    endpoint = 'http://127.0.0.1:8642'
    apiKey = $apiKey
    model = 'Qwen3-4B-Q4_K_M'
    runtimeVersion = '1.8.0'
  } | ConvertTo-Json | Set-Content -Path $ConnectionPath -Encoding UTF8

  return $apiKey
}

function Register-NativeHost {
  Write-Step 'Enregistrement sécurisé du moteur auprès de Chrome…'
  Copy-Item $HostSource $HostPath -Force
  Copy-Item $StartScriptSource $StartScriptPath -Force
  [ordered]@{
    name = 'com.neptune.hermes'
    description = 'Neptune managed Hermes Agent runtime'
    path = $HostPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $ManifestPath -Encoding UTF8

  foreach ($registryPath in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.neptune.hermes',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.neptune.hermes'
  )) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-ItemProperty -Path $registryPath -Name '(default)' -Value $ManifestPath
  }

  @"
@echo off
start "" /min powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$StartScriptPath"
"@ | Set-Content -Path $StartupPath -Encoding ASCII

  $aclIdentity = "$($env:USERNAME):(R,W)"
  & icacls.exe $ConnectionPath /inheritance:r /grant:r $aclIdentity | Out-Null
  & icacls.exe (Join-Path $HermesHome '.env') /inheritance:r /grant:r $aclIdentity | Out-Null
}

$ramGb = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($ramGb -lt 16) {
  throw "Neptune Hermes local nécessite au moins 16 Go de mémoire vive. Mémoire détectée : $ramGb Go."
}

New-Item -ItemType Directory -Force -Path $Root, $HermesHome, $HermesInstall, $LlamaRoot, $ModelRoot | Out-Null
Ensure-Hermes
Ensure-Llama
Ensure-Model
$apiKey = Write-Configuration
Register-NativeHost

Write-Step 'Démarrage et validation de Neptune Hermes…'
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StartScriptPath -Repair
if (-not (Test-Endpoint 'http://127.0.0.1:8642/health' $apiKey)) {
  throw 'Hermes a été installé mais sa validation finale a échoué. Consultez les journaux dans %LOCALAPPDATA%\Neptune\Hermes\logs.'
}

Write-Host "`nNeptune Hermes est installé et opérationnel. Aucune clé ni configuration utilisateur n'est nécessaire." -ForegroundColor Green
Write-Host 'Vous pouvez maintenant ouvrir Neptune dans Chrome.'
Start-Sleep -Seconds 3
