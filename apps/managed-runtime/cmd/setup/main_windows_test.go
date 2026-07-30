//go:build windows

package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreparePayloadAddsUTF8BOMToPowerShell(t *testing.T) {
	original := []byte("Write-Host 'Mémoire détectée'")
	prepared := preparePayload("install.ps1", original)

	if !bytes.HasPrefix(prepared, utf8BOM) {
		t.Fatal("PowerShell payload must start with an UTF-8 BOM for Windows PowerShell 5.1")
	}
	if !bytes.Equal(prepared[len(utf8BOM):], original) {
		t.Fatal("PowerShell payload content changed while adding the BOM")
	}
}

func TestPreparePayloadDoesNotDuplicateUTF8BOM(t *testing.T) {
	original := append(append([]byte{}, utf8BOM...), []byte("Write-Host 'Neptune'")...)
	prepared := preparePayload("start-runtime.ps1", original)

	if !bytes.Equal(prepared, original) {
		t.Fatal("existing UTF-8 BOM must not be duplicated")
	}
}

func TestPreparePayloadLeavesBinaryUntouched(t *testing.T) {
	original := []byte{0x4D, 0x5A, 0x90, 0x00}
	prepared := preparePayload("NeptuneHermesHost.exe", original)

	if !bytes.Equal(prepared, original) {
		t.Fatal("binary payload must remain unchanged")
	}
}

func TestBundledInstallerSeparatesBootstrapCommitFromHermesTag(t *testing.T) {
	installer, err := payload.ReadFile("payload/install.ps1")
	if err != nil {
		t.Fatalf("read bundled install.ps1: %v", err)
	}
	text := string(installer)

	if !strings.Contains(text, "$HermesTag = 'v2026.7.7.2'") {
		t.Fatal("Hermes runtime release tag must remain pinned")
	}
	if !strings.Contains(text, "$HermesInstallerCommit = 'c9de69c6d5ed602059f5e9c9950c150e07b89212'") {
		t.Fatal("Hermes installer bootstrap must be pinned to the audited checkout-fix commit")
	}
	if strings.Contains(text, "hermes-agent/$HermesTag/scripts/install.ps1") {
		t.Fatal("the broken installer bundled in the Hermes release tag must not be used as bootstrap")
	}
	if !strings.Contains(text, "hermes-agent/$HermesInstallerCommit/scripts/install.ps1") {
		t.Fatal("installer bootstrap URL must use the dedicated audited commit")
	}
	if !strings.Contains(text, "Repair-InterruptedHermesInstall") {
		t.Fatal("interrupted ZIP fallback checkouts must be repaired automatically")
	}
}

func TestBundledRandomKeyWorksInWindowsPowerShell51(t *testing.T) {
	installer, err := payload.ReadFile("payload/install.ps1")
	if err != nil {
		t.Fatalf("read bundled install.ps1: %v", err)
	}
	text := string(installer)

	if strings.Contains(text, "RandomNumberGenerator]::Fill") {
		t.Fatal("RandomNumberGenerator.Fill is unavailable in Windows PowerShell 5.1")
	}

	start := strings.Index(text, "function New-RandomKey")
	if start < 0 {
		t.Fatal("New-RandomKey function is missing")
	}
	endOffset := strings.Index(text[start:], "function Test-Endpoint")
	if endOffset < 0 {
		t.Fatal("could not isolate New-RandomKey function")
	}
	functionSource := strings.TrimSpace(text[start : start+endOffset])

	script := functionSource + `
$key = New-RandomKey
if (-not $key -or $key.Length -lt 64) { throw 'Generated key is invalid.' }
Write-Output $key
`
	testScript := filepath.Join(t.TempDir(), "random-key-smoke.ps1")
	if err := os.WriteFile(testScript, []byte(script), 0o600); err != nil {
		t.Fatalf("write Windows PowerShell smoke script: %v", err)
	}

	cmd := exec.Command(
		"powershell.exe",
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", testScript,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("New-RandomKey failed in Windows PowerShell 5.1: %v\n%s", err, output)
	}
	if len(strings.TrimSpace(string(output))) < 64 {
		t.Fatalf("Windows PowerShell returned an invalid key: %q", output)
	}
}
