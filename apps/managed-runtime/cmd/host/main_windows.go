//go:build windows

package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const runtimeVersion = "2.0.0"

type request struct {
	RequestID     string `json:"requestId"`
	Type          string `json:"type"`
	ClientVersion string `json:"clientVersion,omitempty"`
}

type response struct {
	RequestID      string `json:"requestId"`
	Kind           string `json:"kind"`
	Phase          string `json:"phase,omitempty"`
	Progress       int    `json:"progress,omitempty"`
	Detail         string `json:"detail,omitempty"`
	Code           string `json:"code,omitempty"`
	Endpoint       string `json:"endpoint,omitempty"`
	APIKey         string `json:"apiKey,omitempty"`
	Model          string `json:"model,omitempty"`
	RuntimeVersion string `json:"runtimeVersion,omitempty"`
}

type connection struct {
	Endpoint       string `json:"endpoint"`
	APIKey         string `json:"apiKey"`
	Model          string `json:"model"`
	RuntimeVersion string `json:"runtimeVersion"`
}

var writeMu sync.Mutex

func main() {
	reader := bufio.NewReader(os.Stdin)
	for {
		payload, err := readNativeMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return
			}
			_ = writeNativeMessage(response{Kind: "error", Code: "PROTOCOL_ERROR", Detail: err.Error()})
			return
		}

		var req request
		if err := json.Unmarshal(payload, &req); err != nil || req.RequestID == "" {
			_ = writeNativeMessage(response{RequestID: req.RequestID, Kind: "error", Code: "INVALID_REQUEST", Detail: "Requête Neptune invalide."})
			continue
		}

		switch req.Type {
		case "ensure":
			handleEnsure(req, false)
		case "repair":
			handleEnsure(req, true)
		case "status":
			handleStatus(req)
		default:
			_ = writeNativeMessage(response{RequestID: req.RequestID, Kind: "error", Code: "UNKNOWN_COMMAND", Detail: "Commande non autorisée."})
		}
	}
}

func handleStatus(req request) {
	cfg, err := loadConnection()
	if err != nil {
		_ = writeNativeMessage(response{RequestID: req.RequestID, Kind: "status", Code: "NOT_INSTALLED", Detail: "Le moteur Neptune n’est pas installé."})
		return
	}
	if err := verifyRuntime(cfg, 2*time.Second); err != nil {
		_ = writeNativeMessage(response{RequestID: req.RequestID, Kind: "status", Code: "STOPPED", Detail: "Le moteur Neptune est installé mais arrêté."})
		return
	}
	_ = writeReady(req.RequestID, cfg)
}

func handleEnsure(req request, repair bool) {
	phase := "detecting"
	if repair {
		phase = "repairing"
	}
	_ = writeProgress(req.RequestID, phase, 4, "Vérification du moteur Neptune…")

	cfg, err := loadConnection()
	if err != nil {
		_ = writeNativeMessage(response{
			RequestID: req.RequestID,
			Kind:      "error",
			Code:      "RUNTIME_NOT_INSTALLED",
			Detail:    "Le moteur Neptune n’est pas installé. Relancez NeptuneSetup.exe une seule fois.",
		})
		return
	}

	if !repair && verifyRuntime(cfg, 2*time.Second) == nil {
		_ = writeReady(req.RequestID, cfg)
		return
	}

	_ = writeProgress(req.RequestID, "starting-model", 18, "Démarrage de l’intelligence locale…")
	if err := launchRuntime(repair); err != nil {
		_ = writeNativeMessage(response{RequestID: req.RequestID, Kind: "error", Code: "START_FAILED", Detail: err.Error()})
		return
	}

	deadline := time.Now().Add(6 * time.Minute)
	progress := 24
	for time.Now().Before(deadline) {
		if verifyRuntime(cfg, 3*time.Second) == nil {
			_ = writeProgress(req.RequestID, "verifying", 96, "Validation de la mémoire et des outils Neptune…")
			_ = writeReady(req.RequestID, cfg)
			return
		}
		progress += 2
		if progress > 92 {
			progress = 92
		}
		detail := "Neptune initialise ses outils…"
		if progress < 55 {
			detail = "Chargement de l’intelligence locale…"
		} else if progress < 78 {
			detail = "Démarrage de la mémoire Neptune…"
		}
		_ = writeProgress(req.RequestID, "starting-hermes", progress, detail)
		time.Sleep(2 * time.Second)
	}

	_ = writeNativeMessage(response{RequestID: req.RequestID, Kind: "error", Code: "START_TIMEOUT", Detail: "Neptune n’a pas terminé son démarrage. Utilisez Diagnostiquer et réparer Neptune dans les réglages."})
}

func runtimeRoot() (string, error) {
	base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if base == "" {
		return "", errors.New("LOCALAPPDATA est indisponible")
	}
	return filepath.Join(base, "Neptune", "Hermes"), nil
}

func loadConnection() (connection, error) {
	root, err := runtimeRoot()
	if err != nil {
		return connection{}, err
	}
	content, err := os.ReadFile(filepath.Join(root, "connection.json"))
	if err != nil {
		return connection{}, err
	}
	var cfg connection
	if err := json.Unmarshal(content, &cfg); err != nil {
		return connection{}, fmt.Errorf("configuration Neptune illisible: %w", err)
	}
	cfg.Endpoint = strings.TrimRight(strings.TrimSpace(cfg.Endpoint), "/")
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)
	cfg.Model = strings.TrimSpace(cfg.Model)
	if !strings.HasPrefix(cfg.Endpoint, "http://127.0.0.1:") || len(cfg.APIKey) < 24 || cfg.Model == "" {
		return connection{}, errors.New("configuration Neptune incomplète")
	}
	return cfg, nil
}

func launchRuntime(repair bool) error {
	root, err := runtimeRoot()
	if err != nil {
		return err
	}
	script := filepath.Join(root, "start-runtime.ps1")
	if _, err := os.Stat(script); err != nil {
		return errors.New("le lanceur Neptune est absent ; relancez NeptuneSetup.exe")
	}
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script}
	if repair {
		args = append(args, "-Repair")
	}
	cmd := exec.Command("powershell.exe", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x08000000}
	cmd.Dir = root
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("impossible de lancer Neptune: %w", err)
	}
	return nil
}

func verifyRuntime(cfg connection, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest(http.MethodGet, cfg.Endpoint+"/health", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("le moteur local répond HTTP %d", resp.StatusCode)
	}
	return nil
}

func writeReady(requestID string, cfg connection) error {
	version := cfg.RuntimeVersion
	if version == "" {
		version = runtimeVersion
	}
	return writeNativeMessage(response{
		RequestID:      requestID,
		Kind:           "ready",
		Phase:          "ready",
		Progress:       100,
		Detail:         "Neptune est prêt.",
		Endpoint:       cfg.Endpoint,
		APIKey:         cfg.APIKey,
		Model:          cfg.Model,
		RuntimeVersion: version,
	})
}

func writeProgress(requestID, phase string, progress int, detail string) error {
	return writeNativeMessage(response{RequestID: requestID, Kind: "progress", Phase: phase, Progress: progress, Detail: detail})
}

func readNativeMessage(reader io.Reader) ([]byte, error) {
	var length uint32
	if err := binary.Read(reader, binary.LittleEndian, &length); err != nil {
		return nil, err
	}
	if length == 0 || length > 1024*1024 {
		return nil, fmt.Errorf("taille de message native invalide: %d", length)
	}
	payload := make([]byte, length)
	_, err := io.ReadFull(reader, payload)
	return payload, err
}

func writeNativeMessage(value response) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var buffer bytes.Buffer
	if err := binary.Write(&buffer, binary.LittleEndian, uint32(len(payload))); err != nil {
		return err
	}
	buffer.Write(payload)
	writeMu.Lock()
	defer writeMu.Unlock()
	_, err = os.Stdout.Write(buffer.Bytes())
	return err
}
