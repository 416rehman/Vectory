package agent

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestTelemetryIsBoundedAndDistinguishesMissingFromZero(t *testing.T) {
	for _, endpoint := range []string{"https://127.0.0.1:1/metrics", "http://localhost:1/metrics", "http://10.0.0.1:1/metrics", "http://127.0.0.1/metrics", "http://user:pass@127.0.0.1:1/metrics", "http://127.0.0.1:1/events"} {
		if _, err := NewMetricsCollector(endpoint); err == nil {
			t.Fatal("unsafe metric endpoint accepted")
		}
	}
	count := 100.0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "component_sent_events_total{component_id=\"input\",component_kind=\"source\"} %f\ncomponent_sent_events_total{component_kind=\"sink\"} 999\ncomponent_errors_total{component_id=\"input\"} 0\n", count)
	}))
	defer srv.Close()
	collector, err := NewMetricsCollector(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer collector.client.CloseIdleConnections()
	now := time.Now()
	sample := collector.Collect(context.Background(), now)
	if sample == nil || sample.EventsPerSecond != nil || sample.Errors == nil || *sample.Errors != 0 {
		t.Fatal("first counter sample invented a rate or omitted real zero")
	}
	count = 130
	sample = collector.Collect(context.Background(), now.Add(10*time.Second))
	if sample == nil || sample.EventsPerSecond == nil || *sample.EventsPerSecond != 3 {
		t.Fatal("counter rate incorrect")
	}
	count = 5
	sample = collector.Collect(context.Background(), now.Add(20*time.Second))
	if sample == nil || sample.EventsPerSecond != nil {
		t.Fatal("counter reset produced false rate")
	}
	_, _, _, _, err = parseMetrics([]byte(strings.Repeat("other_metric 1\n", 5001)))
	if err == nil {
		t.Fatal("unbounded series accepted")
	}
}
func TestNativeVectorTelemetry(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for actual native exporter integration")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	dir := t.TempDir()
	settings := Settings{VectorBinary: binary, ManagedConfig: filepath.Join(dir, "monitored.json"), Adopted: true, ValidationSeconds: 30, StartupSeconds: 20, CapabilityPolicy: CapabilityPolicy{AllowedFileRoots: []string{dir}, AllowedListenAddresses: []string{address}}}
	settings.VectorBinarySHA256, err = FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"data_dir": dir, "sources": map[string]any{"synthetic": map[string]any{"type": "demo_logs", "format": "json", "interval": 0.05}, "metrics": map[string]any{"type": "internal_metrics", "scrape_interval_secs": 1}}, "sinks": map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"synthetic"}}, "exporter": map[string]any{"type": "prometheus_exporter", "inputs": []string{"metrics"}, "address": address}}}
	config["transforms"] = map[string]any{"filtered": map[string]any{"type": "filter", "inputs": []string{"synthetic"}, "condition": "false"}, "badparse": map[string]any{"type": "remap", "inputs": []string{"synthetic"}, "source": ".number = parse_int!(.message)", "drop_on_error": true}}
	config["sinks"].(map[string]any)["discard"].(map[string]any)["inputs"] = []string{"synthetic", "filtered", "badparse"}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = settings.CapabilityPolicy.Check(data); err != nil {
		t.Fatal(err)
	}
	if err = AtomicWrite(settings.ManagedConfig, data); err != nil {
		t.Fatal(err)
	}
	driver := &VectorDriver{Settings: settings}
	defer driver.Stop()
	if err = driver.Validate(context.Background(), settings.ManagedConfig); err != nil {
		t.Fatal(err)
	}
	if err = driver.Activate(context.Background(), settings.ManagedConfig); err != nil {
		t.Fatal(err)
	}
	collector, err := NewMetricsCollector("http://" + address + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer collector.client.CloseIdleConnections()
	first := collector.Collect(context.Background(), time.Now())
	if os.Getenv("VECTOR_CAPTURE_METRICS") != "" {
		response, e := collector.client.Get("http://" + address + "/metrics")
		if e != nil {
			t.Fatal(e)
		}
		body, e := io.ReadAll(io.LimitReader(response.Body, MaxArtifact+1))
		response.Body.Close()
		if e != nil {
			t.Fatal(e)
		}
		if e = AtomicWrite(os.Getenv("VECTOR_CAPTURE_METRICS"), body); e != nil {
			t.Fatal(e)
		}
	}
	time.Sleep(1200 * time.Millisecond)
	second := collector.Collect(context.Background(), time.Now())
	if first == nil || second == nil || second.EventsPerSecond == nil || *second.EventsPerSecond <= 0 {
		t.Fatalf("no real bounded metric rate: first=%+v second=%+v", first, second)
	}
	if second.UptimeSeconds == nil || *second.UptimeSeconds <= 0 || second.BufferBytes == nil || second.Errors == nil || *second.Errors <= 0 || second.DiscardedEvents == nil || *second.DiscardedEvents <= 0 {
		t.Fatalf("real uptime/buffer/error/discard metrics missing: %+v", second)
	}
	foundSource, foundFilter, foundError := false, false, false
	for _, component := range second.Components {
		switch component.ID {
		case "synthetic":
			foundSource = component.EventsPerSecond != nil && *component.EventsPerSecond > 0
		case "filtered":
			foundFilter = component.DiscardedEvents != nil && *component.DiscardedEvents > 0
		case "badparse":
			foundError = component.Errors != nil && *component.Errors > 0
		}
	}
	if !foundSource || !foundFilter || !foundError {
		t.Fatalf("real component telemetry missing: %+v", second.Components)
	}
}

func TestExtendedTelemetryAllowlistBoundsAndLabels(t *testing.T) {
	data := []byte("vector_uptime_seconds{host=\"not-exported\"} 50\nvector_buffer_size_bytes{component_id=\"out\",component_type=\"http\"} 0\nvector_component_discarded_events_total{component_id=\"filter\",component_type=\"filter\",intentional=\"true\"} 3\nvector_component_errors_total{component_id=\"out\",component_type=\"http\",error_type=\"private-diagnostic\"} 2\nvector_memory_bytes 42\nvector_component_sent_events_total{component_id=\"in\",component_kind=\"source\",component_type=\"demo_logs\"} 10\n")
	o, err := parseMetricObservation(data)
	if err != nil {
		t.Fatal(err)
	}
	if o.UptimeSeconds == nil || *o.UptimeSeconds != 50 || o.BufferBytes == nil || *o.BufferBytes != 0 || o.DiscardedEvents == nil || *o.DiscardedEvents != 3 || o.Errors == nil || *o.Errors != 2 || o.MemoryBytes != nil || len(o.Components) != 3 {
		t.Fatal("metric mapping changed observed/missing distinction")
	}
	encoded, _ := json.Marshal(o.Telemetry)
	if strings.Contains(string(encoded), "private-diagnostic") || strings.Contains(string(encoded), "not-exported") {
		t.Fatal("unapproved labels escaped")
	}
	var tooMany strings.Builder
	for i := 0; i < 51; i++ {
		fmt.Fprintf(&tooMany, "component_sent_events_total{component_id=\"id%d\"} 1\n", i)
	}
	if _, err = parseMetricObservation([]byte(tooMany.String())); err == nil {
		t.Fatal("unbounded components accepted")
	}
	for _, bad := range []string{`component_id="one",component_id="two"`, `component_id="bad\nvalue"`, `component_id="bad space"`, `component_kind="secret-payload"`} {
		if _, _, _, ok := componentLabels(bad); ok {
			t.Fatal("invalid label identity accepted")
		}
	}
	if _, err = parseMetricObservation([]byte("component_errors_total 1e308\ncomponent_errors_total 1e308\n")); err == nil {
		t.Fatal("numeric overflow accepted")
	}
}
func TestTelemetryComponentRatesResetWithProcessUptime(t *testing.T) {
	counter, uptime := 100, 100
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "uptime_seconds %d\ncomponent_sent_events_total{component_id=\"in\",component_kind=\"source\"} %d\n", uptime, counter)
	}))
	defer srv.Close()
	c, err := NewMetricsCollector(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer c.client.CloseIdleConnections()
	now := time.Now()
	first := c.Collect(context.Background(), now)
	if first == nil || len(first.Components) != 1 || first.Components[0].EventsPerSecond != nil {
		t.Fatal("first component rate fabricated")
	}
	counter, uptime = 120, 110
	second := c.Collect(context.Background(), now.Add(10*time.Second))
	if second == nil || second.Components[0].EventsPerSecond == nil || *second.Components[0].EventsPerSecond != 2 {
		t.Fatal("component rate missing")
	}
	counter, uptime = 150, 5
	reset := c.Collect(context.Background(), now.Add(20*time.Second))
	if reset == nil || reset.EventsPerSecond != nil || reset.Components[0].EventsPerSecond != nil {
		t.Fatal("restarted process produced false rate")
	}
}
