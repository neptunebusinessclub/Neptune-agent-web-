$ErrorActionPreference = 'Stop'
$RuntimeRoot = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $RuntimeRoot 'dist'
$Payload = Join-Path $RuntimeRoot 'cmd\setup\payload'
New-Item -ItemType Directory -Force -Path $Out, $Payload | Out-Null

$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Sign-NeptuneBinary([string]$Path) {
  if (-not ($env:NEPTUNE_SIGN_PFX -and $env:NEPTUNE_SIGN_PASSWORD)) { return }
  $signTool = (Get-Command signtool.exe -ErrorAction Stop).Source
  & $signTool sign /fd SHA256 /td SHA256 /tr 'http://timestamp.digicert.com' /f $env:NEPTUNE_SIGN_PFX /p $env:NEPTUNE_SIGN_PASSWORD $Path
  if ($LASTEXITCODE -ne 0) { throw "Windows code signing failed for $Path." }
}

Write-Host 'Building Neptune local bridge and uninstaller'
Push-Location $RuntimeRoot
try {
  go test ./cmd/host
  go build -trimpath -ldflags '-s -w' -o (Join-Path $Out 'NeptuneHermesHost.exe') ./cmd/host

  go test ./cmd/uninstall
  go build -trimpath -ldflags '-s -w -H=windowsgui' -o (Join-Path $Out 'NeptuneUninstall.exe') ./cmd/uninstall

  Sign-NeptuneBinary (Join-Path $Out 'NeptuneHermesHost.exe')
  Sign-NeptuneBinary (Join-Path $Out 'NeptuneUninstall.exe')
  Copy-Item (Join-Path $Out 'NeptuneHermesHost.exe') (Join-Path $Payload 'NeptuneHermesHost.exe') -Force
  Copy-Item (Join-Path $Out 'NeptuneUninstall.exe') (Join-Path $Payload 'NeptuneUninstall.exe') -Force

  $installerSource = Join-Path $RuntimeRoot 'assets\install.ps1'
  $installerTarget = Join-Path $Payload 'install.ps1'
  $installerText = [System.IO.File]::ReadAllText($installerSource)
  $installerText = $installerText.Replace(
    'param([Parameter(Mandatory = $true)][string]$HostSource, [Parameter(Mandatory = $true)][string]$StartScriptSource)',
    'param([Parameter(Mandatory = $true)][string]$HostSource, [Parameter(Mandatory = $true)][string]$StartScriptSource, [Parameter(Mandatory = $true)][string]$UninstallSource)'
  )
  $installerText = $installerText.Replace("runtimeVersion = '1.8.2'", "runtimeVersion = '2.0.0'")
  $installerText = $installerText.Replace(
    'Neptune Hermes est installé et opérationnel avec un contexte de 65 536 jetons.',
    'Neptune est installé et opérationnel. Le profil local compatible a été sélectionné automatiquement.'
  )
  $productionRegistration = @'
$productRoot = Split-Path $Root -Parent
$uninstallerPath = Join-Path $productRoot 'NeptuneUninstall.exe'
Copy-Item $UninstallSource $uninstallerPath -Force
$extensionRegistry = "HKCU:\Software\Google\Chrome\Extensions\$ExtensionId"
New-Item -Path $extensionRegistry -Force | Out-Null
New-ItemProperty -Path $extensionRegistry -Name 'update_url' -Value 'https://clients2.google.com/service/update2/crx' -PropertyType String -Force | Out-Null
$uninstallRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Neptune'
New-Item -Path $uninstallRegistry -Force | Out-Null
$estimatedBytes = (Get-ChildItem $productRoot -File -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
if ($null -eq $estimatedBytes) { $estimatedBytes = 0 }
$estimatedKilobytes = [int][Math]::Ceiling(([double]$estimatedBytes) / 1KB)
New-ItemProperty -Path $uninstallRegistry -Name 'DisplayName' -Value 'Neptune' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'DisplayVersion' -Value '2.0.0' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'Publisher' -Value 'Neptune Business Club' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'InstallLocation' -Value $productRoot -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'DisplayIcon' -Value $uninstallerPath -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'UninstallString' -Value ('"' + $uninstallerPath + '"') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'QuietUninstallString' -Value ('"' + $uninstallerPath + '" --quiet') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'InstallDate' -Value (Get-Date -Format 'yyyyMMdd') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'EstimatedSize' -Value $estimatedKilobytes -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $uninstallRegistry -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host "La demande d’ajout de Neptune à Chrome et la désinstallation Windows ont été préparées."
'@
  $installerText = $installerText.Replace(
    "Write-Host 'Vous pouvez maintenant ouvrir Neptune dans Chrome.'",
    $productionRegistration
  )
  [scriptblock]::Create($installerText) | Out-Null
  [System.IO.File]::WriteAllText($installerTarget, $installerText, $utf8NoBom)

  $runtimeSource = Join-Path $RuntimeRoot 'assets\start-runtime-v184.ps1'
  $runtimeTarget = Join-Path $Payload 'start-runtime.ps1'
  $runtimeText = [System.IO.File]::ReadAllText($runtimeSource)
  $runtimeText = $runtimeText.Replace("`$RuntimeVersion = '1.8.4'", "`$RuntimeVersion = '2.0.0'")
  [scriptblock]::Create($runtimeText) | Out-Null
  [System.IO.File]::WriteAllText($runtimeTarget, $runtimeText, $utf8NoBom)

  $uiSource = Join-Path $RuntimeRoot 'assets\installer-ui.ps1'
  [scriptblock]::Create([System.IO.File]::ReadAllText($uiSource)) | Out-Null
  Copy-Item $uiSource (Join-Path $Payload 'installer-ui.ps1') -Force

  Write-Host 'Building NeptuneSetup.exe without a console window'
  go test ./cmd/setup
  go build -trimpath -ldflags '-s -w -H=windowsgui' -o (Join-Path $Out 'NeptuneSetup.exe') ./cmd/setup

  $setupPath = Join-Path $Out 'NeptuneSetup.exe'
  if ((Get-Item $setupPath).Length -lt 1MB) {
    throw 'NeptuneSetup.exe is unexpectedly small; embedded payload is missing.'
  }

  Sign-NeptuneBinary $setupPath
  if (-not ($env:NEPTUNE_SIGN_PFX -and $env:NEPTUNE_SIGN_PASSWORD)) {
    Write-Warning 'NeptuneSetup.exe is unsigned in this build. Production publication requires the signing secrets.'
  }

  (Get-FileHash -Algorithm SHA256 $setupPath).Hash.ToLowerInvariant() | Set-Content (Join-Path $Out 'NeptuneSetup.sha256') -Encoding ASCII
} finally {
  Remove-Item (Join-Path $Payload 'NeptuneHermesHost.exe') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Payload 'NeptuneUninstall.exe') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Payload 'install.ps1') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Payload 'start-runtime.ps1') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Payload 'installer-ui.ps1') -Force -ErrorAction SilentlyContinue
  Pop-Location
}

Write-Host "Windows installer ready: $(Join-Path $Out 'NeptuneSetup.exe')"