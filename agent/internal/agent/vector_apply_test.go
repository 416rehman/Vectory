package agent

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRequiredHealthchecksRejectAnUnhealthyCandidate(t *testing.T) {
	state := t.TempDir()
	calls := filepath.Join(t.TempDir(), "calls.log")
	binary := standInVector(t, fakeVectorConfig{Validate: "healthcheck", Calls: calls})
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	log := newVectorLog(state)
	t.Cleanup(log.close)
	settings := Settings{VectorBinary: binary, VectorBinarySHA256: digest, ValidationSeconds: 5}
	driver := &VectorDriver{Settings: settings, Dir: state, Log: log}
	managed := filepath.Join(t.TempDir(), "managed.json")
	config := pipeline(map[string]any{"healthchecks": map[string]any{"require_healthy": true}})
	data := writeManaged(t, managed, config)

	err = driver.Validate(context.Background(), managed)
	if failure := asVectorFailure(err); failure == nil || failure.Phase != "validate" {
		t.Fatalf("required health check was accepted: %v", err)
	}
	diagnostics := (&Engine{Dir: state, Settings: settings}).diagnoseFailure(err, data)
	if len(diagnostics) != 1 || diagnostics[0].Code != "HEALTHCHECK_REQUIRED" || diagnostics[0].Field != "healthchecks.require_healthy" || diagnostics[0].Severity != "error" {
		t.Fatalf("required health check diagnostics = %+v", diagnostics)
	}
	validations, _ := vectorCalls(t, calls)
	if len(validations) != 2 || strings.Contains(validations[0], "--skip-healthchecks") || !strings.Contains(validations[1], "--skip-healthchecks") {
		t.Fatalf("native validation attempts = %v", validations)
	}

	config["healthchecks"] = map[string]any{"require_healthy": false}
	writeManaged(t, managed, config)
	if err := driver.Validate(context.Background(), managed); err != nil {
		t.Fatalf("optional failing health check blocked the candidate: %v", err)
	}
	validations, _ = vectorCalls(t, calls)
	if len(validations) != 4 || !strings.Contains(validations[3], "--skip-healthchecks") {
		t.Fatalf("optional health check did not use fallback: %v", validations)
	}
}

func TestAPIChangesRequireRestartInsteadOfReload(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Vector reloads only on Unix")
	}
	api, err := apiConfiguration([]byte(`{"api":{"enabled":true,"address":"127.0.0.1:8686"}}`))
	if err != nil {
		t.Fatal(err)
	}
	driver := &VectorDriver{Dir: t.TempDir(), done: make(chan struct{}), verified: true, apiKnown: true, activeAPI: api}
	for _, tc := range []struct {
		name, config string
		reload       bool
	}{
		{"unchanged API", `{"api":{"address":"127.0.0.1:8686","enabled":true},"sources":{}}`, true},
		{"new address", `{"api":{"address":"127.0.0.1:8541","enabled":true}}`, false},
		{"API removed", `{"sources":{}}`, false},
		{"API disabled", `{"api":{"address":"127.0.0.1:8686","enabled":false}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate, err := apiConfiguration([]byte(tc.config))
			if err != nil {
				t.Fatal(err)
			}
			if got := driver.canReload(candidate); got != tc.reload {
				t.Fatalf("canReload = %v, want %v", got, tc.reload)
			}
		})
	}
	driver.activeAPI = nil
	if driver.canReload(api) {
		t.Fatal("enabling API on a live process would reload")
	}
	close(driver.done)
	if driver.canReload(nil) {
		t.Fatal("an exited Vector process would reload")
	}
}
