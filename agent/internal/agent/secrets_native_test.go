package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A device secret in a credential that is not an http sink's auth: the basic
// authentication of a prometheus_remote_write sink, whose password Vector
// types as a plain string (a reviewed table entry). The agent materializes the
// pipeline, the pinned Vector validates and runs it, and the receiver gets
// the credential. The value appears only in the private managed file: never
// in state, status, the heartbeat, diagnostics or Vector log summaries.
func TestNativeVectorResolvesDeviceSecretsInNonHTTPCredentials(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native device-secret materialization")
	}
	const user, password = "svc-writer-5b", "native-remote-write-secret-7f3a9c"
	observed := make(chan string, 1024)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case observed <- r.Header.Get("Authorization"):
		default:
		}
		// A receiver that echoes what it rejected makes Vector log errors.
		http.Error(w, "rejected "+r.Header.Get("Authorization"), http.StatusBadRequest)
	}))
	defer receiver.Close()
	dataDir := t.TempDir()
	raw, _ := json.Marshal(map[string]any{
		"data_dir": dataDir,
		"sources":  map[string]any{"metrics": map[string]any{"type": "internal_metrics", "scrape_interval_secs": 1}},
		"sinks": map[string]any{"remote": map[string]any{
			"type": "prometheus_remote_write", "inputs": []string{"metrics"}, "endpoint": receiver.URL + "/api/v1/write",
			"auth":        map[string]any{"strategy": "basic", "user": "vectory-secret:RW_USER", "password": "vectory-secret:RW_PASSWORD"},
			"batch":       map[string]any{"timeout_secs": 0.5},
			"healthcheck": map[string]any{"enabled": false},
		}},
	})
	e, m, _ := fixture(t, raw)
	secrets := privateTempDir(t)
	bindings := map[string]string{}
	for name, value := range map[string]string{"RW_USER": user, "RW_PASSWORD": password} {
		p := filepath.Join(secrets, name)
		if err := AtomicWrite(p, []byte(value+"\n")); err != nil {
			t.Fatal(err)
		}
		bindings[name] = p
	}
	e.Settings.SecretFiles = bindings
	e.Settings.VectorBinary = binary
	e.Settings.VectorBinarySHA256, _ = FileDigest(binary)
	e.Settings.ValidationSeconds = 30
	e.Settings.StartupSeconds = 20
	// prometheus_remote_write and internal_metrics are full-mode components.
	e.Settings.CapabilityPolicy.FullVectorConfig = true
	e.State.ServerFeatures = []string{featureDiagnostics, featureHostRuntime, featureLogSummary, featureTelemetryV2, featureSecretNames}
	log := newVectorLog(e.Dir)
	e.Log = log
	driver := &VectorDriver{Settings: e.Settings, Dir: e.Dir, Log: log}
	e.Driver = driver
	// Windows cannot remove a directory holding a file that is still open, so
	// stop Vector and close its log before the temporary directory goes.
	t.Cleanup(func() { _ = driver.Stop(); log.close() })
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if e.State.ApplyState != "verified_applied" || !driver.Alive() || e.State.SecretRevision != 1 {
		t.Fatalf("native device-secret activation unverified: %+v", e.State.ApplyState)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
	deadline := time.After(10 * time.Second)
	for got := ""; got != want; {
		select {
		case got = <-observed:
		case <-deadline:
			t.Fatal("real Vector did not send the locally resolved credentials")
		}
	}
	// The managed configuration Vector runs passes `vector validate` as is.
	managed, err := readArtifact(e.Settings.ManagedConfig)
	if err != nil || !bytes.Contains(managed, []byte(password)) {
		t.Fatal("managed configuration does not hold the resolved credential", err)
	}
	if out, err := exec.Command(binary, "validate", "--no-environment", "--config-json", e.Settings.ManagedConfig).CombinedOutput(); err != nil {
		t.Fatalf("vector validate rejected the materialized configuration: %s", out)
	}
	// Wait for Vector to report the rejected deliveries, then collect every
	// output that leaves the host or the agent's state.
	var summaries []LogSummary
	for wait := time.Now().Add(10 * time.Second); len(summaries) == 0; time.Sleep(100 * time.Millisecond) {
		if time.Now().After(wait) {
			t.Fatal("Vector logged no delivery errors to summarize")
		}
		summaries = log.summaries(e.redactorFor(managed))
	}
	var heartbeat []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		heartbeat, _ = io.ReadAll(r.Body)
		http.Error(w, "fixture no manifest", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	e.Client = &Client{HTTP: server.Client(), Base: server.URL}
	_ = e.Poll(context.Background())
	if !bytes.Contains(heartbeat, []byte(`"secret_names":["RW_PASSWORD","RW_USER"]`)) {
		t.Fatalf("heartbeat did not report the bound names: %s", heartbeat)
	}
	if err = WriteJSON(filepath.Join(e.Dir, "settings.json"), e.Settings); err != nil {
		t.Fatal(err)
	}
	status, err := StateSummary(e.Dir)
	if err != nil {
		t.Fatal(err)
	}
	statusJSON, _ := json.Marshal(status)
	summaryJSON, _ := json.Marshal(summaries)
	for label, output := range map[string][]byte{"heartbeat": heartbeat, "status": statusJSON, "log summaries": summaryJSON} {
		if bytes.Contains(output, []byte(password)) || bytes.Contains(output, []byte(want)) {
			t.Fatalf("%s contains the credential", label)
		}
	}
	for _, file := range []string{"state.json", "template-" + m.Desired.SHA256 + ".json"} {
		b, err := os.ReadFile(filepath.Join(e.Dir, file))
		if err != nil || bytes.Contains(b, []byte(password)) {
			t.Fatalf("%s holds the credential (%v)", file, err)
		}
	}
	redactor := e.redactorFor(managed)
	if got := redactor.text("remote write rejected " + user + ":" + password); strings.Contains(got, password) || strings.Contains(got, user) {
		t.Fatalf("redaction kept the credential: %q", got)
	}
}
