package main

import (
	"encoding/json"
	"github.com/vectory/vectory/agent/internal/agent"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoctorJSONFailureIsOneDiagnosticDocument(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "vector.exe")
	if err := os.WriteFile(binary, []byte("untrusted replacement; must not execute"), 0600); err != nil {
		t.Fatal(err)
	}
	s := agent.Settings{Adopted: true, VectorBinary: binary, VectorBinarySHA256: strings.Repeat("a", 64), ManagedConfig: filepath.Join(dir, "managed.json")}
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(dir, agent.State{ApplyState: "failed"}); err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	os.Stdout = w
	defer func() { os.Stdout = stdout }()
	exit := run([]string{"doctor", "--state-dir", dir, "--json"})
	_ = w.Close()
	os.Stdout = stdout
	decoder := json.NewDecoder(r)
	var report map[string]any
	if err = decoder.Decode(&report); err != nil {
		t.Fatal(err)
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		t.Fatal("doctor emitted multiple JSON values")
	}
	if exit != 1 || report["binary_integrity"] != false || !strings.Contains(report["error"].(string), "re-adopt") {
		t.Fatal(exit, report)
	}
	diagnostics := report["diagnostics"].(map[string]any)
	if !strings.Contains(diagnostics["next_action"].(string), "re-adopt") {
		t.Fatal("doctor kept unrelated retry guidance", diagnostics)
	}
}
