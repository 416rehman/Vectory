package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestMetricsEndpointLifecyclePreservesUnrelatedState(t *testing.T) {
	f := maintenanceFixture(t)
	path := filepath.Join(f.dir, "settings.json")
	before := maintenanceFields(t, path)
	for _, endpoint := range []string{"", "http://127.0.0.1:9800/metrics", "http://[::1]:9801/metrics", ""} {
		apply := func() error { return ClearMetrics(f.dir) }
		if endpoint != "" {
			apply = func() error { return ConfigureMetrics(f.dir, endpoint) }
		}
		if err := apply(); err != nil {
			t.Fatal(err)
		}
		s, err := LoadSettings(f.dir)
		if err != nil || s.MetricsURL != endpoint {
			t.Fatal("metrics setting did not change as requested", err)
		}
		after := maintenanceFields(t, path)
		for key, value := range before {
			if key != "metrics_url" && !equalRawJSON(value, after[key]) {
				t.Fatalf("changed unrelated settings field %s", key)
			}
		}
		for file, expected := range f.files {
			if file != path {
				actual, err := os.ReadFile(file)
				if err != nil || !bytes.Equal(expected, actual) {
					t.Fatal("metrics maintenance changed state, identity, pause or workload", err)
				}
			}
		}
		exact, _ := os.ReadFile(path)
		exact = append([]byte("\n\t"), append(exact, '\n')...)
		if err := os.WriteFile(path, exact, 0600); err != nil {
			t.Fatal(err)
		}
		if err := apply(); err != nil {
			t.Fatal(err)
		}
		repeated, _ := os.ReadFile(path)
		if !bytes.Equal(exact, repeated) {
			t.Fatal("repeat changed original settings bytes")
		}
	}
}

func TestMetricsEndpointRefusalsAndInstallComposition(t *testing.T) {
	f := maintenanceFixture(t)
	unchanged := func() {
		t.Helper()
		for path, expected := range f.files {
			actual, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(expected, actual) {
				t.Fatal("refused request changed installed data", err)
			}
		}
	}
	for _, endpoint := range []string{"", "http://localhost:9800/metrics", "http://192.0.2.1:9800/metrics", "https://127.0.0.1:9800/metrics", "http://127.0.0.1:0/metrics", "http://127.0.0.1:65536/metrics", "http://user:private@127.0.0.1:9800/metrics", "http://127.0.0.1:9800/metrics?query=private", "http://127.0.0.1:9800/events"} {
		if err := ConfigureMetrics(f.dir, endpoint); err == nil {
			t.Fatal("invalid endpoint was accepted")
		}
		unchanged()
	}
	for _, options := range []InstallOptions{
		{ClearMetricsURL: true, MetricsURL: optionPointer("http://127.0.0.1:9800/metrics")},
		{ClearMetricsURL: true, FullVectorConfig: optionPointer(true), SecretFiles: optionPointer(map[string]string{"TOKEN": "relative"})},
		{ClearMetricsURL: true, CapabilityPolicy: &CapabilityPolicy{AllowedNetworkHosts: []string{"invalid"}}},
	} {
		if InstallWithOptions(context.Background(), f.dir, options) == nil {
			t.Fatal("invalid combined option accepted")
		}
		unchanged()
	}
	unlock, err := Lock(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	if ClearMetrics(f.dir) == nil || ConfigureMetrics(f.dir, "http://127.0.0.1:9800/metrics") == nil {
		unlock()
		t.Fatal("metrics maintenance bypassed active agent lock")
	}
	unlock()
	unchanged()
	if err = InstallWithOptions(context.Background(), f.dir, InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	unchanged()
	if err = InstallWithOptions(context.Background(), f.dir, InstallOptions{ClearMetricsURL: true, SecretFiles: optionPointer(map[string]string{})}); err != nil {
		t.Fatal(err)
	}
	s, _ := LoadSettings(f.dir)
	if s.MetricsURL != "" || len(s.SecretFiles) != 0 {
		t.Fatal("combined clear and bindings replacement not composed")
	}
	state, _ := os.ReadFile(filepath.Join(f.dir, "state.json"))
	if !bytes.Equal(state, f.files[filepath.Join(f.dir, "state.json")]) {
		t.Fatal("metrics-only composition consumed failure suppression")
	}
}

func TestMetricsEndpointFreshContradictionHasNoEffects(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "state")
	called := false
	err := installWithOptions(context.Background(), dir, InstallOptions{Adopt: true, MetricsURL: optionPointer("http://127.0.0.1:9800/metrics"), ClearMetricsURL: true}, func(context.Context, Settings) (string, error) {
		called = true
		return VectorVersion, nil
	})
	if err == nil || called {
		t.Fatal("contradictory fresh options reached native preflight")
	}
	if _, err = os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatal("invalid fresh request created installation state")
	}
}

func TestMetricsEndpointClearReloadDisablesCollectorWithoutChangingPolicy(t *testing.T) {
	dir := t.TempDir()
	ca := makeCA(t)
	key, csr, err := EnsureKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(csr))
	request, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	public, signing, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour).Truncate(time.Second)
	cred := Credentials{DeviceID: "metrics-device", CertificatePEM: ca.issue(t, request.PublicKey, "metrics-device", false, expires), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(public), CertificateExpiresAt: expires}
	if err = StoreIdentity(dir, cred, key); err != nil {
		t.Fatal(err)
	}
	var scrapes atomic.Int32
	exporter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scrapes.Add(1)
		_, _ = w.Write([]byte("component_errors_total 3\n"))
	}))
	defer exporter.Close()
	heartbeats := make(chan Heartbeat, 3)
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var h Heartbeat
		if r.URL.Path != "/agent/v1/heartbeat" || json.NewDecoder(r.Body).Decode(&h) != nil {
			http.Error(w, "invalid fixture request", 400)
			return
		}
		heartbeats <- h
		now := time.Now().UTC()
		m := Manifest{ProtocolVersion: 1, DeviceID: cred.DeviceID, Nonce: h.Nonce, IssuedAt: now, ExpiresAt: now.Add(time.Minute), Generation: 1, PolicyGeneration: 1, Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}
		_ = json.NewEncoder(w).Encode(signed(t, m, signing))
	}))
	caPath := filepath.Join(dir, "ca.pem")
	managed := filepath.Join(dir, "managed.json")
	for path, value := range map[string][]byte{caPath: []byte(ca.pem), managed: oldConfig} {
		if err = AtomicWrite(path, value); err != nil {
			t.Fatal(err)
		}
	}
	s := Settings{Server: server.URL, CAFile: caPath, ManagedConfig: managed, MetricsURL: exporter.URL + "/metrics"}
	if err = WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		t.Fatal(err)
	}
	if err = SaveState(dir, State{DeviceID: cred.DeviceID, ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	engine, err := OpenEngine(dir)
	if err != nil || engine.Metrics == nil {
		t.Fatal("configured collector not loaded", err)
	}
	engine.Driver = &fakeDriver{}
	defer engine.Client.Close()
	defer engine.Metrics.client.CloseIdleConnections()
	if err = engine.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if (<-heartbeats).Telemetry == nil || scrapes.Load() != 1 {
		t.Fatal("positive telemetry control failed")
	}
	engine.State.Policy.TelemetryEnabled = false
	if err = engine.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if (<-heartbeats).Telemetry != nil || scrapes.Load() != 1 {
		t.Fatal("remote telemetry pause did not suppress collection")
	}
	stored, _ := LoadSettings(dir)
	if stored.MetricsURL != s.MetricsURL {
		t.Fatal("remote policy deleted local endpoint")
	}
	stateBefore, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	if err = ClearMetrics(dir); err != nil {
		t.Fatal(err)
	}
	stateAfter, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	if !bytes.Equal(stateBefore, stateAfter) {
		t.Fatal("clear changed stored policy or history")
	}
	reloaded, err := OpenEngine(dir)
	if err != nil || reloaded.Metrics != nil || !reloaded.State.Policy.TelemetryEnabled {
		t.Fatal("clear reload failed or changed telemetry policy", err)
	}
	defer reloaded.Client.Close()
	driver := &fakeDriver{}
	reloaded.Driver = driver
	if err = reloaded.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if (<-heartbeats).Telemetry != nil || scrapes.Load() != 1 || driver.starts != 0 {
		t.Fatal("cleared collector scraped, reported telemetry or started Vector")
	}
	config, _ := os.ReadFile(managed)
	if !bytes.Equal(config, oldConfig) {
		t.Fatal("metrics clear altered pipeline content")
	}
}
