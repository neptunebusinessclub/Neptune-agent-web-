//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReadNativeMessage(t *testing.T) {
	payload := []byte(`{"requestId":"test","type":"ensure"}`)
	var framed bytes.Buffer
	if err := binary.Write(&framed, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatal(err)
	}
	framed.Write(payload)
	actual, err := readNativeMessage(&framed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, payload) {
		t.Fatalf("unexpected payload: %s", actual)
	}
}

func TestReadNativeMessageRejectsOversizedPayload(t *testing.T) {
	var framed bytes.Buffer
	if err := binary.Write(&framed, binary.LittleEndian, uint32(1024*1024+1)); err != nil {
		t.Fatal(err)
	}
	if _, err := readNativeMessage(&framed); err == nil {
		t.Fatal("expected oversized payload to be rejected")
	}
}

func TestLoadConnectionAcceptsOnlyLoopback(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", root)
	runtimeDir := filepath.Join(root, "Neptune", "Hermes")
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		t.Fatal(err)
	}

	valid := connection{
		Endpoint:       "http://127.0.0.1:8642",
		APIKey:         "abcdefghijklmnopqrstuvwxyz0123456789",
		Model:          "Qwen3-4B-Q4_K_M",
		RuntimeVersion: runtimeVersion,
	}
	content, _ := json.Marshal(valid)
	if err := os.WriteFile(filepath.Join(runtimeDir, "connection.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConnection(); err != nil {
		t.Fatalf("valid loopback connection rejected: %v", err)
	}

	valid.Endpoint = "https://example.com"
	content, _ = json.Marshal(valid)
	if err := os.WriteFile(filepath.Join(runtimeDir, "connection.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConnection(); err == nil {
		t.Fatal("remote endpoint should be rejected")
	}
}
