//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	messageBoxYesNo       = 0x00000004
	messageBoxQuestion    = 0x00000020
	messageBoxInformation = 0x00000040
	messageBoxError       = 0x00000010
	messageBoxYes         = 6
	windowsCreateNoWindow = 0x08000000
)

func main() {
	if len(os.Args) >= 3 && os.Args[1] == "--cleanup" {
		quiet := len(os.Args) >= 4 && os.Args[3] == "--quiet"
		if err := cleanup(os.Args[2]); err != nil {
			if !quiet {
				showMessage("Neptune", "La désinstallation n’a pas pu être terminée.\n\n"+err.Error(), messageBoxError)
			}
			os.Exit(1)
		}
		if !quiet {
			showMessage("Neptune", "Neptune a été désinstallé de cet ordinateur.", messageBoxInformation)
		}
		return
	}

	quiet := len(os.Args) >= 2 && os.Args[1] == "--quiet"
	if !quiet {
		answer := showMessage("Désinstaller Neptune", "Voulez-vous supprimer Neptune, son moteur local, sa mémoire et ses journaux de cet ordinateur ?", messageBoxYesNo|messageBoxQuestion)
		if answer != messageBoxYes {
			return
		}
	}

	root := productRoot()
	current, err := os.Executable()
	if err != nil {
		fatal(quiet, fmt.Errorf("impossible de localiser le programme de désinstallation: %w", err))
	}
	temporary := filepath.Join(os.TempDir(), fmt.Sprintf("NeptuneUninstall-%d.exe", time.Now().UnixNano()))
	content, err := os.ReadFile(current)
	if err != nil {
		fatal(quiet, fmt.Errorf("impossible de préparer la désinstallation: %w", err))
	}
	if err := os.WriteFile(temporary, content, 0o700); err != nil {
		fatal(quiet, fmt.Errorf("impossible de créer le programme temporaire: %w", err))
	}
	args := []string{"--cleanup", root}
	if quiet {
		args = append(args, "--quiet")
	}
	cmd := exec.Command(temporary, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windowsCreateNoWindow | syscall.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Start(); err != nil {
		fatal(quiet, fmt.Errorf("impossible de démarrer la désinstallation: %w", err))
	}
}

func cleanup(root string) error {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "." || !strings.EqualFold(root, productRoot()) {
		return fmt.Errorf("chemin Neptune invalide: %s", root)
	}

	stopScript := fmt.Sprintf(`
$root = %s
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
`, quotePowerShell(root))
	_ = runPowerShell(stopScript)
	time.Sleep(800 * time.Millisecond)

	registryScript := `
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'NeptuneHermes' -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.neptune.hermes' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.neptune.hermes' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Google\Chrome\Extensions\mhjkecpebpekcdbnhfmdiemlkfaafidh' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Neptune' -Recurse -Force -ErrorAction SilentlyContinue
`
	if err := runPowerShell(registryScript); err != nil {
		return fmt.Errorf("nettoyage des enregistrements Windows: %w", err)
	}

	for attempt := 0; attempt < 8; attempt++ {
		if err := os.RemoveAll(root); err == nil {
			if _, statErr := os.Stat(root); os.IsNotExist(statErr) {
				return nil
			}
		}
		time.Sleep(time.Duration(attempt+1) * 350 * time.Millisecond)
	}
	return fmt.Errorf("le dossier %s est encore utilisé ; redémarrez Windows puis relancez la désinstallation", root)
}

func productRoot() string {
	base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	return filepath.Join(base, "Neptune")
}

func runPowerShell(script string) error {
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windowsCreateNoWindow}
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func quotePowerShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func fatal(quiet bool, err error) {
	if !quiet {
		showMessage("Neptune", err.Error(), messageBoxError)
	}
	os.Exit(1)
}

func showMessage(title, message string, flags uintptr) int {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	titleUTF16, _ := syscall.UTF16PtrFromString(title)
	messageUTF16, _ := syscall.UTF16PtrFromString(message)
	result, _, _ := messageBox.Call(
		0,
		uintptr(unsafe.Pointer(messageUTF16)),
		uintptr(unsafe.Pointer(titleUTF16)),
		flags,
	)
	return int(result)
}
