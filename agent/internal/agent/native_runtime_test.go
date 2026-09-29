package agent

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func nativeRuntimeFixture(t *testing.T) (*Engine, *VectorDriver) {
	t.Helper()
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native Vector runtime tests")
	}
	previous := vectorDefaultDataDirProbe
	t.Cleanup(func() { vectorDefaultDataDirProbe = previous })
	vectorDefaultDataDirProbe = filepath.Join(t.TempDir(), "absent")
	state, managed := t.TempDir(), t.TempDir()
	settings := Settings{VectorBinary: binary, ManagedConfig: filepath.Join(managed, "managed.json"), Adopted: true, ValidationSeconds: 30, StartupSeconds: 20, GracefulShutdownSeconds: 5, CapabilityPolicy: CapabilityPolicy{FullVectorConfig: true}}
	var err error
	if settings.VectorBinarySHA256, err = FileDigest(binary); err != nil {
		t.Fatal(err)
	}
	log := newVectorLog(state)
	driver := &VectorDriver{Settings: settings, Dir: state, Log: log}
	t.Cleanup(func() { _ = driver.Stop(); log.close() })
	return &Engine{Dir: state, Settings: settings, Driver: driver, Log: log}, driver
}

func writeManaged(t *testing.T, path string, config map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = AtomicWrite(path, data); err != nil {
		t.Fatal(err)
	}
	return data
}

func pipeline(extra map[string]any) map[string]any {
	config := map[string]any{
		"sources": map[string]any{"app": map[string]any{"type": "demo_logs", "format": "syslog", "interval": 0.2}},
		"sinks":   map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"app"}}},
	}
	for k, v := range extra {
		config[k] = v
	}
	return config
}

// A configuration that fails to load on reload ends with Vector's "Failed to
// load config files, reload aborted." The agent reports it at once instead of
// waiting out its startup timeout.
func TestNativeReloadOfAConfigurationThatFailsToLoadFailsAtOnce(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native Vector runtime tests")
	}
	if runtime.GOOS == "windows" {
		t.Skip("Vector on Windows has no reload; the agent restarts it")
	}
	dir := t.TempDir()
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	managed := filepath.Join(dir, "managed.json")
	pipelineReading := func(input string) {
		t.Helper()
		writeManaged(t, managed, map[string]any{
			"data_dir": dir,
			"sources":  map[string]any{"in": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.5}},
			"sinks":    map[string]any{"out": map[string]any{"type": "blackhole", "inputs": []string{input}, "print_interval_secs": 0}},
		})
	}
	driver := &VectorDriver{Dir: dir, Settings: Settings{Adopted: true, VectorBinary: binary, VectorBinarySHA256: digest, StartupSeconds: 20, GracefulShutdownSeconds: minGracefulShutdownSeconds}}
	t.Cleanup(func() {
		_ = driver.Stop()
		if driver.Log != nil {
			driver.Log.close()
		}
	})
	pipelineReading("in")
	ctx := context.Background()
	if err = driver.Activate(ctx, managed); err != nil {
		t.Fatal(err)
	}
	pipelineReading("missing")
	started := time.Now()
	err = driver.reload(ctx)
	took := time.Since(started)
	var verdict string
	for _, line := range driver.Log.recent() {
		if rec, ok := parseVectorRecord([]byte(line)); ok && rec.Target == "vector::internal_events::process" {
			verdict = line
		}
	}
	if err == nil || took > 10*time.Second || !strings.Contains(verdict, "Failed to load config files, reload aborted.") {
		t.Fatalf("reload of a configuration that fails to load: %v after %s; verdict %s", err, took, verdict)
	}
	t.Logf("reported after %s: %s", took.Round(time.Millisecond), verdict)
}

func TestNativeHostDataDirHealthchecksReloadAndDiagnostics(t *testing.T) {
	e, driver := nativeRuntimeFixture(t)
	ctx := context.Background()
	managed := e.Settings.ManagedConfig

	// A pipeline without data_dir runs with the device's own data directory.
	writeManaged(t, managed, pipeline(nil))
	if err := driver.Validate(ctx, managed); err != nil {
		t.Fatalf("validation must use the host data directory: %v %+v", err, e.diagnoseFailure(err, nil))
	}
	if err := driver.Activate(ctx, managed); err != nil {
		t.Fatalf("activation: %v %+v", err, e.diagnoseFailure(err, nil))
	}
	if driver.ActivationMethod() != activationRestart || !driver.Alive() {
		t.Fatal("first activation must start and verify Vector")
	}
	if info, err := os.Stat(agentDataDir(e.Dir)); err != nil || !info.IsDir() {
		t.Fatal("agent data directory was not created")
	}
	overlay, _ := os.ReadFile(hostRuntimePath(e.Dir))
	if !strings.Contains(string(overlay), agentDataDir(e.Dir)) {
		t.Fatalf("host runtime overlay = %s", overlay)
	}

	// An unreachable destination is a warning, never a rejection; Unix
	// reloads the live process in place.
	unreachable := pipeline(map[string]any{"sinks": map[string]any{
		"discard": map[string]any{"type": "blackhole", "inputs": []string{"app"}},
		"es":      map[string]any{"type": "elasticsearch", "inputs": []string{"app"}, "endpoints": []string{"http://127.0.0.1:1"}, "api_version": "v8"},
	}})
	writeManaged(t, managed, unreachable)
	if err := driver.Validate(ctx, managed); err != nil {
		t.Fatalf("a failing health check rejected the configuration: %v", err)
	}
	if err := driver.Activate(ctx, managed); err != nil {
		t.Fatalf("activation with an unreachable destination: %v %+v", err, e.diagnoseFailure(err, nil))
	}
	if runtime.GOOS != "windows" && driver.ActivationMethod() != activationReload {
		t.Fatalf("expected an in-place reload, got %q", driver.ActivationMethod())
	}
	r := e.redactorFor(writeManaged(t, managed, unreachable))
	deadline := time.Now().Add(10 * time.Second)
	var found bool
	for !found && time.Now().Before(deadline) {
		for _, s := range e.Log.summaries(r) {
			found = found || s.ComponentID == "es" && s.Reason == "connection_refused"
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !found {
		t.Fatalf("destination errors not summarized: %+v", e.Log.summaries(r))
	}

	// A cold start with the unreachable destination also succeeds: the agent
	// no longer forces --require-healthy.
	if err := driver.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := driver.Activate(ctx, managed); err != nil || driver.ActivationMethod() != activationRestart {
		t.Fatalf("cold start with an unreachable destination: %v", err)
	}

	// Broken VRL is rejected with a precise, redacted diagnostic.
	stage := filepath.Join(filepath.Dir(managed), ".vectory-stage-00ff.json")
	broken := writeManaged(t, stage, pipeline(map[string]any{
		"transforms": map[string]any{"tag": map[string]any{"type": "remap", "inputs": []string{"app"}, "source": ".status_code = to_int(.status)"}},
		"sinks":      map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"tag"}}},
	}))
	err := driver.Validate(ctx, stage)
	diagnostics := e.diagnoseFailure(err, broken)
	_ = os.Remove(stage)
	if err == nil || len(diagnostics) == 0 || diagnostics[0].Code != "VRL_E103" || diagnostics[0].ComponentID != "tag" || diagnostics[0].Line != 1 || diagnostics[0].Hint == "" {
		t.Fatalf("VRL diagnostics = %v %+v", err, diagnostics)
	}

	// Vector cannot reload a data_dir change; the agent restarts instead and
	// still requires the startup acknowledgment.
	moved := t.TempDir()
	writeManaged(t, managed, pipeline(map[string]any{"data_dir": moved}))
	if err = driver.Activate(ctx, managed); err != nil || driver.ActivationMethod() != activationRestart || !driver.Alive() {
		t.Fatalf("restart fallback after a refused reload: %v method=%s", err, driver.ActivationMethod())
	}

	// A listener conflict fails activation with the address and component.
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	address := busy.Addr().String()
	conflict := writeManaged(t, managed, map[string]any{
		"sources": map[string]any{"ingest": map[string]any{"type": "http_server", "address": address, "decoding": map[string]any{"codec": "json"}}},
		"sinks":   map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"ingest"}}},
	})
	if err = driver.Stop(); err != nil {
		t.Fatal(err)
	}
	err = driver.Activate(ctx, managed)
	diagnostics = e.diagnoseFailure(err, conflict)
	if err == nil || len(diagnostics) == 0 || diagnostics[0].Code != "ADDRESS_IN_USE" || diagnostics[0].ComponentID != "ingest" || !strings.Contains(diagnostics[0].Message, address) {
		t.Fatalf("listener conflict diagnostics = %v %+v", err, diagnostics)
	}

	// Stopping honors the bounded graceful limit.
	writeManaged(t, managed, pipeline(nil))
	if err = driver.Activate(ctx, managed); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err = driver.Stop(); err != nil || time.Since(started) > driver.stopGrace() {
		t.Fatalf("stop took %s: %v", time.Since(started), err)
	}
	var local strings.Builder
	if err = WriteVectorLog(ctx, e.Dir, 2000, false, true, &local); err != nil || !strings.Contains(local.String(), "Vector has reloaded.") || !strings.Contains(local.String(), "vector validate rejected the configuration") {
		t.Fatalf("local Vector log incomplete: %v", err)
	}
}
