package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDoctorNeverExecutesChangedOrMissingBinary(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "vector.exe")
	original := []byte("explicitly adopted fixture executable")
	if err := os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	s := Settings{VectorBinary: binary, VectorBinarySHA256: Digest(original), ManagedConfig: filepath.Join(dir, "managed.json"), Adopted: true}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		t.Fatal(err)
	}
	probes := 0
	probe := func(context.Context, Settings) (string, error) { probes++; return VectorVersion, nil }
	report, err := doctorWithProbe(context.Background(), dir, probe)
	if err != nil || probes != 1 || report["binary_integrity"] != true {
		t.Fatalf("adopted probe failed: %v, %v", report, err)
	}
	if err := os.WriteFile(binary, []byte("replacement executable must never run"), 0600); err != nil {
		t.Fatal(err)
	}
	report, err = doctorWithProbe(context.Background(), dir, probe)
	if err == nil || probes != 1 || report["binary_integrity"] != false || report["vector_version"] != "" {
		t.Fatalf("changed binary probed or reported verified: %v, %v", report, err)
	}
	if err := os.Remove(binary); err != nil {
		t.Fatal(err)
	}
	if _, err = doctorWithProbe(context.Background(), dir, probe); err == nil || probes != 1 {
		t.Fatal("missing executable passed diagnostic preflight")
	}
}

func snapshotDiagnosticFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	files := map[string]string{}
	if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			files[path] = string(data)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return files
}

func TestLocalDiagnosticsExplainRejectedCandidateWithoutMutationOrSecrets(t *testing.T) {
	e, m, _, secretPath := secretFixture(t)
	const secret = "private-diagnostic-token-not-for-output"
	if err := AtomicWrite(secretPath, []byte(secret)); err != nil {
		t.Fatal(err)
	}
	e.Settings.CapabilityPolicy.AllowedNetworkHosts = nil
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("expected local destination denial")
	}
	if e.actual() != Digest(oldConfig) {
		t.Fatal("failed candidate changed managed last-good file")
	}
	if err := WriteJSON(filepath.Join(e.Dir, "settings.json"), e.Settings); err != nil {
		t.Fatal(err)
	}
	before := snapshotDiagnosticFiles(t, e.Dir)
	report, err := StateSummary(e.Dir)
	if err != nil {
		t.Fatal(err)
	}
	d := report["diagnostics"].(LocalDiagnostics)
	if d.DesiredConfiguration.Reason != "NETWORK_DESTINATION_DENIED" || d.RetryStatus != "suppressed" || !strings.Contains(d.DesiredConfiguration.NextAction, "allowed_network_hosts") {
		t.Fatalf("not actionable: %+v", d)
	}
	output, err := json.Marshal(report)
	if err != nil || bytes.Contains(output, []byte(secret)) || bytes.Contains(output, []byte("sink.example")) || bytes.Contains(output, []byte(secretPath)) {
		t.Fatal("diagnostics exposed configuration, secret or binding path", err)
	}
	if after := snapshotDiagnosticFiles(t, e.Dir); !reflect.DeepEqual(before, after) {
		t.Fatal("read-only diagnostics changed state, managed file, cache or recovery content")
	}
	if err := AtomicWrite(secretPath, []byte("rotated-local-value")); err != nil {
		t.Fatal(err)
	}
	rotated, err := StateSummary(e.Dir)
	if err != nil || rotated["diagnostics"].(LocalDiagnostics).RetryStatus != "not_suppressed" {
		t.Fatal("changed secret incorrectly reported as suppressed", err)
	}
	if !reflect.DeepEqual(before, snapshotDiagnosticFiles(t, e.Dir)) {
		t.Fatal("inspection advanced a secret revision or altered suppression")
	}
	if err := os.Remove(secretPath); err != nil {
		t.Fatal(err)
	}
	unavailable, err := StateSummary(e.Dir)
	if err != nil {
		t.Fatal(err)
	}
	d = unavailable["diagnostics"].(LocalDiagnostics)
	if d.DesiredConfiguration.Check != "materialization_failed" || d.RetryStatus != "unknown" {
		t.Fatalf("missing secret was not distinguished: %+v", d)
	}
}

func TestLocalDiagnosticsNeverTrustCorruptOrMissingDesiredCache(t *testing.T) {
	e, m, _, _ := secretFixture(t)
	e.State.FailedGeneration = &m.Generation
	path := filepath.Join(e.Dir, "template-"+m.Desired.SHA256+".json")
	for _, mode := range []string{"missing", "changed", "wrong-size", "unsafe-digest"} {
		t.Run(mode, func(t *testing.T) {
			state := e.State
			wanted := *state.Desired
			state.Desired = &wanted
			switch mode {
			case "changed":
				if err := AtomicWrite(path, []byte(`{"private":"do not inspect unverified content"}`)); err != nil {
					t.Fatal(err)
				}
			case "wrong-size":
				if err := AtomicWrite(path, secretTemplate("https://sink.example/events")); err != nil {
					t.Fatal(err)
				}
				wanted.Size++
			case "unsafe-digest":
				wanted.SHA256 = "../../identity"
			}
			d := localDiagnostics(e.Dir, e.Settings, state)
			if d.DesiredConfiguration.Check != "unavailable" || d.RetryStatus != "unknown" {
				t.Fatalf("unverified template inspected: %+v", d)
			}
		})
	}
}

func TestLocalDiagnosticsFullModeAndPauseRemainExplicit(t *testing.T) {
	data := []byte(`{"secret":{"native":{"type":"exec","command":["must-not-execute"]}},"sources":{"host":{"type":"host_metrics"}},"unknown_future":{"value":"SECRET[native.value] ${PRIVATE_ENV}"}}`)
	e, m, _ := fixture(t, data)
	if err := AtomicWrite(filepath.Join(e.Dir, "template-"+m.Desired.SHA256+".json"), data); err != nil {
		t.Fatal(err)
	}
	if d := localDiagnostics(e.Dir, e.Settings, e.State); d.DesiredConfiguration.Check != "capability_denied" {
		t.Fatalf("restricted mode was weakened: %+v", d)
	}
	e.Settings.CapabilityPolicy.FullVectorConfig = true
	d := localDiagnostics(e.Dir, e.Settings, e.State)
	if d.DesiredConfiguration.Check != "capability_allowed" || !strings.Contains(d.DesiredConfiguration.NextAction, "have not been rechecked") {
		t.Fatalf("full mode claimed native verification: %+v", d)
	}
	e.State.Policy.SyncPaused = true
	if !strings.Contains(localDiagnostics(e.Dir, e.Settings, e.State).NextAction, "Remote pause") {
		t.Fatal("remote pause was hidden")
	}
	if err := SetPause(e.Dir, true); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(localDiagnostics(e.Dir, e.Settings, e.State).NextAction, "Local pause") {
		t.Fatal("local pause was hidden by remote pause")
	}
	if strings.Contains(capabilityDiagnostic("future checker error containing secret-value").NextAction, "secret-value") {
		t.Fatal("raw error escaped category mapping")
	}
}

func TestNativeDoctorProbesVersionWithoutValidatingDesiredProviders(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native doctor probe")
	}
	data := []byte(`{"secret":{"native":{"type":"file","path":"missing-native-provider-file"}},"invalid_native_setting":"SECRET[native.value]"}`)
	e, m, _ := fixture(t, data)
	e.Settings.VectorBinary = binary
	var err error
	e.Settings.VectorBinarySHA256, err = FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	e.Settings.CapabilityPolicy.FullVectorConfig = true
	if err := WriteJSON(filepath.Join(e.Dir, "settings.json"), e.Settings); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(e.Dir, "template-"+m.Desired.SHA256+".json"), data); err != nil {
		t.Fatal(err)
	}
	before := snapshotDiagnosticFiles(t, e.Dir)
	report, err := Doctor(context.Background(), e.Dir)
	if err != nil || report["vector_version"] != VectorVersion || report["binary_integrity"] != true {
		t.Fatalf("native doctor failed: %v, %v", report, err)
	}
	if report["diagnostics"].(LocalDiagnostics).DesiredConfiguration.Check != "capability_allowed" {
		t.Fatal("full-mode capability check failed")
	}
	if !reflect.DeepEqual(before, snapshotDiagnosticFiles(t, e.Dir)) {
		t.Fatal("doctor wrote local state or native provider configuration")
	}
}
