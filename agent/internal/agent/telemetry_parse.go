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

type metricObservation struct {
	Telemetry
	Events          *float64
	ComponentEvents map[string]float64
}

var safeMetricIdentifier = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
var safeMetricType = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
var metricLabel = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"\s*(?:,|$)`)

// Parse label grammar rather than searching within quoted values. Only bounded
// component IDs/types are returned; host/file/URI/error labels never leave host.
func componentLabels(raw string) (id, typ, kind string, ok bool) {
	seen := map[string]bool{}
	for raw != "" {
		m := metricLabel.FindStringSubmatch(raw)
		if m == nil || seen[m[1]] || len(seen) >= 32 {
			return "", "", "", false
		}
		seen[m[1]] = true
		raw = raw[len(m[0]):]
		switch m[1] {
		case "component_id":
			id = m[2]
		case "component_type":
			typ = m[2]
		case "component_kind":
			kind = m[2]
		}
	}
	if id != "" && !safeMetricIdentifier.MatchString(id) {
		return "", "", "", false
	}
	if typ != "" && !safeMetricType.MatchString(typ) {
		return "", "", "", false
	}
	if kind != "" && kind != "source" && kind != "transform" && kind != "sink" {
		return "", "", "", false
	}
	return id, typ, kind, true
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
func parseMetricObservation(data []byte) (metricObservation, error) {
	o := metricObservation{ComponentEvents: map[string]float64{}}
	components := map[string]*ComponentTelemetry{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 32768)
	lines, series := 0, 0
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
		name := strings.TrimPrefix(m[1], "vector_")
		switch name {
		case "component_sent_events_total", "component_errors_total", "component_discarded_events_total", "buffer_size_bytes", "uptime_seconds":
		default:
			continue
		}
		v, e := strconv.ParseFloat(m[3], 64)
		if e != nil || v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		id, typ, kind, ok := componentLabels(m[2])
		if !ok {
			continue
		}
		if name == "uptime_seconds" {
			if id == "" {
				if o.UptimeSeconds != nil {
					return o, errors.New("ambiguous process uptime series")
				}
				o.UptimeSeconds = &v
			}
			continue
		}
		var c *ComponentTelemetry
		if id != "" {
			c = components[id]
			if c == nil {
				if len(components) >= 50 {
					return o, errors.New("component metric limit exceeded")
				}
				c = &ComponentTelemetry{ID: id, Type: typ}
				components[id] = c
			} else if c.Type != "" && typ != "" && c.Type != typ {
				return o, errors.New("component metric identity changed")
			}
		}
		switch name {
		case "component_sent_events_total":
			if kind == "source" && typ != "internal_metrics" {
				if e = addMetric(&o.Events, v); e != nil {
					return o, e
				}
			}
			if c != nil {
				o.ComponentEvents[id] += v
				if math.IsInf(o.ComponentEvents[id], 0) {
					return o, errors.New("component counter overflow")
				}
			}
		case "component_errors_total":
			if e = addMetric(&o.Errors, v); e != nil {
				return o, e
			}
			if c != nil {
				if e = addMetric(&c.Errors, v); e != nil {
					return o, e
				}
			}
		case "component_discarded_events_total":
			if e = addMetric(&o.DiscardedEvents, v); e != nil {
				return o, e
			}
			if c != nil {
				if e = addMetric(&c.DiscardedEvents, v); e != nil {
					return o, e
				}
			}
		case "buffer_size_bytes":
			if e = addMetric(&o.BufferBytes, v); e != nil {
				return o, e
			}
			if c != nil {
				if e = addMetric(&c.BufferBytes, v); e != nil {
					return o, e
				}
			}
		}
	}
	if scanner.Err() != nil {
		return o, errors.New("metrics token limit exceeded")
	}
	ids := make([]string, 0, len(components))
	for id := range components {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		o.Components = append(o.Components, *components[id])
	}
	return o, nil
}
