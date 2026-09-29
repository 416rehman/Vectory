package agent

import (
	"bufio"
	"bytes"
	"errors"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// counterSet holds cumulative counters by stable key; the collector turns
// deltas between samples into rates.
type counterSet map[string]float64

type metricObservation struct {
	Telemetry
	Events          *float64
	ComponentEvents map[string]float64
	Counters        counterSet
}

type componentMetrics struct {
	telemetry ComponentTelemetry
	counters  bool // Vector exported event counters for this component
	outputs   map[string]bool
	// Buffer gauges summed across stages; alias is the deprecated
	// buffer_max_event_size, used only when buffer_max_size_events is absent.
	buffer struct{ events, bytes, maxEvents, alias, maxBytes *float64 }
}

var safeMetricIdentifier = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
var safeMetricType = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
var metricLabel = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"\s*(?:,|$)`)
var metricNamespace = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// metricLabels are the only labels read. Host, file, URI and error labels
// (for example http_client_errors_total's raw error_kind) never leave the host.
type metricLabels struct {
	id, typ, kind, output, intentional string
}

// Parse label grammar rather than searching within quoted values. Only bounded
// component IDs, types and output names are returned.
func componentLabels(raw string) (metricLabels, bool) {
	var l metricLabels
	seen := map[string]bool{}
	for raw != "" {
		m := metricLabel.FindStringSubmatch(raw)
		if m == nil || seen[m[1]] || len(seen) >= 32 {
			return metricLabels{}, false
		}
		seen[m[1]] = true
		raw = raw[len(m[0]):]
		switch m[1] {
		case "component_id":
			l.id = m[2]
		case "component_type":
			l.typ = m[2]
		case "component_kind":
			l.kind = m[2]
		case "output":
			l.output = m[2]
		case "intentional":
			l.intentional = m[2]
		}
	}
	if l.id != "" && !safeMetricIdentifier.MatchString(l.id) || l.typ != "" && !safeMetricType.MatchString(l.typ) ||
		l.output != "" && !safeMetricIdentifier.MatchString(l.output) {
		return metricLabels{}, false
	}
	if l.kind != "" && l.kind != "source" && l.kind != "transform" && l.kind != "sink" {
		return metricLabels{}, false
	}
	return l, true
}
func addMetric(target **float64, value float64) error {
	if *target == nil {
		v := value
		*target = &v
	} else {
		**target += value
	}
	if math.IsInf(**target, 0) {
		return errors.New("metric aggregate overflow")
	}
	return nil
}
func (c counterSet) add(key string, value float64) error {
	c[key] += value
	if math.IsInf(c[key], 0) {
		return errors.New("metric counter overflow")
	}
	return nil
}

// Families read from Vector's internal metrics, without the namespace prefix.
var metricFamilies = map[string]bool{
	"component_sent_events_total": true, "component_received_events_total": true,
	"component_sent_bytes_total": true, "component_received_bytes_total": true,
	"component_errors_total": true, "http_client_errors_total": true,
	"component_discarded_events_total": true,
	"buffer_size_events":               true, "buffer_size_bytes": true,
	"buffer_max_size_events": true, "buffer_max_event_size": true, "buffer_max_size_bytes": true,
	"utilization": true, "component_latency_mean_seconds": true, "uptime_seconds": true,
}

// ingressSource excludes Vector's own telemetry from "events in".
func ingressSource(l metricLabels) bool {
	return l.kind == "source" && l.typ != "internal_metrics" && l.typ != "internal_logs"
}

func parseMetricObservation(data []byte) (metricObservation, error) {
	return parseMetricObservationWithNamespace(data, "vector")
}

func parseMetricObservationWithNamespace(data []byte, namespace string) (metricObservation, error) {
	if !metricNamespace.MatchString(namespace) {
		namespace = "vector"
	}
	prefix := namespace + "_"
	o := metricObservation{ComponentEvents: map[string]float64{}, Counters: counterSet{}}
	components := map[string]*componentMetrics{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 32768)
	lines, series := 0, 0
	// Device-level totals; they do not require a component identity.
	var inputs struct{ events, bytes, out, outBytes, errors, intentional, unintentional, bufferEvents, bufferBytes *float64 }
	for scanner.Scan() {
		lines++
		if lines > 10000 {
			return o, errors.New("metrics line limit exceeded")
		}
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		series++
		if series > 5000 {
			return o, errors.New("metrics series limit exceeded")
		}
		m := metricLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		name := strings.TrimPrefix(m[1], prefix)
		if !metricFamilies[name] {
			continue
		}
		v, e := strconv.ParseFloat(m[3], 64)
		if e != nil || v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		l, ok := componentLabels(m[2])
		if !ok {
			continue
		}
		if name == "uptime_seconds" {
			if l.id == "" {
				if o.UptimeSeconds != nil {
					return o, errors.New("ambiguous process uptime series")
				}
				o.UptimeSeconds = &v
			}
			continue
		}
		var err error
		switch name {
		case "component_sent_events_total":
			if ingressSource(l) {
				err = addMetric(&inputs.events, v)
			} else if l.kind == "sink" {
				err = addMetric(&inputs.out, v)
			}
		case "component_received_bytes_total":
			if ingressSource(l) {
				err = addMetric(&inputs.bytes, v)
			}
		case "component_sent_bytes_total":
			if l.kind == "sink" {
				err = addMetric(&inputs.outBytes, v)
			}
		case "component_errors_total", "http_client_errors_total":
			// Failed HTTP requests (which Vector retries) and component errors
			// both mean the component is not working as intended.
			err = addMetric(&inputs.errors, v)
		case "component_discarded_events_total":
			if l.intentional == "true" {
				err = addMetric(&inputs.intentional, v)
			} else {
				err = addMetric(&inputs.unintentional, v)
			}
		case "buffer_size_events":
			err = addMetric(&inputs.bufferEvents, v)
		case "buffer_size_bytes":
			err = addMetric(&inputs.bufferBytes, v)
		}
		if err != nil {
			return o, err
		}
		if l.id == "" {
			continue
		}
		c := components[l.id]
		if c == nil {
			if len(components) >= 50 {
				return o, errors.New("component metric limit exceeded")
			}
			c = &componentMetrics{telemetry: ComponentTelemetry{ID: l.id, Type: l.typ, Kind: l.kind}, outputs: map[string]bool{}}
			components[l.id] = c
		} else if c.telemetry.Type != "" && l.typ != "" && c.telemetry.Type != l.typ {
			return o, errors.New("component metric identity changed")
		}
		if c.telemetry.Kind == "" {
			c.telemetry.Kind = l.kind
		}
		key := "c:" + l.id + ":"
		switch name {
		case "component_sent_events_total":
			c.counters = true
			err = o.Counters.add(key+"sent", v)
			o.ComponentEvents[l.id] += v
			if err == nil && l.output != "" && (c.outputs[l.output] || len(c.outputs) < 16) {
				c.outputs[l.output] = true
				err = o.Counters.add(key+"out:"+l.output, v)
			}
		case "component_received_events_total":
			c.counters = true
			err = o.Counters.add(key+"recv", v)
		case "component_received_bytes_total":
			err = o.Counters.add(key+"recv_bytes", v)
		case "component_sent_bytes_total":
			err = o.Counters.add(key+"sent_bytes", v)
		case "component_errors_total", "http_client_errors_total":
			err = addMetric(&c.telemetry.Errors, v)
		case "component_discarded_events_total":
			if err = addMetric(&c.telemetry.DiscardedEvents, v); err != nil {
				break
			}
			if l.intentional == "true" {
				err = addMetric(&c.telemetry.DiscardedIntentional, v)
			} else {
				err = addMetric(&c.telemetry.DiscardedError, v)
			}
		case "buffer_size_events":
			err = addMetric(&c.buffer.events, v)
		case "buffer_size_bytes":
			err = addMetric(&c.buffer.bytes, v)
		case "buffer_max_size_events":
			err = addMetric(&c.buffer.maxEvents, v)
		case "buffer_max_event_size":
			err = addMetric(&c.buffer.alias, v)
		case "buffer_max_size_bytes":
			err = addMetric(&c.buffer.maxBytes, v)
		case "utilization":
			if v <= 1 {
				c.telemetry.Utilization = &v
			}
		case "component_latency_mean_seconds":
			c.telemetry.LatencyMeanSeconds = &v
		}
		if err != nil {
			return o, err
		}
	}
	if scanner.Err() != nil {
		return o, errors.New("metrics token limit exceeded")
	}
	o.Events = inputs.events
	o.Errors = inputs.errors
	o.BufferEvents, o.BufferBytes = inputs.bufferEvents, inputs.bufferBytes
	o.DiscardedIntentional = inputs.intentional
	o.DiscardedError = inputs.unintentional
	if inputs.intentional != nil || inputs.unintentional != nil {
		total := 0.0
		for _, v := range []*float64{inputs.intentional, inputs.unintentional} {
			if v != nil {
				total += *v
			}
		}
		o.DiscardedEvents = &total
	}
	for key, value := range map[string]*float64{"d:in": inputs.events, "d:out": inputs.out, "d:in_bytes": inputs.bytes, "d:out_bytes": inputs.outBytes} {
		if value != nil {
			o.Counters[key] = *value
		}
	}
	ids := make([]string, 0, len(components))
	for id := range components {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	anyEvents := false
	for _, id := range ids {
		c := components[id]
		anyEvents = anyEvents || c.counters
		t := &c.telemetry
		// Vector registers error and discard counters on first use. For a
		// component whose event counters are exported, an absent counter
		// means none occurred since start, not "unknown".
		if c.counters {
			zero := 0.0
			for _, field := range []**float64{&t.Errors, &t.DiscardedEvents, &t.DiscardedIntentional, &t.DiscardedError} {
				if *field == nil {
					v := zero
					*field = &v
				}
			}
		}
		maxEvents := c.buffer.maxEvents
		if maxEvents == nil {
			maxEvents = c.buffer.alias
		}
		t.BufferEvents, t.BufferBytes, t.BufferMaxEvents, t.BufferMaxBytes = c.buffer.events, c.buffer.bytes, maxEvents, c.buffer.maxBytes
		t.BufferUtilization = bufferFill(t.BufferEvents, maxEvents, t.BufferBytes, t.BufferMaxBytes)
		if t.BufferUtilization != nil && (o.BufferUtilization == nil || *t.BufferUtilization > *o.BufferUtilization) {
			v := *t.BufferUtilization
			o.BufferUtilization = &v
		}
		o.Components = append(o.Components, *t)
	}
	if anyEvents {
		zero := 0.0
		for _, field := range []**float64{&o.Errors, &o.DiscardedEvents, &o.DiscardedIntentional, &o.DiscardedError} {
			if *field == nil {
				v := zero
				*field = &v
			}
		}
	}
	return o, nil
}

// bufferFill is the fullest dimension of a buffer, from 0 to 1.
func bufferFill(events, maxEvents, bytes, maxBytes *float64) *float64 {
	var fill *float64
	for _, pair := range [][2]*float64{{events, maxEvents}, {bytes, maxBytes}} {
		if pair[0] != nil && pair[1] != nil && *pair[1] > 0 {
			v := math.Min(1, *pair[0] / *pair[1])
			if fill == nil || v > *fill {
				fill = &v
			}
		}
	}
	return fill
}
