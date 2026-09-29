package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func enrolledInstallation(t *testing.T) (*setupServer, string) {
	t.Helper()
	server := newSetupServer(t)
	options, dir, _ := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	options.Token = func() (string, error) { return "synthetic-setup-token", nil }
	if _, err := Setup(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	return server, dir
}

func TestStatusIsReadableAndKeepsMachineFields(t *testing.T) {
	_, dir := enrolledInstallation(t)
	view, err := ReadStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	text := RenderStatus(view, time.Now())
	for _, want := range []string{"Vectory agent " + Version + " · setup-edge (5e7a9c2d)", "restricted mode", "Server     https://127.0.0.1:", "last check-in", "Vector     " + VectorVersion, "Pipeline   No pipeline assigned yet", "Next       "} {
		if !strings.Contains(text, want) {
			t.Fatalf("status lacks %q:\n%s", want, text)
		}
	}
	raw, _ := json.Marshal(StatusJSON(view))
	var document map[string]any
	_ = json.Unmarshal(raw, &document)
	for _, key := range []string{"state", "actual_sha256", "local_paused", "drift", "telemetry_available", "version", "configuration_mode", "diagnostics", "device", "server", "service", "next_step"} {
		if _, ok := document[key]; !ok {
			t.Fatalf("status JSON lacks %q", key)
		}
	}
	if device := document["device"].(map[string]any); device["name"] != "setup-edge" {
		t.Fatal(device)
	}
}

func TestStatusExplainsMissingInstallationAndLegacyLocation(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	_, err := ReadStatus(context.Background(), missing)
	var notInstalled *NotInstalledError
	if err == nil || !strings.Contains(err.Error(), "No agent is installed at "+missing) || !strings.Contains(err.Error(), "vectory setup") {
		t.Fatal(err)
	}
	if !errors.As(err, &notInstalled) {
		t.Fatal("not-installed error is not typed")
	}
}

func TestDoctorChecksTheRealConnectionAndCredential(t *testing.T) {
	server, dir := enrolledInstallation(t)
	report, err := RunDoctor(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[string]string{}
	for _, check := range report.Checks {
		statuses[check.ID] = check.Status
	}
	// The synthetic credential expires within the hour, which doctor flags.
	if statuses["identity"] != "warn" {
		t.Fatalf("short-lived credential not flagged:\n%s", RenderDoctor(report))
	}
	for _, id := range []string{"state", "vector", "managed", "mode", "dns", "tcp", "tls", "clock", "credential"} {
		if statuses[id] != "ok" {
			t.Fatalf("check %s = %q\n%s", id, statuses[id], RenderDoctor(report))
		}
	}
	text := RenderDoctor(report)
	if !strings.Contains(text, "accepted by the server as setup-edge") || !strings.Contains(text, "issued by") {
		t.Fatalf("doctor output:\n%s", text)
	}
	server.revoked.Store(true)
	report, _ = RunDoctor(context.Background(), dir)
	if !report.Failed() || !strings.Contains(RenderDoctor(report), "doesn't accept this device's credential") {
		t.Fatalf("revoked credential not reported:\n%s", RenderDoctor(report))
	}
	document := DoctorJSON(report)
	if document["ok"] != false || document["checks"] == nil || document["binary_integrity"] != true {
		t.Fatal(document)
	}
	// A broken server address is classified, and later checks are skipped.
	settings, _ := LoadSettings(dir)
	settings.Server = "https://127.0.0.1:1"
	if err := WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	report, _ = RunDoctor(context.Background(), dir)
	if !strings.Contains(RenderDoctor(report), "Nothing is accepting connections on 127.0.0.1:1") {
		t.Fatalf("refused connection not explained:\n%s", RenderDoctor(report))
	}
	_ = os.Remove(filepath.Join(dir, "identity.json"))
}
