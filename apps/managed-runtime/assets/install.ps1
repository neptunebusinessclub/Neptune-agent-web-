param(
  [Parameter(Mandatory = $true)][string]$HostSource,
  [Parameter(Mandatory = $true)][string]$StartScriptSource
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $consoleEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $consoleEncoding
  $OutputEncoding = $consoleEncoding
} catch { }

$ExtensionId = 'mhjkecpebpekcdbnhfmdiemlkfaafidh'
$HermesTag = 'v2026.7.7.2'
# The Hermes payload remains pinned to the stable release above. The installer
# bootstrap is pinned separately to a newer upstream commit because the release
# tag's Windows ZIP fallback initializes a repository full of untracked files
# and then performs a non-forced tag checkout, which aborts on fresh machines
# where git clone falls back to the ZIP path.
$HermesInstallerCommit = 'c9de69c6d5ed602059f5e9c9950c150e07b89212'
$LlamaTag = 'b9637'
$MinimumHermesContext = 65536
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

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-RandomKey {
  $bytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    if ($rng) { $rng.Dispose() }
  }
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

function Get-InstalledMemoryInfo {
  $bytes = 0

  try {
    $modules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop)
    if ($modules.Count -gt 0) {
      $sum = ($modules | Measure-Object -Property Capacity -Sum).Sum
      if ($sum) { $bytes = [double]$sum }
    }
  } catch { }

  if ($bytes -le 0) {
    try {
      $bytes = [double](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory
    } catch {
      throw "Neptune n'a pas pu déterminer la mémoire installée sur cet ordinateur."
    }
  }

  return [pscustomobject]@{
    Bytes = $bytes
    GiB = [math]::Round($bytes / 1GB, 1)
  }
}

function Get-ContextLength {
  param([double]$InstalledBytes)
  # Hermes Agent rejects any model endpoint below 64K. Memory adaptation must
  # therefore happen through KV-cache quantization, never by reducing context.
  return $MinimumHermesContext
}

function Test-GitCheckoutHasHead {
  param([string]$RepositoryPath)

  $gitDirectory = Join-Path $RepositoryPath '.git'
  $headPath = Join-Path $gitDirectory 'HEAD'
  if (-not (Test-Path $gitDirectory -PathType Container) -or -not (Test-Path $headPath -PathType Leaf)) {
    return $false
  }

  try {
    $head = [string](Get-Content $headPath -Raw -ErrorAction Stop).Trim()
    if ($head -match '^[0-9a-fA-F]{40,64}$') { return $true }
    if ($head -notmatch '^ref:\s+(.+)$') { return $false }

    $reference = $Matches[1].Trim()
    $looseReference = Join-Path $gitDirectory ($reference -replace '/', '\')
    if (Test-Path $looseReference -PathType Leaf) {
      $value = [string](Get-Content $looseReference -Raw -ErrorAction SilentlyContinue).Trim()
      if ($value -match '^[0-9a-fA-F]{40,64}$') { return $true }
    }

    $packedReferences = Join-Path $gitDirectory 'packed-refs'
    if (Test-Path $packedReferences -PathType Leaf) {
      $escapedReference = [regex]::Escape($reference)
      $packed = Get-Content $packedReferences -ErrorAction SilentlyContinue
      if ($packed | Where-Object { $_ -match "^[0-9a-fA-F]{40,64}\s+$escapedReference$" }) { return $true }
    }
  } catch { }

  return $false
}

function Repair-InterruptedHermesInstall {
  $hermesCandidates = @(
    (Join-Path $HermesInstall 'venv\Scripts\hermes.exe'),
    (Join-Path $HermesInstall '.venv\Scripts\hermes.exe')
  )
  if ($hermesCandidates | Where-Object { Test-Path $_ -PathType Leaf }) { return }
  if (-not (Test-Path $HermesInstall)) { return }
  if (Test-GitCheckoutHasHead -RepositoryPath $HermesInstall) { return }

  Write-Step 'Réparation automatique de la tentative Hermes interrompue...'
  try {
    Remove-Item -LiteralPath $HermesInstall -Recurse -Force -ErrorAction Stop
  } catch {
    throw "Neptune n'a pas pu nettoyer l'installation Hermes incomplète. Fermez les fenêtres utilisant ce dossier puis relancez NeptuneSetup.exe. Détail : $($_.Exception.Message)"
  }
}

function Ensure-Hermes {
  $hermesCandidates = @(
    (Join-Path $HermesInstall 'venv\Scripts\hermes.exe'),
    (Join-Path $HermesInstall '.venv\Scripts\hermes.exe')
  )
  if ($hermesCandidates | Where-Object { Test-Path $_ -PathType Leaf }) { return }

  Repair-InterruptedHermesInstall
  Write-Step 'Installation du moteur Hermes Agent officiel...'

  $installerUrl = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HermesInstallerCommit/scripts/install.ps1"
  $installerPath = Join-Path $Root 'hermes-installer-bootstrap.ps1'
  try {
    Download-WithHash -Url $installerUrl -Destination $installerPath -ExpectedSha256 ''
    $installerText = [System.IO.File]::ReadAllText($installerPath).TrimStart([char]0xFEFF)
    $installerBlock = [scriptblock]::Create($installerText)
    & $installerBlock -SkipSetup -NonInteractive -Tag $HermesTag -HermesHome $HermesHome -InstallDir $HermesInstall
  } finally {
    Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
    Remove-Item "$installerPath.download" -Force -ErrorAction SilentlyContinue
  }

  if (-not ($hermesCandidates | Where-Object { Test-Path $_ -PathType Leaf })) {
    $found = Get-ChildItem -Path $HermesInstall -Filter 'hermes.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { throw "L'installation officielle de Hermes n'a produit aucun exécutable." }
  }
}

function Install-LlamaAsset {
  param(
    [object]$Asset,
    [ValidateSet('vulkan', 'cpu')][string]$Backend
  )
  if (-not $Asset) { throw "Le binaire llama.cpp $Backend manque dans $LlamaTag." }
  $digest = [string]$Asset.digest
  $sha = if ($digest -match '^sha256:(.+)$') { $Matches[1] } else { '' }
  if (-not $sha) { throw "GitHub n'a pas fourni l'empreinte du binaire llama.cpp $Backend." }
  $destination = Join-Path $LlamaRoot $Backend
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $archive = Join-Path $Root $Asset.name
  Download-WithHash -Url $Asset.browser_download_url -Destination $archive -ExpectedSha256 $sha
  Expand-Archive -Path $archive -DestinationPath $destination -Force
  Remove-Item $archive -Force
  if (-not (Get-ChildItem -Path $destination -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    throw "llama-server.exe manque après extraction du backend $Backend."
  }
}

function Ensure-Llama {
  $vulkanReady = Get-ChildItem -Path (Join-Path $LlamaRoot 'vulkan') -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  $cpuReady = Get-ChildItem -Path (Join-Path $LlamaRoot 'cpu') -Filter 'llama-server.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($vulkanReady -and $cpuReady) { return }

  Write-Step 'Installation des moteurs locaux accéléré et universel...'
  New-Item -ItemType Directory -Force -Path $LlamaRoot | Out-Null
  $release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'Neptune-Installer' } -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LlamaTag"
  $vulkanAsset = $release.assets | Where-Object { $_.name -match 'bin-win-vulkan-x64\.zip$' } | Select-Object -First 1
  $cpuAsset = $release.assets | Where-Object { $_.name -match 'bin-win-cpu-x64\.zip$' } | Select-Object -First 1
  if (-not $vulkanReady) { Install-LlamaAsset -Asset $vulkanAsset -Backend 'vulkan' }
  if (-not $cpuReady) { Install-LlamaAsset -Asset $cpuAsset -Backend 'cpu' }
}

function Ensure-Model {
  if (Test-Path $ModelPath) {
    $size = (Get-Item $ModelPath).Length
    if ($size -gt 2GB) { return }
    Remove-Item $ModelPath -Force
  }

  Write-Step 'Téléchargement du cerveau local Qwen3 4B - environ 2,5 Go...'
  New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null
  $tree = Invoke-RestMethod -Headers @{ 'User-Agent' = 'Neptune-Installer' } -Uri 'https://huggingface.co/api/models/Qwen/Qwen3-4B-GGUF/tree/main?recursive=false&expand=true'
  $file = $tree | Where-Object { $_.path -eq 'Qwen3-4B-Q4_K_M.gguf' } | Select-Object -First 1
  if (-not $file) { throw 'Le modèle Qwen3-4B-Q4_K_M officiel est introuvable.' }
  $sha = [string]$file.lfs.oid
  if (-not $sha -or $sha.Length -ne 64) { throw "Hugging Face n'a pas fourni l'empreinte du modèle." }
  Download-WithHash -Url 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true' -Destination $ModelPath -ExpectedSha256 $sha
}

function Write-Configuration {
  Write-Step 'Configuration automatique de Hermes et de sa mémoire...'
  New-Item -ItemType Directory -Force -Path $HermesHome | Out-Null
  $apiKey = if (Test-Path $ConnectionPath) {
    try { [string](Get-Content $ConnectionPath -Raw | ConvertFrom-Json).apiKey } catch { '' }
  } else { '' }
  if (-not $apiKey -or $apiKey.Length -lt 24) { $apiKey = New-RandomKey }

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
  Write-Utf8NoBom -Path (Join-Path $HermesHome 'config.yaml') -Content $config

  $environment = @"
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=$apiKey
API_SERVER_CORS_ORIGINS=chrome-extension://$ExtensionId
OPENAI_API_KEY=no-key-required
"@
  Write-Utf8NoBom -Path (Join-Path $HermesHome '.env') -Content $environment

  $connection = [ordered]@{
    endpoint = 'http://127.0.0.1:8642'
    apiKey = $apiKey
    model = 'Qwen3-4B-Q4_K_M'
    contextLength = $ContextLength
    runtimeVersion = '1.8.2'
  } | ConvertTo-Json
  Write-Utf8NoBom -Path $ConnectionPath -Content $connection

  return $apiKey
}

function Register-NativeHost {
  Write-Step 'Enregistrement sécurisé du moteur auprès de Chrome...'
  Copy-Item $HostSource $HostPath -Force
  Copy-Item $StartScriptSource $StartScriptPath -Force
  $manifest = [ordered]@{
    name = 'com.neptune.hermes'
    description = 'Neptune managed Hermes Agent runtime'
    path = $HostPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
  } | ConvertTo-Json -Depth 4
  Write-Utf8NoBom -Path $ManifestPath -Content $manifest

  foreach ($registryPath in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.neptune.hermes',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.neptune.hermes'
  )) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -Path $registryPath -Value $ManifestPath
  }

  @"
@echo off
start "" /min powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$StartScriptPath"
"@ | Set-Content -Path $StartupPath -Encoding ASCII

  $aclIdentity = "$($env:USERNAME):(R,W)"
  & icacls.exe $ConnectionPath /inheritance:r /grant:r $aclIdentity | Out-Null
  & icacls.exe (Join-Path $HermesHome '.env') /inheritance:r /grant:r $aclIdentity | Out-Null
}

$memoryInfo = Get-InstalledMemoryInfo
if ($memoryInfo.Bytes -lt 15GB) {
  throw "Neptune Hermes local nécessite 16 Go de RAM installée (tolérance Windows incluse). Mémoire détectée : $($memoryInfo.GiB) Go."
}
$ContextLength = Get-ContextLength -InstalledBytes $memoryInfo.Bytes
Write-Step "Mémoire installée détectée : $($memoryInfo.GiB) Go. Contexte Hermes réel : $ContextLength jetons, cache KV quantifié pour 16 Go."

New-Item -ItemType Directory -Force -Path $Root, $HermesHome, $LlamaRoot, $ModelRoot | Out-Null
Ensure-Hermes
Ensure-Llama
Ensure-Model
$apiKey = Write-Configuration
Register-NativeHost

Write-Step 'Démarrage et validation de Neptune Hermes...'
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StartScriptPath -Repair
if ($LASTEXITCODE -ne 0 -or -not (Test-Endpoint 'http://127.0.0.1:8642/health' $apiKey)) {
  throw 'Hermes a été installé mais sa validation finale a échoué. Consultez les journaux dans %LOCALAPPDATA%\Neptune\Hermes\logs.'
}

Write-Host "`nNeptune Hermes est installé et opérationnel avec un contexte de 65 536 jetons." -ForegroundColor Green
Write-Host 'Aucune clé ni configuration utilisateur n’est nécessaire.' -ForegroundColor Green
Write-Host 'Vous pouvez maintenant ouvrir Neptune dans Chrome.'
Start-Sleep -Seconds 3
