package agent

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// freeLoopbackAddress is a loopback TCP address nothing listens on.
func freeLoopbackAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	return address
}

// The synthetic example with Vectory's monitoring pair, as the dashboard's
// template and Add monitoring produce it, runs on a restricted device with
// no host allowance: the local policy accepts it, the pinned Vector
// validates and starts it, and the agent reads delivery numbers from it.
func TestNativeMonitoringExporterRunsInRestrictedModeWithoutAnAllowance(t *testing.T) {
	e, driver := nativeRuntimeFixture(t)
	restricted := CapabilityPolicy{}
	e.Settings.CapabilityPolicy, driver.Settings.CapabilityPolicy = restricted, restricted
	address := freeLoopbackAddress(t)
	config := writeManaged(t, e.Settings.ManagedConfig, map[string]any{
		"sources": map[string]any{
			"demo":                     map[string]any{"type": "demo_logs", "format": "json", "interval": 0.2},
			"vectory_internal_metrics": map[string]any{"type": "internal_metrics", "scrape_interval_secs": 1},
		},
		"transforms": map[string]any{"enrich": map[string]any{"type": "remap", "inputs": []string{"demo"}, "source": `.environment = "development"`}},
		"sinks": map[string]any{
			"output":                   map[string]any{"type": "console", "inputs": []string{"enrich"}, "target": "stderr", "encoding": map[string]any{"codec": "json"}},
			"vectory_metrics_exporter": map[string]any{"type": "prometheus_exporter", "inputs": []string{"vectory_internal_metrics"}, "address": address},
		},
	})
	if err := restricted.Check(config); err != nil {
		t.Fatalf("restricted mode refused the monitoring pair: %v", err)
	}
	ctx := context.Background()
	if err := driver.Validate(ctx, e.Settings.ManagedConfig); err != nil {
		t.Fatalf("vector validate: %v %+v", err, e.diagnoseFailure(err, config))
	}
	if err := driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		t.Fatalf("activation: %v %+v", err, e.diagnoseFailure(err, config))
	}
	e.State.Policy.TelemetryEnabled = true
	deadline := time.Now().Add(20 * time.Second)
	for {
		_, source, found := e.collectTelemetry(ctx, config)
		if source != metricsDiscovered || found != address {
			t.Fatalf("restricted discovery: %s %s", source, found)
		}
		response, err := http.Get("http://" + address + "/metrics")
		if err == nil {
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if strings.Contains(string(body), "vector_component_sent_events_total") {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the exporter never served Vector's metrics: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// A device's first version that Vector can't start (here: its listener's
// port is taken) leaves nothing running and nothing claiming to: Vector is
// stopped, the version is withdrawn from the managed path and the next step
// is to fix and redeploy, not a recovery procedure.
func TestNativeFirstVersionThatCannotStartIsWithdrawn(t *testing.T) {
	e, driver := nativeRuntimeFixture(t)
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	data := []byte(`{"data_dir":"` + filepath.ToSlash(t.TempDir()) + `","sources":{"in":{"type":"http_server","address":"` + taken.Addr().String() + `","decoding":{"codec":"json"}}},"sinks":{"out":{"type":"blackhole","inputs":["in"],"print_interval_secs":0}}}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(data) }))
	defer server.Close()
	m := sampleManifest()
	m.Desired = &Desired{VersionID: "v1", SHA256: Digest(data), Size: int64(len(data)), ArtifactPath: "/agent/v1/artifacts/" + Digest(data), VectorVersion: VectorVersion}
	e.State = State{Accepted: true, HighestGeneration: m.Generation, HighestPolicyGeneration: m.PolicyGeneration, DesiredIdentity: Identity(m.Desired), PolicyIdentity: Identity(m.Policy), Desired: m.Desired, Policy: m.Policy, ApplyState: "unmanaged"}
	e.Client = &Client{HTTP: server.Client(), Base: server.URL}
	if err := e.save(); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("a version whose listener can't bind was reported applied")
	}
	requireAttempt(t, e, m, "failed", "ROLLBACK_UNAVAILABLE")
	if driver.Alive() || e.actual() != "" || e.State.ActualSHA256 != "" {
		t.Fatalf("alive %v, managed digest %q, reported %q", driver.Alive(), e.actual(), e.State.ActualSHA256)
	}
	if _, err := os.Stat(e.Settings.ManagedConfig); !os.IsNotExist(err) {
		t.Fatal("the failed first version stayed in the managed path")
	}
	if applyNextAction(e.State) != firstVersionFailed {
		t.Fatalf("next: %q", applyNextAction(e.State))
	}
	found := false
	for _, d := range e.State.Error.Diagnostics {
		found = found || d.Code == "ADDRESS_IN_USE"
	}
	if !found {
		t.Fatalf("the reason is lost: %+v", e.State.Error.Diagnostics)
	}
}
