//go:build windows

package main

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

//go:embed payload/*
var payload embed.FS

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

func preparePayload(name string, content []byte) []byte {
	if filepath.Ext(name) != ".ps1" || bytes.HasPrefix(content, utf8BOM) {
		return content
	}

	prepared := make([]byte, 0, len(utf8BOM)+len(content))
	prepared = append(prepared, utf8BOM...)
	prepared = append(prepared, content...)
	return prepared
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "\nNeptune n’a pas pu terminer l’installation : %v\n", err)
		fmt.Fprintln(os.Stderr, "Appuyez sur Entrée pour fermer.")
		_, _ = fmt.Scanln()
		os.Exit(1)
	}
}

func run() error {
	fmt.Println("Neptune — installation du cerveau Hermes intégré")
	fmt.Println("Cette opération installe automatiquement Hermes Agent et un modèle local. Aucun compte API ne sera demandé.")

	temporary, err := os.MkdirTemp("", "neptune-hermes-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)

	files := map[string]string{
		"payload/NeptuneHermesHost.exe": "NeptuneHermesHost.exe",
		"payload/install.ps1":          "install.ps1",
		"payload/start-runtime.ps1":    "start-runtime.ps1",
	}
	for source, name := range files {
		content, readErr := payload.ReadFile(source)
		if readErr != nil {
			return fmt.Errorf("ressource intégrée absente (%s): %w", source, readErr)
		}
		if len(content) == 0 {
			return errors.New("une ressource d’installation Neptune est vide")
		}
		content = preparePayload(name, content)
		if writeErr := os.WriteFile(filepath.Join(temporary, name), content, 0o600); writeErr != nil {
			return writeErr
		}
	}

	script := filepath.Join(temporary, "install.ps1")
	host := filepath.Join(temporary, "NeptuneHermesHost.exe")
	starter := filepath.Join(temporary, "start-runtime.ps1")
	cmd := exec.Command("powershell.exe",
		"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-File", script,
		"-HostSource", host,
		"-StartScriptSource", starter,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}
