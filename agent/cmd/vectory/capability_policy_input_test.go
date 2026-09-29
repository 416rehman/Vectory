package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func TestCapabilityPolicyCLIRejectsLossyInputsBeforeComposedChanges(t *testing.T) {
	dir, _, before := bindingCLIState(t)
	root := filepath.Join(t.TempDir(), "replacement-\ufffd")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(root)
	valid := `{"allowed_file_roots":[` + string(encoded) + `]}`
	for name, raw := range map[string][]byte{
		"utf8": bytes.ReplaceAll([]byte(valid), []byte("\ufffd"), []byte{0xff}),
		"high": []byte(strings.ReplaceAll(valid, "\ufffd", `\ud800`)),
		"low":  []byte(strings.ReplaceAll(valid, "\ufffd", `\udfff`)),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "operator-policy.json")
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			options := []string{"--capability-policy", path, "--allow-full-vector-config", "--metrics-url=http://127.0.0.1:9800/metrics"}
			code, diagnostic := bindingCommand(t, append([]string{"install", "--state-dir", dir}, options...))
			if code != 1 || !strings.Contains(diagnostic, "UTF-8") || strings.Contains(diagnostic, root) || strings.Contains(diagnostic, path) {
				t.Fatal("lossy policy lacked fixed refusal diagnostic", code)
			}
			for path, expected := range before {
				actual, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(expected, actual) {
					t.Fatal("invalid policy partially applied other options", err)
				}
			}
			fresh := filepath.Join(t.TempDir(), "uncreated-state")
			code, diagnostic = bindingCommand(t, append([]string{"install", "--state-dir", fresh, "--adopt"}, options...))
			if code != 1 || !strings.Contains(diagnostic, "UTF-8") {
				t.Fatal("fresh malformed input not refused at input boundary")
			}
			if _, err := os.Lstat(fresh); !os.IsNotExist(err) {
				t.Fatal("malformed input created fresh state")
			}
		})
	}
}

func TestCapabilityPolicyCLIValidUnicodeAndEquivalentSpellingNoop(t *testing.T) {
	dir, _, _ := bindingCLIState(t)
	root := filepath.Join(t.TempDir(), "reviewed-\ufffd-\U0001f511")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(agent.CapabilityPolicy{FullVectorConfig: true, AllowedFileRoots: []string{root}})
	path := filepath.Join(t.TempDir(), "operator-policy.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"install", "--state-dir", dir, "--capability-policy", path}
	if code, diagnostic := bindingCommand(t, args); code != 0 {
		t.Fatal("valid Unicode policy refused", diagnostic)
	}
	settings, err := agent.LoadSettings(dir)
	if err != nil || settings.CapabilityPolicy.FullVectorConfig || len(settings.CapabilityPolicy.AllowedFileRoots) != 1 || settings.CapabilityPolicy.AllowedFileRoots[0] != root {
		t.Fatal("valid root changed or policy file granted mode", err)
	}
	settingsPath, statePath := filepath.Join(dir, "settings.json"), filepath.Join(dir, "state.json")
	before, _ := os.ReadFile(settingsPath)
	beforeState, _ := os.ReadFile(statePath)
	escaped := strings.ReplaceAll(string(raw), "\ufffd", `\ufffd`)
	escaped = strings.ReplaceAll(escaped, "\U0001f511", `\ud83d\udd11`)
	if err = os.WriteFile(path, []byte(escaped), 0600); err != nil {
		t.Fatal(err)
	}
	if code, diagnostic := bindingCommand(t, args); code != 0 {
		t.Fatal("valid escaped policy refused", diagnostic)
	}
	after, _ := os.ReadFile(settingsPath)
	afterState, _ := os.ReadFile(statePath)
	if !bytes.Equal(before, after) || !bytes.Equal(beforeState, afterState) {
		t.Fatal("equivalent spelling rewrote settings or state")
	}
}
