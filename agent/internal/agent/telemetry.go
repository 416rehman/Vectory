package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Metrics come from Vector's own Prometheus exporter on a loopback address:
// either the host operator's explicit --metrics-url, or a prometheus_exporter
// sink that the published pipeline itself declares (visible and versioned).
// The agent never inserts monitoring components.
type MetricsCollector struct {
	url       string
	namespace string
	client    *http.Client
	counters  counterSet
	sampled   time.Time
	uptime    *float64
}

// Metrics endpoint sources reported in host_runtime.metrics_source.
const (
	metricsExplicit   = "explicit"
	metricsDiscovered = "discovered"
	metricsNone       = "none"
)

func metricsClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	transport.MaxConnsPerHost = 1
	return &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("telemetry redirects forbidden") }}
}

// checkMetricsURL accepts only http://<literal loopback IP>:<port>/metrics.
func checkMetricsURL(endpoint string) (*url.URL, error) {
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/metrics" {
		return nil, errors.New("metrics endpoint must be http://<loopback-IP>:<port>/metrics")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() || u.Port() == "" {
		return nil, errors.New("metrics endpoint must use a literal loopback IP and explicit port")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("metrics endpoint port must be 1..65535")
	}
	return u, nil
}

func NewMetricsCollector(endpoint string) (*MetricsCollector, error) {
	u, err := checkMetricsURL(endpoint)
	if err != nil {
		return nil, err
	}
	return &MetricsCollector{url: u.String(), namespace: "vector", client: metricsClient()}, nil
}

// setEndpoint points the collector at a new endpoint. Rates restart so a
// counter from one exporter is never subtracted from another's.
func (c *MetricsCollector) setEndpoint(endpoint, namespace string) error {
	if namespace == "" {
		namespace = "vector"
	}
	if endpoint == c.url && namespace == c.namespace {
		return nil
	}
	u, err := checkMetricsURL(endpoint)
	if err != nil {
		return err
	}
	c.url, c.namespace = u.String(), namespace
	c.counters, c.uptime, c.sampled = nil, nil, time.Time{}
	return nil
}

var metricLine = regexp.MustCompile(`^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+[0-9]+)?$`)

func parseMetrics(data []byte) (events, failures float64, hasEvents, hasFailures bool, err error) {
	observation, err := parseMetricObservation(data)
	if err != nil {
		return 0, 0, false, false, err
	}
	if observation.Events != nil {
		events = *observation.Events
		hasEvents = true
	}
	if observation.Errors != nil {
		failures = *observation.Errors
		hasFailures = true
	}
	return
}

// rate returns the per-second rate of a counter since the previous sample,
// or nil when there is no comparable previous value.
func rate(current, previous counterSet, key string, seconds float64, zeroMissingPrevious bool) *float64 {
	now, ok := current[key]
	if !ok || previous == nil || seconds <= 0 {
		return nil
	}
	before, had := previous[key]
	if !had {
		if !zeroMissingPrevious {
			return nil
		}
		before = 0
	}
	if now < before {
		return nil
	}
	v := (now - before) / seconds
	return &v
}

func perMinute(v *float64) *float64 {
	if v == nil {
		return nil
	}
	m := *v * 60
	return &m
}

func (c *MetricsCollector) Collect(ctx context.Context, now time.Time) *Telemetry {
	req, e := http.NewRequestWithContext(ctx, "GET", c.url, nil)
	if e != nil {
		return nil
	}
	res, e := c.client.Do(req)
	if e != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, MaxArtifact+1))
	if e != nil || len(data) > MaxArtifact {
		return nil
	}
	observed, e := parseMetricObservationWithNamespace(data, c.namespace)
	if e != nil || (observed.Events == nil && observed.Errors == nil && observed.UptimeSeconds == nil && observed.BufferBytes == nil && observed.DiscardedEvents == nil && len(observed.Components) == 0) {
		return nil
	}
	sample := &observed.Telemetry
	sample.SampledAt = now.UTC()
	// A restarted Vector resets its counters; never compute a rate across it.
	continuous := !c.sampled.IsZero() && now.After(c.sampled) && (c.uptime == nil || sample.UptimeSeconds == nil || *sample.UptimeSeconds >= *c.uptime)
	var previous counterSet
	seconds := 0.0
	if continuous {
		previous, seconds = c.counters, now.Sub(c.sampled).Seconds()
	}
	// Error and discard counters appear on first use, so a counter missing
	// from the previous sample of the same process started at zero.
	cumulative := counterSet{"d:errors": value(sample.Errors), "d:intentional": value(sample.DiscardedIntentional), "d:unintentional": value(sample.DiscardedError)}
	for key, v := range cumulative {
		if v >= 0 {
			observed.Counters[key] = v
		}
	}
	sample.EventsPerSecond = rate(observed.Counters, previous, "d:in", seconds, false)
	sample.EventsOutPerSecond = rate(observed.Counters, previous, "d:out", seconds, false)
	sample.BytesInPerSecond = rate(observed.Counters, previous, "d:in_bytes", seconds, false)
	sample.BytesOutPerSecond = rate(observed.Counters, previous, "d:out_bytes", seconds, false)
	sample.ErrorsPerMinute = perMinute(rate(observed.Counters, previous, "d:errors", seconds, true))
	sample.FilteredPerMinute = perMinute(rate(observed.Counters, previous, "d:intentional", seconds, true))
	sample.DroppedPerMinute = perMinute(rate(observed.Counters, previous, "d:unintentional", seconds, true))
	for i := range sample.Components {
		comp := &sample.Components[i]
		key := "c:" + comp.ID + ":"
		for field, v := range map[string]*float64{"errors": comp.Errors, "intentional": comp.DiscardedIntentional, "unintentional": comp.DiscardedError} {
			if v != nil {
				observed.Counters[key+field] = *v
			}
		}
		comp.EventsPerSecond = rate(observed.Counters, previous, key+"sent", seconds, false)
		comp.ReceivedEventsPerSecond = rate(observed.Counters, previous, key+"recv", seconds, false)
		comp.ReceivedBytesPerSecond = rate(observed.Counters, previous, key+"recv_bytes", seconds, false)
		comp.SentBytesPerSecond = rate(observed.Counters, previous, key+"sent_bytes", seconds, false)
		comp.ErrorsPerMinute = perMinute(rate(observed.Counters, previous, key+"errors", seconds, true))
		comp.FilteredPerMinute = perMinute(rate(observed.Counters, previous, key+"intentional", seconds, true))
		comp.DroppedPerMinute = perMinute(rate(observed.Counters, previous, key+"unintentional", seconds, true))
		outputs := map[string]float64{}
		for counter := range observed.Counters {
			if name, ok := strings.CutPrefix(counter, key+"out:"); ok {
				if r := rate(observed.Counters, previous, counter, seconds, false); r != nil {
					outputs[name] = *r
				}
			}
		}
		if len(outputs) > 0 {
			comp.SentByOutput = outputs
		}
	}
	c.counters = observed.Counters
	c.uptime = sample.UptimeSeconds
	c.sampled = now
	return sample
}

func value(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

// discoverExporter finds a prometheus_exporter sink in the effective
// configuration that exports Vector's own internal_metrics on a literal
// loopback address. It returns that address and the metrics namespace.
// Exporters with TLS or authentication are not scraped.
func discoverExporter(config []byte, policy CapabilityPolicy) (address, namespace string) {
	var root struct {
		Sources    map[string]map[string]any `json:"sources"`
		Transforms map[string]map[string]any `json:"transforms"`
		Sinks      map[string]map[string]any `json:"sinks"`
	}
	if json.Unmarshal(config, &root) != nil {
		return "", ""
	}
	namespaces := map[string]string{}
	for id, source := range root.Sources {
		if source["type"] == "internal_metrics" {
			ns, _ := source["namespace"].(string)
			if ns == "" {
				ns = "vector"
			}
			namespaces[id] = ns
		}
	}
	if len(namespaces) == 0 {
		return "", ""
	}
	// Walk inputs upstream (through transforms) to an internal_metrics source.
	var reaches func(id string, depth int) string
	reaches = func(id string, depth int) string {
		id, _, _ = strings.Cut(id, ".")
		if ns, ok := namespaces[id]; ok {
			return ns
		}
		transform, ok := root.Transforms[id]
		if !ok || depth > 8 {
			return ""
		}
		inputs, _ := transform["inputs"].([]any)
		for _, input := range inputs {
			if name, ok := input.(string); ok {
				if ns := reaches(name, depth+1); ns != "" {
					return ns
				}
			}
		}
		return ""
	}
	ids := make([]string, 0, len(root.Sinks))
	for id := range root.Sinks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		sink := root.Sinks[id]
		if sink["type"] != "prometheus_exporter" || sink["tls"] != nil || sink["auth"] != nil {
			continue
		}
		addr, _ := sink["address"].(string)
		host, port, err := net.SplitHostPort(addr)
		ip := net.ParseIP(host)
		n, perr := strconv.Atoi(port)
		if err != nil || ip == nil || !ip.IsLoopback() || perr != nil || n < 1 || n > 65535 {
			continue
		}
		if !policy.FullVectorConfig && !policy.listenerAllowed(addr) {
			continue
		}
		inputs, _ := sink["inputs"].([]any)
		for _, input := range inputs {
			if name, ok := input.(string); ok {
				if ns := reaches(name, 0); ns != "" {
					return addr, ns
				}
			}
		}
	}
	return "", ""
}

// metricsEndpoint picks the explicit endpoint, else one discovered in the
// running configuration.
func (e *Engine) metricsEndpoint(running []byte) (endpoint, source, address, namespace string) {
	_, ns := discoverExporter(running, CapabilityPolicy{FullVectorConfig: true})
	if e.Settings.MetricsURL != "" {
		if u, err := url.Parse(e.Settings.MetricsURL); err == nil {
			address = u.Host
		}
		return e.Settings.MetricsURL, metricsExplicit, address, ns
	}
	address, namespace = discoverExporter(running, e.Settings.CapabilityPolicy)
	if address == "" {
		return "", metricsNone, "", ""
	}
	host, port, _ := net.SplitHostPort(address)
	return "http://" + net.JoinHostPort(host, port) + "/metrics", metricsDiscovered, address, namespace
}

// collectTelemetry samples metrics when the policy allows it, reporting
// where the sample came from for host_runtime.
func (e *Engine) collectTelemetry(ctx context.Context, running []byte) (*Telemetry, string, string) {
	endpoint, source, address, namespace := e.metricsEndpoint(running)
	if !e.State.Policy.TelemetryEnabled || endpoint == "" {
		return nil, source, address
	}
	if e.Metrics == nil {
		e.Metrics = &MetricsCollector{client: metricsClient()}
	}
	if e.Metrics.setEndpoint(endpoint, namespace) != nil {
		return nil, source, address
	}
	return e.Metrics.Collect(ctx, e.now()), source, address
}

func ConfigureMetrics(dir, endpoint string) error {
	return configureMetrics(dir, &endpoint, false)
}

// ClearMetrics explicitly removes the local collector endpoint. It neither
// changes remote telemetry policy nor removes an exporter from a pipeline.
func ClearMetrics(dir string) error {
	return configureMetrics(dir, nil, true)
}

func validateMetricsChange(endpoint *string, clear bool) error {
	if endpoint != nil && clear {
		return errors.New("metrics URL and explicit clear are mutually exclusive")
	}
	if endpoint != nil {
		if _, err := checkMetricsURL(*endpoint); err != nil {
			return err
		}
	}
	return nil
}

func configureMetrics(dir string, endpoint *string, clear bool) error {
	if endpoint == nil && !clear {
		return errors.New("provide a metrics URL or request an explicit clear")
	}
	if err := validateMetricsChange(endpoint, clear); err != nil {
		return err
	}
	unlock, err := lockSettingsMaintenance(dir)
	if err != nil {
		return err
	}
	defer unlock()
	doc, err := loadSettingsDocument(dir)
	if err != nil {
		return err
	}
	s := doc.value
	s.MetricsURL = ""
	if endpoint != nil {
		s.MetricsURL = *endpoint
	}
	return doc.save(s)
}
