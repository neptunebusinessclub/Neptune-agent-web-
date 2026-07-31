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
	"unsafe"
)

//go:embed payload/*
var payload embed.FS

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

const (
	chromeStoreURL        = "https://chromewebstore.google.com/detail/neptune/mhjkecpebpekcdbnhfmdiemlkfaafidh"
	windowsCreateNoWindow = 0x08000000
)

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
		showMessage("Neptune", fmt.Sprintf("Neptune n’a pas pu terminer l’installation.\n\n%s\n\nRelancez simplement l’installateur : il reprendra les éléments déjà téléchargés.", err), 0x10)
		os.Exit(1)
	}
}

func run() error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("impossible de localiser NeptuneSetup.exe: %w", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return fmt.Errorf("impossible de normaliser le chemin de NeptuneSetup.exe: %w", err)
	}

	temporary, err := os.MkdirTemp("", "neptune-production-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)

	files := map[string]string{
		"payload/NeptuneHermesHost.exe": "NeptuneHermesHost.exe",
		"payload/NeptuneUninstall.exe":  "NeptuneUninstall.exe",
		"payload/install.ps1":           "install.ps1",
		"payload/start-runtime.ps1":     "start-runtime.ps1",
		"payload/installer-ui.ps1":      "installer-ui.ps1",
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

	ui := filepath.Join(temporary, "installer-ui.ps1")
	script := filepath.Join(temporary, "install.ps1")
	host := filepath.Join(temporary, "NeptuneHermesHost.exe")
	uninstaller := filepath.Join(temporary, "NeptuneUninstall.exe")
	starter := filepath.Join(temporary, "start-runtime.ps1")
	cmd := exec.Command("powershell.exe",
		"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden",
		"-File", ui,
		"-InstallScript", script,
		"-HostSource", host,
		"-StartScriptSource", starter,
		"-UninstallSource", uninstaller,
		"-StoreUrl", chromeStoreURL,
		"-SetupPath", executable,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windowsCreateNoWindow | syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}

func showMessage(title, message string, flags uintptr) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	titleUTF16, _ := syscall.UTF16PtrFromString(title)
	messageUTF16, _ := syscall.UTF16PtrFromString(message)
	_, _, _ = messageBox.Call(
		0,
		uintptr(unsafe.Pointer(messageUTF16)),
		uintptr(unsafe.Pointer(titleUTF16)),
		flags,
	)
}
