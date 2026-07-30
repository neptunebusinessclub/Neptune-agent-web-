//go:build windows

package main

import (
	"bytes"
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
