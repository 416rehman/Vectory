package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func metricsCommand(t *testing.T, args []string) (int, string, string) {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	previous := os.Stdout
	os.Stdout = f
	defer func() { os.Stdout = previous }()
	code, stderr := bindingCommand(t, args)
	os.Stdout = previous
	data, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	return code, string(data), stderr
}

func TestMetricsEndpointCLISetReplaceClearAndJSONCompatibility(t *testing.T) {
	dir, _, before := bindingCLIState(t)
	settingsPath := filepath.Join(dir, "settings.json")
	for _, operation := range []struct {
		command, endpoint string
		jsonOutput        bool
	}{
		{"configure-metrics", "http://127.0.0.1:9800/metrics", false},
		{"configure-metrics", "http://[::1]:9801/metrics", true},
		{"configure-metrics", "", false},
		{"configure-metrics", "", true},
		{"install", "http://127.0.0.1:9802/metrics", true},
		{"install", "", true},
	} {
		args := []string{operation.command, "--state-dir", dir}
		if operation.endpoint == "" {
			args = append(args, "--clear-metrics-url")
		} else {
			args = append(args, "--metrics-url", operation.endpoint)
		}
		if operation.jsonOutput {
			args = append(args, "--json")
		}
		code, stdout, stderr := metricsCommand(t, args)
		if code != 0 || stderr != "" || operation.endpoint != "" && strings.Contains(stdout, operation.endpoint) {
			t.Fatal("metrics command failed or echoed endpoint", code, stderr)
		}
		if operation.jsonOutput {
			decoder := json.NewDecoder(strings.NewReader(stdout))
			var result map[string]any
			if err := decoder.Decode(&result); err != nil {
				t.Fatal(err)
			}
			var extra any
			if decoder.Decode(&extra) != io.EOF || result["status"] != "ok" || result["command"] != operation.command || result["metrics_collection_configured"] != (operation.endpoint != "") {
				t.Fatal("JSON success shape changed or emitted multiple documents", result)
			}
		} else {
			for _, word := range []string{"setting", "restart", "pipeline", "exporter", map[bool]string{true: "cleared", false: "saved"}[operation.endpoint == ""]} {
				if !strings.Contains(strings.ToLower(stdout), word) {
					t.Fatal("success copy omitted setting/startup boundary")
				}
			}
		}
		settings, err := agent.LoadSettings(dir)
		if err != nil || settings.MetricsURL != operation.endpoint || len(settings.SecretFiles) != 1 {
			t.Fatal("metrics CLI changed unrelated bindings", err)
		}
		state, _ := os.ReadFile(filepath.Join(dir, "state.json"))
		if !bytes.Equal(state, before[filepath.Join(dir, "state.json")]) {
			t.Fatal("metrics CLI changed state")
		}
		exact, _ := os.ReadFile(settingsPath)
		if code, _, stderr = metricsCommand(t, args); code != 0 {
			t.Fatal("repeat failed", stderr)
		}
		after, _ := os.ReadFile(settingsPath)
		if !bytes.Equal(exact, after) {
			t.Fatal("repeat rewrote settings")
		}
	}
}

func TestMetricsEndpointCLIInvalidRequestsPreserveSettings(t *testing.T) {
	for _, command := range []string{"configure-metrics", "install"} {
		t.Run(command, func(t *testing.T) {
			dir, _, _ := bindingCLIState(t)
			if err := agent.ConfigureMetrics(dir, "http://127.0.0.1:9800/metrics"); err != nil {
				t.Fatal(err)
			}
			settingsPath, statePath := filepath.Join(dir, "settings.json"), filepath.Join(dir, "state.json")
			before, _ := os.ReadFile(settingsPath)
			beforeState, _ := os.ReadFile(statePath)
			cases := []struct {
				extra []string
				code  int
			}{
				{[]string{"--clear-metrics-url=false"}, 2},
				{[]string{"--metrics-url=http://127.0.0.1:9801/metrics", "--clear-metrics-url"}, 2},
				{[]string{"--metrics-url=http://127.0.0.1:9801/metrics", "--clear-metrics-url=false"}, 2},
				{[]string{"--clear-metrics-url", "unexpected"}, 2},
				{[]string{"unexpected", "--clear-metrics-url"}, 2},
				{[]string{"--clear-metrics-url=invalid"}, 2},
				{[]string{"--metrics-url"}, 2},
				{[]string{"--metrics-url="}, 1},
				{[]string{"--metrics-url=http://localhost:9800/metrics"}, 1},
				{[]string{"--metrics-url=http://127.0.0.1:0/metrics"}, 1},
				{[]string{"--metrics-url=http://127.0.0.1:65536/metrics"}, 1},
			}
			if command == "configure-metrics" {
				cases = append(cases, struct {
					extra []string
					code  int
				}{nil, 2})
			}
			for _, test := range cases {
				code, _, stderr := metricsCommand(t, append([]string{command, "--state-dir", dir}, test.extra...))
				if code != test.code || strings.TrimSpace(stderr) == "" {
					t.Fatal("invalid request lacks expected fixed diagnostic", code, test.extra)
				}
				after, _ := os.ReadFile(settingsPath)
				state, _ := os.ReadFile(statePath)
				if !bytes.Equal(before, after) || !bytes.Equal(beforeState, state) {
					t.Fatal("invalid request mutated installed data")
				}
			}
			if command == "install" {
				code, _, stderr := metricsCommand(t, []string{"install", "--state-dir", dir})
				after, _ := os.ReadFile(settingsPath)
				if code != 0 || !bytes.Equal(before, after) {
					t.Fatal("omitted metrics option did not preserve endpoint", stderr)
				}
			}
		})
	}
}

func TestMetricsEndpointCLIHelpAndFreshRefusal(t *testing.T) {
	_, _, help := metricsCommand(t, []string{"help"})
	if !strings.Contains(help, "configure-metrics") || !strings.Contains(help, "--clear-metrics-url") || strings.ContainsAny(help, "\ufffd\u2014") {
		t.Fatal("new command not discoverable in unambiguous help")
	}
	dir := filepath.Join(t.TempDir(), "never-created")
	code, _, _ := metricsCommand(t, []string{"install", "--state-dir", dir, "--adopt", "--metrics-url=http://127.0.0.1:9800/metrics", "--clear-metrics-url"})
	if code != 2 {
		t.Fatal("fresh contradictory flags not rejected as usage")
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatal("fresh invalid command created state")
	}
}
