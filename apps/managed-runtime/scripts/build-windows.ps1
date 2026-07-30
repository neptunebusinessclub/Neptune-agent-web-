$ErrorActionPreference = 'Stop'
$RuntimeRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Out = Join-Path $RuntimeRoot 'dist'
$Payload = Join-Path $RuntimeRoot 'cmd\setup\payload'
New-Item -ItemType Directory -Force -Path $Out, $Payload | Out-Null

$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'

Write-Host 'Building NeptuneHermesHost.exe'
Push-Location $RuntimeRoot
try {
  go test ./cmd/host
  go build -trimpath -ldflags '-s -w' -o (Join-Path $Out 'NeptuneHermesHost.exe') ./cmd/host

  Copy-Item (Join-Path $Out 'NeptuneHermesHost.exe') (Join-Path $Payload 'NeptuneHermesHost.exe') -Force
  Copy-Item (Join-Path $RuntimeRoot 'assets\install.ps1') (Join-Path $Payload 'install.ps1') -Force
  Copy-Item (Join-Path $RuntimeRoot 'assets\start-runtime.ps1') (Join-Path $Payload 'start-runtime.ps1') -Force

  Write-Host 'Building NeptuneSetup.exe'
  go test ./cmd/setup
  go build -trimpath -ldflags '-s -w' -o (Join-Path $Out 'NeptuneSetup.exe') ./cmd/setup

  if ((Get-Item (Join-Path $Out 'NeptuneSetup.exe')).Length -lt 1MB) {
    throw 'NeptuneSetup.exe is unexpectedly small; embedded payload is missing.'
  }
} finally {
  Remove-Item (Join-Path $Payload 'NeptuneHermesHost.exe') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Payload 'install.ps1') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Payload 'start-runtime.ps1') -Force -ErrorAction SilentlyContinue
  Pop-Location
}

Write-Host "Windows installer ready: $(Join-Path $Out 'NeptuneSetup.exe')"
