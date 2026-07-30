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
	installer := readPayload(t, "payload/install.ps1")

	if !strings.Contains(installer, "$HermesTag = 'v2026.7.7.2'") {
		t.Fatal("Hermes runtime release tag must remain pinned")
	}
	if !strings.Contains(installer, "$HermesInstallerCommit = 'c9de69c6d5ed602059f5e9c9950c150e07b89212'") {
		t.Fatal("Hermes installer bootstrap must be pinned to the audited checkout-fix commit")
	}
	if strings.Contains(installer, "hermes-agent/$HermesTag/scripts/install.ps1") {
		t.Fatal("the broken installer bundled in the Hermes release tag must not be used as bootstrap")
	}
	if !strings.Contains(installer, "hermes-agent/$HermesInstallerCommit/scripts/install.ps1") {
		t.Fatal("installer bootstrap URL must use the dedicated audited commit")
	}
	if !strings.Contains(installer, "Repair-InterruptedHermesInstall") {
		t.Fatal("interrupted ZIP fallback checkouts must be repaired automatically")
	}
}

func TestBundledRandomKeyWorksInWindowsPowerShell51(t *testing.T) {
	installer := readPayload(t, "payload/install.ps1")
	if strings.Contains(installer, "RandomNumberGenerator]::Fill") {
		t.Fatal("RandomNumberGenerator.Fill is unavailable in Windows PowerShell 5.1")
	}

	start := strings.Index(installer, "function New-RandomKey")
	if start < 0 {
		t.Fatal("New-RandomKey function is missing")
	}
	endOffset := strings.Index(installer[start:], "function Test-Endpoint")
	if endOffset < 0 {
		t.Fatal("could not isolate New-RandomKey function")
	}
	functionSource := strings.TrimSpace(installer[start : start+endOffset])

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

func TestManagedEngineUsesAdaptiveContextWithoutPromptCache(t *testing.T) {
	installer := readPayload(t, "payload/install.ps1")
	runtime := readPayload(t, "payload/start-runtime.ps1")

	for _, required := range []string{
		"$MinimumHermesContext = 65536",
		"context_length: $ContextLength",
		"runtimeVersion = '2.0.0'",
		"Le profil local compatible a été sélectionné automatiquement",
		"clients2.google.com/service/update2/crx",
	} {
		if !strings.Contains(installer, required) {
			t.Fatalf("installer is missing the production runtime contract: %s", required)
		}
	}

	for _, required := range []string{
		"$FullContext = 65536",
		"$CompactMinimumContext = 32000",
		"$RuntimeVersion = '2.0.0'",
		"'--cache-ram', '0'",
		"'--ctx-checkpoints', '0'",
		"'--fit', $Profile.Fit",
		"Fit = 'off'",
		"Fit = 'on'",
		"Start-AdaptiveLlama",
		"Set-HermesContextPolicy -Mode 'compact'",
		"MINIMUM_CONTEXT_LENGTH = 32_000  # Neptune compact local mode",
		"localMode = $localMode",
	} {
		if !strings.Contains(runtime, required) {
			t.Fatalf("runtime is missing adaptive context protection: %s", required)
		}
	}

	if strings.Contains(runtime, "--cache-ram', '8192") {
		t.Fatal("the 8 GiB llama.cpp prompt cache must never be enabled on 16 GB hosts")
	}
}

func TestInstallerShipsNoTechWPFExperience(t *testing.T) {
	ui := readPayload(t, "payload/installer-ui.ps1")
	for _, required := range []string{
		"Installation intelligente",
		"Aucune clé API, commande terminal ou configuration technique",
		"Ajouter Neptune à Chrome",
		"latest-error.log",
		"CreateNoWindow = $true",
		"UninstallSource",
	} {
		if !strings.Contains(ui, required) {
			t.Fatalf("GUI installer is missing the no-tech contract: %s", required)
		}
	}
	if strings.Contains(ui, "chrome://extensions") || strings.Contains(ui, "Mode développeur") {
		t.Fatal("the customer installer must not ask users to load an unpacked extension")
	}
}

func TestInstallerEmbedsAndRegistersUninstaller(t *testing.T) {
	uninstaller, err := payload.ReadFile("payload/NeptuneUninstall.exe")
	if err != nil {
		t.Fatalf("read embedded uninstaller: %v", err)
	}
	if len(uninstaller) < 100_000 || !bytes.HasPrefix(uninstaller, []byte{'M', 'Z'}) {
		t.Fatal("embedded NeptuneUninstall.exe is missing or invalid")
	}
	installer := readPayload(t, "payload/install.ps1")
	for _, required := range []string{
		"UninstallSource",
		"NeptuneUninstall.exe",
		"CurrentVersion\\Uninstall\\Neptune",
		"QuietUninstallString",
		"Neptune Business Club",
	} {
		if !strings.Contains(installer, required) {
			t.Fatalf("installer is missing uninstall registration: %s", required)
		}
	}
}

func TestStoreIdentityMatchesNativeHost(t *testing.T) {
	if !strings.Contains(chromeStoreURL, "mhjkecpebpekcdbnhfmdiemlkfaafidh") {
		t.Fatal("Chrome Web Store URL must preserve the extension ID derived from the manifest key")
	}
	installer := readPayload(t, "payload/install.ps1")
	if !strings.Contains(installer, "$ExtensionId = 'mhjkecpebpekcdbnhfmdiemlkfaafidh'") {
		t.Fatal("native host allowed origin does not match the Chrome Web Store identity")
	}
}

func readPayload(t *testing.T, name string) string {
	t.Helper()
	content, err := payload.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(content)
}
