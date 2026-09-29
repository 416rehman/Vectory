package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func componentByID(t *testing.T, sample *Telemetry, id string) ComponentTelemetry {
	t.Helper()
	for _, c := range sample.Components {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("component %s missing from %+v", id, sample.Components)
	return ComponentTelemetry{}
}

func near(v *float64, want float64) bool {
	return v != nil && math.Abs(*v-want) < 1e-6
}

func TestRealVectorScrapeParsesRichComponentMetrics(t *testing.T) {
	o, err := parseMetricObservation(vectorFixture(t, "metrics.prom"))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(o.Telemetry)
	if strings.Contains(string(encoded), "Connection refused") || strings.Contains(string(encoded), "probe") {
		t.Fatalf("raw labels escaped: %s", encoded)
	}
	sink := componentByID(t, &o.Telemetry, "broken_http")
	if sink.Kind != "sink" || sink.Type != "http" || !near(sink.Errors, 7) || !near(sink.BufferEvents, 169) || !near(sink.BufferMaxEvents, 500) || !near(sink.BufferUtilization, 169.0/500) {
		t.Fatalf("failing sink = %+v", sink)
	}
	filter := componentByID(t, &o.Telemetry, "only_errors")
	if !near(filter.DiscardedIntentional, 472) || !near(filter.DiscardedError, 0) || !near(filter.Errors, 0) || filter.LatencyMeanSeconds == nil {
		t.Fatalf("filter drops must be split and zero means zero: %+v", filter)
	}
	parse := componentByID(t, &o.Telemetry, "parse")
	if !near(parse.Utilization, 0.0024) {
		t.Fatalf("utilization = %+v", parse.Utilization)
	}
	if !near(o.DiscardedIntentional, 472+594) || !near(o.DiscardedError, 0) || !near(o.Errors, 7) || !near(o.BufferUtilization, 169.0/500) || o.UptimeSeconds == nil {
		t.Fatalf("device totals = %+v", o.Telemetry)
	}
	if _, ok := o.Counters["c:parse:out:_default"]; !ok {
		t.Fatal("per-output counter missing")
	}
	if o.Counters["d:in"] != 661 {
		t.Fatalf("events in must exclude internal_metrics: %v", o.Counters["d:in"])
	}
}

func TestCollectorComputesRatesPerOutputAndSplitsDrops(t *testing.T) {
	var round atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := float64(round.Load())
		fmt.Fprintf(w, "vector_uptime_seconds %f\n", 100+10*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"app\",component_kind=\"source\",component_type=\"demo_logs\",output=\"_default\"} %f\n", 1000+100*n)
		fmt.Fprintf(w, "vector_component_received_bytes_total{component_id=\"app\",component_kind=\"source\",component_type=\"demo_logs\"} %f\n", 5000+2000*n)
		fmt.Fprintf(w, "vector_component_received_events_total{component_id=\"route\",component_kind=\"transform\",component_type=\"route\"} %f\n", 1000+100*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"route\",component_kind=\"transform\",component_type=\"route\",output=\"errors\"} %f\n", 50+10*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"route\",component_kind=\"transform\",component_type=\"route\",output=\"_unmatched\"} %f\n", 950+90*n)
		fmt.Fprintf(w, "vector_component_discarded_events_total{component_id=\"sample\",component_kind=\"transform\",component_type=\"sample\",intentional=\"true\"} %f\n", 900+80*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"sample\",component_kind=\"transform\",component_type=\"sample\",output=\"_default\"} %f\n", 100+10*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"out\",component_kind=\"sink\",component_type=\"http\"} %f\n", 100+10*n)
		fmt.Fprintf(w, "vector_component_sent_bytes_total{component_id=\"out\",component_kind=\"sink\",component_type=\"http\"} %f\n", 800+400*n)
		if n > 0 {
			// Error and discard counters appear on first occurrence.
			fmt.Fprintf(w, "vector_http_client_errors_total{component_id=\"out\",component_kind=\"sink\",component_type=\"http\",error_kind=\"secret-ish raw text\"} %f\n", 3*n)
			fmt.Fprintf(w, "vector_component_discarded_events_total{component_id=\"out\",component_kind=\"sink\",component_type=\"http\",intentional=\"false\"} %f\n", 2*n)
		}
	}))
	defer srv.Close()
	c, err := NewMetricsCollector(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	first := c.Collect(context.Background(), now)
	if first == nil || first.EventsPerSecond != nil || first.ErrorsPerMinute != nil || !near(first.Errors, 0) {
		t.Fatalf("first sample must have no rates and a real zero error count: %+v", first)
	}
	round.Store(1)
	second := c.Collect(context.Background(), now.Add(10*time.Second))
	if second == nil || !near(second.EventsPerSecond, 10) || !near(second.EventsOutPerSecond, 1) || !near(second.BytesInPerSecond, 200) || !near(second.BytesOutPerSecond, 40) {
		t.Fatalf("device rates = %+v", second)
	}
	if !near(second.ErrorsPerMinute, 18) || !near(second.DroppedPerMinute, 12) || !near(second.FilteredPerMinute, 480) {
		t.Fatalf("per-minute rates: errors=%v dropped=%v filtered=%v", *second.ErrorsPerMinute, *second.DroppedPerMinute, *second.FilteredPerMinute)
	}
	route := componentByID(t, second, "route")
	if !near(route.ReceivedEventsPerSecond, 10) || route.SentByOutput["errors"] != 1 || route.SentByOutput["_unmatched"] != 9 || !near(route.EventsPerSecond, 10) {
		t.Fatalf("route = %+v", route)
	}
	out := componentByID(t, second, "out")
	if !near(out.ErrorsPerMinute, 18) || !near(out.DroppedPerMinute, 12) || !near(out.SentBytesPerSecond, 40) || !near(out.DiscardedError, 2) {
		t.Fatalf("sink = %+v", out)
	}
	encoded, _ := json.Marshal(second)
	if strings.Contains(string(encoded), "secret-ish") {
		t.Fatal("error_kind label escaped")
	}
	// Switching endpoints restarts rate computation.
	if err = c.setEndpoint("http://127.0.0.1:1/metrics", "vector"); err != nil || c.counters != nil {
		t.Fatal("endpoint change kept previous counters")
	}
}

func TestExporterDiscoveryIsLoopbackAndInternalMetricsOnly(t *testing.T) {
	restricted := CapabilityPolicy{AllowedListenAddresses: []string{"127.0.0.1:9598"}}
	full := CapabilityPolicy{FullVectorConfig: true}
	cases := []struct {
		name, config, address, namespace string
		policy                           CapabilityPolicy
	}{
		{"direct", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"127.0.0.1:9598"}}}`, "127.0.0.1:9598", "vector", restricted},
		{"through transforms and namespace", `{"sources":{"m":{"type":"internal_metrics","namespace":"edge"}},"transforms":{"f":{"type":"filter","inputs":["m"]},"r":{"type":"route","inputs":["f"]}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["r.keep"],"address":"[::1]:9600"}}}`, "[::1]:9600", "edge", full},
		{"wildcard address", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"0.0.0.0:9598"}}}`, "", "", full},
		{"default address", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"]}}}`, "", "", full},
		{"not vector metrics", `{"sources":{"logs":{"type":"demo_logs"}},"transforms":{"l2m":{"type":"log_to_metric","inputs":["logs"]}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["l2m"],"address":"127.0.0.1:9598"}}}`, "", "", full},
		{"authenticated", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"127.0.0.1:9598","auth":{"strategy":"basic"}}}}`, "", "", full},
		{"restricted listener not allowed", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"127.0.0.1:9700"}}}`, "", "", restricted},
		{"hostname", `{"sources":{"m":{"type":"internal_metrics"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"localhost:9598"}}}`, "", "", full},
	}
	for _, c := range cases {
		address, namespace := discoverExporter([]byte(c.config), c.policy)
		if address != c.address || namespace != c.namespace {
			t.Errorf("%s: got %q/%q, want %q/%q", c.name, address, namespace, c.address, c.namespace)
		}
	}
}

func TestEngineDiscoversThePipelineExporterWithoutHostSetup(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `edge_component_sent_events_total{component_id="app",component_kind="source",component_type="demo_logs"} 10`)
	}))
	srv.Listener = listener
	srv.Start()
	defer srv.Close()
	address := listener.Addr().String()
	dir := t.TempDir()
	config := []byte(`{"sources":{"app":{"type":"demo_logs"},"m":{"type":"internal_metrics","namespace":"edge"}},"sinks":{"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"` + address + `"}}}`)
	e := &Engine{Dir: dir, Settings: Settings{ManagedConfig: filepath.Join(dir, "managed.json"), CapabilityPolicy: CapabilityPolicy{FullVectorConfig: true}}, State: State{Policy: Policy{TelemetryEnabled: true}}}
	sample, source, got := e.collectTelemetry(context.Background(), config)
	if sample == nil || len(sample.Components) != 1 || source != metricsDiscovered || got != address {
		t.Fatalf("discovery failed: %+v %s %s", sample, source, got)
	}
	// The exporter it scrapes carries only Vector's own metrics.
	if !e.Metrics.internal["prom"] || len(e.Metrics.internal) != 1 {
		t.Fatalf("telemetry sinks = %v", e.Metrics.internal)
	}
	e.State.Policy.TelemetryEnabled = false
	if sample, source, _ = e.collectTelemetry(context.Background(), config); sample != nil || source != metricsDiscovered {
		t.Fatal("telemetry policy must stop collection but still report the endpoint")
	}
	if _, source, _ = e.collectTelemetry(context.Background(), []byte(`{"sources":{}}`)); source != metricsNone {
		t.Fatalf("no exporter reported as %q", source)
	}
}

func TestHeartbeatFeaturesAreSentOnlyToServersThatAcceptThem(t *testing.T) {
	previous := vectorDefaultDataDirProbe
	defer func() { vectorDefaultDataDirProbe = previous }()
	vectorDefaultDataDirProbe = filepath.Join(t.TempDir(), "absent")
	dir := t.TempDir()
	rate := 3.0
	diagnostic := []Diagnostic{{Severity: "error", Code: "VRL_E103", Message: "Unhandled fallible assignment"}}
	build := func(features []string) Heartbeat {
		e := &Engine{Dir: dir, State: State{ServerFeatures: features}, Log: newVectorLog("")}
		h := Heartbeat{Error: &Issue{Code: "VALIDATION_FAILED", Diagnostics: diagnostic}, ConfigurationAttempt: &ConfigurationAttempt{State: "failed", Error: &Issue{Code: "VALIDATION_FAILED", Diagnostics: diagnostic}},
			Telemetry: &Telemetry{EventsPerSecond: &rate, EventsOutPerSecond: &rate, Components: []ComponentTelemetry{{ID: "a", Kind: "source", EventsPerSecond: &rate, SentByOutput: map[string]float64{"_default": 3}}}}}
		e.addHeartbeatFeatures(&h, []byte(`{"sources":{}}`), metricsNone, "")
		return h
	}
	legacy := build(nil)
	if legacy.Error.Diagnostics != nil || legacy.ConfigurationAttempt.Error.Diagnostics != nil || legacy.HostRuntime != nil || legacy.Telemetry.EventsOutPerSecond != nil || legacy.Telemetry.Components[0].SentByOutput != nil || legacy.Telemetry.Components[0].Kind != "" {
		t.Fatalf("legacy server received additive fields: %+v", legacy)
	}
	if legacy.Telemetry.EventsPerSecond == nil || len(diagnostic) != 1 {
		t.Fatal("legacy fields dropped or state mutated")
	}
	rich := build([]string{featureDiagnostics, featureHostRuntime, featureLogSummary, featureTelemetryV2})
	if len(rich.Error.Diagnostics) != 1 || rich.HostRuntime == nil || rich.HostRuntime.DataDirSource != dataDirAgentDefault || rich.HostRuntime.MetricsSource != metricsNone || rich.Telemetry.EventsOutPerSecond == nil {
		t.Fatalf("rich heartbeat = %+v", rich)
	}
	// A supporting server learns "nothing to report"; an older one never
	// sees the field at all.
	for _, c := range []struct {
		h    Heartbeat
		want string
	}{{rich, `"vector_log_summary":[]`}, {legacy, ""}} {
		encoded, _ := json.Marshal(c.h)
		if got := strings.Contains(string(encoded), `"vector_log_summary"`); got != (c.want != "") || c.want != "" && !strings.Contains(string(encoded), c.want) {
			t.Fatalf("vector_log_summary encoding: %s", encoded)
		}
	}
}

func TestComponentsRemovedByReloadAreNotReported(t *testing.T) {
	components := []ComponentTelemetry{{ID: "app"}, {ID: "old_source"}, {ID: "out"}}
	running := []byte(`{"sources":{"app":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["app"]}}}`)
	got := runningComponents(components, running)
	if len(got) != 2 || got[0].ID != "app" || got[1].ID != "out" || len(components) != 3 || components[1].ID != "old_source" {
		t.Fatalf("running components = %+v (input %+v)", got, components)
	}
	// Without a readable running configuration nothing is dropped.
	if got := runningComponents(components, []byte("not json")); len(got) != 3 {
		t.Fatalf("unreadable configuration dropped components: %+v", got)
	}
}

func TestEventsOutLeavesOutSinksCarryingOnlyVectorsOwnTelemetry(t *testing.T) {
	config := []byte(`{
		"sources": {"app": {"type": "demo_logs"}, "m": {"type": "internal_metrics"}, "l": {"type": "internal_logs"}},
		"transforms": {
			"tag": {"type": "remap", "inputs": ["l"]},
			"route": {"type": "route", "inputs": ["m"]},
			"loop": {"type": "remap", "inputs": ["loop"]}
		},
		"sinks": {
			"archive": {"type": "blackhole", "inputs": ["app"]},
			"prom": {"type": "prometheus_exporter", "inputs": ["route.keep"]},
			"log_copy": {"type": "file", "inputs": ["tag"]},
			"mixed": {"type": "console", "inputs": ["app", "m"]},
			"wildcard": {"type": "console", "inputs": ["m*"]},
			"cycle": {"type": "console", "inputs": ["loop"]},
			"none": {"type": "console"}
		}
	}`)
	got := telemetrySinks(config)
	if len(got) != 2 || !got["prom"] || !got["log_copy"] {
		t.Fatalf("telemetry sinks = %v", got)
	}
	if telemetrySinks([]byte("not json")) != nil {
		t.Fatal("an unreadable configuration must exclude nothing")
	}
	// The real scrape: the blackhole delivered 256 events and the exporter
	// 135 metric events. Only the blackhole is the pipeline's output.
	data := vectorFixture(t, "metrics.prom")
	all, err := parseMetricObservation(data)
	if err != nil {
		t.Fatal(err)
	}
	own, err := parseMetricObservationWithNamespace(data, "vector", map[string]bool{"prom": true})
	if err != nil {
		t.Fatal(err)
	}
	if all.Counters["d:out"] != 391 || own.Counters["d:out"] != 256 || own.Counters["d:in"] != all.Counters["d:in"] {
		t.Fatalf("events out: all=%v own=%v", all.Counters["d:out"], own.Counters["d:out"])
	}
	if own.Counters["c:prom:sent"] != 135 {
		t.Fatal("the exporter keeps its own component counters")
	}
}

func TestChangingTelemetrySinksRestartsOnlyTheOutRate(t *testing.T) {
	var round atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := float64(round.Load())
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"app\",component_kind=\"source\",component_type=\"demo_logs\"} %f\n", 100+10*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"archive\",component_kind=\"sink\",component_type=\"blackhole\"} %f\n", 100+10*n)
		fmt.Fprintf(w, "vector_component_sent_events_total{component_id=\"prom\",component_kind=\"sink\",component_type=\"prometheus_exporter\"} %f\n", 500+50*n)
	}))
	defer srv.Close()
	c, err := NewMetricsCollector(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	c.Collect(context.Background(), now)
	round.Store(1)
	mixed := c.Collect(context.Background(), now.Add(10*time.Second))
	if !near(mixed.EventsOutPerSecond, 6) {
		t.Fatalf("without a configuration every sink counts: %v", mixed.EventsOutPerSecond)
	}
	c.setInternalSinks(map[string]bool{"prom": true})
	round.Store(2)
	changed := c.Collect(context.Background(), now.Add(20*time.Second))
	if changed.EventsOutPerSecond != nil || !near(changed.EventsPerSecond, 1) {
		t.Fatalf("a new sink set must not mix totals: out=%v in=%v", changed.EventsOutPerSecond, changed.EventsPerSecond)
	}
	round.Store(3)
	own := c.Collect(context.Background(), now.Add(30*time.Second))
	if !near(own.EventsOutPerSecond, 1) || !near(componentByID(t, own, "prom").EventsPerSecond, 5) {
		t.Fatalf("events out = %v", own.EventsOutPerSecond)
	}
	// The same set again changes nothing.
	c.setInternalSinks(map[string]bool{"prom": true})
	round.Store(4)
	if again := c.Collect(context.Background(), now.Add(40*time.Second)); !near(again.EventsOutPerSecond, 1) {
		t.Fatalf("an unchanged set restarted the rate: %v", again.EventsOutPerSecond)
	}
}
