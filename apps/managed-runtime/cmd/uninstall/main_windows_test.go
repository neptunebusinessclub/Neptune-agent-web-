//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductRootIsScopedToLocalAppData(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	got := productRoot()
	want := filepath.Join(local, "Neptune")
	if !strings.EqualFold(got, want) {
		t.Fatalf("productRoot() = %q, want %q", got, want)
	}
}

func TestPowerShellQuotingEscapesApostrophes(t *testing.T) {
	got := quotePowerShell(`C:\Users\O'Brien\Neptune`)
	want := `'C:\Users\O''Brien\Neptune'`
	if got != want {
		t.Fatalf("quotePowerShell() = %q, want %q", got, want)
	}
}

func TestCleanupRejectsAnyDirectoryOutsideNeptuneRoot(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	outside := filepath.Join(local, "OtherProduct")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(outside); err == nil || !strings.Contains(err.Error(), "chemin Neptune invalide") {
		t.Fatalf("cleanup should reject %q, got %v", outside, err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("cleanup modified an unrelated directory: %v", err)
	}
}
