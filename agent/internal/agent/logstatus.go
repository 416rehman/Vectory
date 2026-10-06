package agent

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// deliveryErrorTypes are the error_type values Vector logs when a sink fails
// to deliver a request. The server reads the same field from the heartbeat's
// log summary (data_plane.rs), so the host and the dashboard agree.
var deliveryErrorTypes = map[string]bool{"request_failed": true}

// deliveryWindow is how far back status reads Vector's log: the last minute.
const deliveryWindow = time.Minute

// statusLogLines bounds how much of the local log status reads.
const statusLogLines = 2000

// DeliveryProblem is a sink that failed requests in the last minute, read
// from the local Vector log. It never leaves the host.
type DeliveryProblem struct {
	ComponentID string `json:"component_id"`
	Errors      uint64 `json:"errors_last_minute"`
	Reason      string `json:"reason,omitempty"`
	Destination string `json:"destination,omitempty"`
}

// Summary is the status line: "sink out: 27 errors in the last minute:
// Connection refused (127.0.0.1:8239) · see vectory logs".
func (p *DeliveryProblem) Summary() string {
	noun := "errors"
	if p.Errors == 1 {
		noun = "error"
	}
	text := fmt.Sprintf("sink %s: %d %s in the last minute", p.ComponentID, p.Errors, noun)
	cause := p.Reason
	if p.Destination != "" {
		if cause == "" {
			cause = "sending to " + p.Destination
		} else {
			cause += " (" + p.Destination + ")"
		}
	}
	if cause != "" {
		text += ": " + cause
	}
	return text + " · see vectory logs"
}

// Next is what to check about it, on the agent installed at dir.
func (p *DeliveryProblem) Next(dir string) string {
	if p.Destination != "" {
		return "Check that " + p.Destination + " is reachable from this host."
	}
	return "Check that " + p.ComponentID + "'s destination is reachable from this host; `" + CommandFor(dir, "vectory logs") + "` shows each failure."
}

// recentDeliveryProblem reads the tail of the local Vector log and returns
// the sink with the most failed requests in the last minute, or nil. Vector
// rate-limits repeated log lines and then writes "Internal log [message]
// has been suppressed N times."; those repeats count toward their message.
func recentDeliveryProblem(dir, managedConfig string, now time.Time) *DeliveryProblem {
	lines := tailLines(filepath.Join(dir, vectorLogName), nil, statusLogLines)
	type group struct {
		component string
		failing   bool
		count     uint64
		reason    string
	}
	groups := map[string]*group{}
	cutoff := now.Add(-deliveryWindow)
	for _, line := range lines {
		rec, ok := parseVectorRecord([]byte(line))
		if !ok || (rec.Level != "WARN" && rec.Level != "ERROR") || rec.ComponentKind != "sink" || rec.ComponentID == "" {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, rec.Timestamp)
		if err != nil || at.Before(cutoff) || at.After(now.Add(time.Minute)) {
			continue
		}
		message, add := rec.Message, uint64(1)
		if m := suppressedLog.FindStringSubmatch(message); m != nil {
			message = m[1]
			add, _ = strconv.ParseUint(m[2], 10, 32)
		} else if strings.HasPrefix(message, "Internal log [") {
			continue // "is being suppressed" markers carry no occurrence
		}
		key := rec.ComponentID + "\x00" + message
		g := groups[key]
		if g == nil {
			g = &group{component: rec.ComponentID}
			groups[key] = g
		}
		g.count += add
		if deliveryErrorTypes[rec.ErrorType] {
			g.failing = true
		}
		if reason := classifyNetwork(rec.Error); reason != "" {
			g.reason = reason
		}
	}
	perSink := map[string]*DeliveryProblem{}
	for _, g := range groups {
		if !g.failing {
			continue
		}
		p := perSink[g.component]
		if p == nil {
			p = &DeliveryProblem{ComponentID: g.component}
			perSink[g.component] = p
		}
		p.Errors += g.count
		if p.Reason == "" {
			p.Reason = reasonLabel(g.reason)
		}
	}
	if len(perSink) == 0 {
		return nil
	}
	problems := make([]*DeliveryProblem, 0, len(perSink))
	for _, p := range perSink {
		problems = append(problems, p)
	}
	sort.Slice(problems, func(i, j int) bool {
		if problems[i].Errors != problems[j].Errors {
			return problems[i].Errors > problems[j].Errors
		}
		return problems[i].ComponentID < problems[j].ComponentID
	})
	worst := problems[0]
	if data, err := readArtifact(managedConfig); err == nil {
		worst.Destination = sinkDestination(data, worst.ComponentID)
	}
	return worst
}

// reasonLabel names a classified network failure the way Vector's operators
// read it in a terminal.
func reasonLabel(reason string) string {
	switch reason {
	case "":
		return ""
	case "connection_refused":
		return "Connection refused"
	case "dns":
		return "Host name not found"
	case "tls":
		return "TLS handshake failed"
	case "timeout":
		return "Timed out"
	case "connection_reset":
		return "Connection reset"
	case "unreachable":
		return "Network unreachable"
	case "permission_denied":
		return "Permission denied"
	}
	if code, ok := strings.CutPrefix(reason, "http_"); ok {
		return "HTTP " + code
	}
	return ""
}

// sinkDestination is host:port of a sink's destination in the running
// configuration (uri, endpoint, or the first of endpoints), or "". Only the
// host and port are shown, never credentials or a path.
func sinkDestination(config []byte, id string) string {
	var root struct {
		Sinks map[string]map[string]json.RawMessage `json:"sinks"`
	}
	if json.Unmarshal(config, &root) != nil {
		return ""
	}
	sink := root.Sinks[id]
	var candidates []string
	for _, key := range []string{"uri", "endpoint"} {
		var value string
		if json.Unmarshal(sink[key], &value) == nil && value != "" {
			candidates = append(candidates, value)
		}
	}
	var endpoints []string
	if json.Unmarshal(sink["endpoints"], &endpoints) == nil && len(endpoints) > 0 {
		candidates = append(candidates, endpoints[0])
	}
	for _, candidate := range candidates {
		u, err := url.Parse(candidate)
		if err != nil || u.Hostname() == "" {
			continue
		}
		port := u.Port()
		if port == "" {
			port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
		}
		if port == "" {
			return u.Hostname()
		}
		return net.JoinHostPort(u.Hostname(), port)
	}
	return ""
}
