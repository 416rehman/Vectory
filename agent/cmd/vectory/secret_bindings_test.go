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

func bindingCommand(t *testing.T, args []string) (int, string) {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	previous := os.Stderr
	os.Stderr = f
	defer func() { os.Stderr = previous }()
	code := run(args)
	os.Stderr = previous
	data, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	return code, string(data)
}

func bindingCLIState(t *testing.T) (string, string, map[string][]byte) {
	t.Helper()
	dir := t.TempDir()
	// Canonical path: Windows CI uses an 8.3 short TEMP that private-file
	// checks treat as an alias.
	private, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(private, "private-synthetic-secret")
	if err := agent.AtomicWrite(secret, []byte("private-content-never-echo")); err != nil {
		t.Fatal(err)
	}
	s := agent.Settings{SecretFiles: map[string]string{"OLD": secret}}
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(dir, agent.State{ApplyState: "unmanaged", HighestGeneration: 7}); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, name := range []string{"settings.json", "state.json"} {
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		files[path] = data
	}
	return dir, secret, files
}

func TestConfigureSecretsCLIRequiresExplicitFlagsOnly(t *testing.T) {
	for _, extra := range [][]string{
		{}, {"--secret-files="}, {"--secret-files"}, {"unexpected"},
		{"unexpected", "--secret-files=unused"}, {"--secret-files=unused", "unexpected"},
	} {
		t.Run(strings.Join(extra, " "), func(t *testing.T) {
			dir, _, before := bindingCLIState(t)
			code, diagnostic := bindingCommand(t, append([]string{"configure-secrets", "--state-dir", dir}, extra...))
			if code != 2 || strings.TrimSpace(diagnostic) == "" {
				t.Fatal("invalid usage needs a diagnostic and exit 2", code)
			}
			for path, data := range before {
				after, _ := os.ReadFile(path)
				if !bytes.Equal(data, after) {
					t.Fatal("usage error changed installed files")
				}
			}
			if strings.Contains(diagnostic, "unexpected\"") || strings.Contains(diagnostic, dir) {
				t.Fatal("fixed diagnostic disclosed arguments")
			}
		})
	}
}

func TestSecretBindingsCommandsShareStrictInputAndPreservePriorSettings(t *testing.T) {
	for _, command := range []string{"configure-secrets", "install"} {
		t.Run(command, func(t *testing.T) {
			dir, secret, before := bindingCLIState(t)
			encoded, _ := json.Marshal(secret)
			for label, body := range map[string][]byte{
				"null": []byte("null"), "array": []byte("[]"),
				"duplicate":         []byte(`{"TOKEN":` + string(encoded) + `,"TOKEN":` + string(encoded) + `}`),
				"escaped-duplicate": []byte(`{"TOKEN":` + string(encoded) + `,"\u0054OKEN":` + string(encoded) + `}`),
				"trailing":          []byte(`{} {}`), "null-path": []byte(`{"TOKEN":null}`),
				"invalid-utf8": append([]byte(`{"TOKEN":"`), append([]byte{0xff}, []byte(`"}`)...)...),
			} {
				t.Run(label, func(t *testing.T) {
					path := filepath.Join(t.TempDir(), "bindings.json")
					if err := os.WriteFile(path, body, 0600); err != nil {
						t.Fatal(err)
					}
					args := []string{command, "--state-dir", dir, "--secret-files", path}
					if command == "install" {
						args = append(args, "--allow-full-vector-config")
					}
					code, diagnostic := bindingCommand(t, args)
					if code != 1 || !strings.Contains(diagnostic, "secret bindings") {
						t.Fatal("invalid input was accepted or lacks useful diagnostic", code, diagnostic)
					}
					for _, sensitive := range []string{path, secret, "TOKEN", "private-content-never-echo"} {
						if strings.Contains(diagnostic, sensitive) {
							t.Fatal("error disclosed binding input")
						}
					}
					for file, data := range before {
						after, _ := os.ReadFile(file)
						if !bytes.Equal(data, after) {
							t.Fatal("invalid input changed installed files")
						}
					}
				})
			}
		})
	}
}

func TestConfigureSecretsCLIExplicitClearAndRepeat(t *testing.T) {
	dir, secret, before := bindingCLIState(t)
	path := filepath.Join(t.TempDir(), "bindings.json")
	for _, bindings := range []map[string]string{{"NEW": secret}, {}} {
		if err := agent.WriteJSON(path, bindings); err != nil {
			t.Fatal(err)
		}
		args := []string{"configure-secrets", "--state-dir", dir, "--secret-files", path}
		if code, diagnostic := bindingCommand(t, args); code != 0 {
			t.Fatal("explicit replacement failed", diagnostic)
		}
		settings, err := agent.LoadSettings(dir)
		if err != nil || len(settings.SecretFiles) != len(bindings) || settings.SecretFiles["NEW"] != bindings["NEW"] {
			t.Fatal("command did not replace entire binding map", err)
		}
		settingsPath := filepath.Join(dir, "settings.json")
		exact, _ := os.ReadFile(settingsPath)
		if code, diagnostic := bindingCommand(t, args); code != 0 {
			t.Fatal("repeat failed", diagnostic)
		}
		after, _ := os.ReadFile(settingsPath)
		statePath := filepath.Join(dir, "state.json")
		state, _ := os.ReadFile(statePath)
		if !bytes.Equal(exact, after) || !bytes.Equal(before[statePath], state) {
			t.Fatal("repeat rewrote settings or changed historical state")
		}
	}
}
