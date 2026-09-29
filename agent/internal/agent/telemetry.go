package agent

import (
	"context"
	"errors"
	"io"

	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"time"
)

// Metrics must be explicitly provisioned by the host operator and represented in
// the published pipeline; the agent never silently inserts monitoring components.
type MetricsCollector struct {
	url               string
	client            *http.Client
	previous          float64
	sampled           time.Time
	hadEvents         bool
	componentPrevious map[string]float64
	uptime            *float64
}

func NewMetricsCollector(endpoint string) (*MetricsCollector, error) {
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
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	transport.MaxConnsPerHost = 1
	return &MetricsCollector{url: u.String(), client: &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("telemetry redirects forbidden") }}}, nil
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
	observed, e := parseMetricObservation(data)
	if e != nil || (observed.Events == nil && observed.Errors == nil && observed.UptimeSeconds == nil && observed.BufferBytes == nil && observed.DiscardedEvents == nil && len(observed.Components) == 0) {
		return nil
	}
	sample := &observed.Telemetry
	sample.SampledAt = now.UTC()
	continuous := now.After(c.sampled) && (c.uptime == nil || sample.UptimeSeconds == nil || *sample.UptimeSeconds >= *c.uptime)
	if observed.Events != nil && c.hadEvents && continuous && *observed.Events >= c.previous {
		rate := (*observed.Events - c.previous) / now.Sub(c.sampled).Seconds()
		sample.EventsPerSecond = &rate
	}
	for i := range sample.Components {
		comp := &sample.Components[i]
		counter, found := observed.ComponentEvents[comp.ID]
		previous, had := c.componentPrevious[comp.ID]
		if found && had && continuous && counter >= previous {
			rate := (counter - previous) / now.Sub(c.sampled).Seconds()
			comp.EventsPerSecond = &rate
		}
	}
	if observed.Events != nil {
		c.previous = *observed.Events
	}
	c.componentPrevious = observed.ComponentEvents
	c.uptime = sample.UptimeSeconds
	c.sampled = now
	c.hadEvents = observed.Events != nil
	return sample
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
		collector, err := NewMetricsCollector(*endpoint)
		if err != nil {
			return err
		}
		collector.client.CloseIdleConnections()
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
