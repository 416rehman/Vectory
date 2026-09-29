package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func TestInstallCLIUpdatesAllowancesAndKeepsModeExplicit(t *testing.T) {
	dir := t.TempDir()
	settings := agent.Settings{VectorBinary: "fixed-vector", ManagedConfig: "fixed-config", CapabilityPolicy: agent.CapabilityPolicy{FullVectorConfig: true}}
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(dir, agent.State{ApplyState: "unmanaged", Policy: agent.Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	policy := filepath.Join(t.TempDir(), "capabilities.json")
	if err := agent.WriteJSON(policy, agent.CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.test:443"}}); err != nil {
		t.Fatal(err)
	}
	args := []string{"install", "--state-dir", dir, "--capability-policy", policy}
	if code := run(args); code != 0 {
		t.Fatalf("local update failed: exit %d", code)
	}
	got, err := agent.LoadSettings(dir)
	if err != nil || !got.CapabilityPolicy.FullVectorConfig || len(got.CapabilityPolicy.AllowedNetworkHosts) != 1 || got.CapabilityPolicy.AllowedNetworkHosts[0] != "logs.example.test:443" {
		t.Fatal("install flag failed to apply allowances or silently changed mode", err)
	}
	if code := run(append(args, "--allow-full-vector-config=false")); code != 0 {
		t.Fatalf("explicit restricted mode failed: exit %d", code)
	}
	got, err = agent.LoadSettings(dir)
	if err != nil || got.CapabilityPolicy.FullVectorConfig || len(got.CapabilityPolicy.AllowedNetworkHosts) != 1 {
		t.Fatal("explicit mode change lost updated allowances", err)
	}
	unlock, err := agent.Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if code := run(args); code == 0 {
		t.Fatal("CLI reported success while agent was running")
	}
}

func TestInstallCLIRejectsIncompleteOrInvalidCombinedOptions(t *testing.T) {
	for _, extra := range [][]string{
		{"--metrics-url=bad"}, {"--metrics-url="}, {"--metrics-url=http://127.0.0.1:0/metrics"},
		{"--capability-policy="}, {"--secret-files="}, {"--vector-binary="}, {"--managed-config="},
		{"unexpected", "--metrics-url=bad"}, {"--unknown-option"},
	} {
		t.Run(extra[0], func(t *testing.T) {
			dir := t.TempDir()
			settings := agent.Settings{VectorBinary: "fixed-vector", ManagedConfig: "fixed-config"}
			path := filepath.Join(dir, "settings.json")
			if err := agent.WriteJSON(path, settings); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			args := append([]string{"install", "--state-dir", dir, "--allow-full-vector-config"}, extra...)
			if code := run(args); code == 0 {
				t.Fatal("invalid explicit option/positional accepted")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("invalid later option committed earlier mode")
			}
		})
	}
}
