// Isolated capacity driver: simulated devices over real mTLS and HTTP/2.
//
// Every device has its own key, certificate and connection pool, checks each
// signed manifest (signature, device, nonce, generation), follows rollouts by
// downloading the artifact and checking its digest, and reports the result
// the way the agent does: a follow-up check-in two seconds after an apply. The
// apply itself is synthetic: no Vector runs, so a "verified_applied" report
// here is fixture input and never evidence of activation. An optional
// enroller adds churn through the real enrollment endpoint, and each enrolled
// device makes its first check-in. Heartbeat cadence changes by phase, so one
// run measures several request rates.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	crand "crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"sync"
	"time"
)

type device struct {
	ID          string `json:"id"`
	Certificate string `json:"certificate"`
	Key         string `json:"key"`
}

type phase struct {
	Name     string  `json:"name"`
	At       float64 `json:"at"`
	Interval float64 `json:"interval"`
}

type enrollment struct {
	Token     string   `json:"token"`
	PerMinute float64  `json:"per_minute"`
	Prefix    string   `json:"prefix"`
	Sources   []string `json:"sources"`
	Start     float64  `json:"start"`
	Stop      float64  `json:"stop"`
}

type plan struct {
	Server        string      `json:"server"`
	CA            string      `json:"ca"`
	SigningKey    string      `json:"signing_key"`
	VectorVersion string      `json:"vector_version"`
	Duration      float64     `json:"duration"`
	Phases        []phase     `json:"phases"`
	Components    int         `json:"components"`
	Devices       []device    `json:"devices"`
	Enroll        *enrollment `json:"enroll"`
}

// stats collects one kind of request: overall, per phase (only the settled
// part, after one full interval of the phase's cadence) and per second.
type stats struct {
	mu        sync.Mutex
	requests  int
	success   int
	errors    map[string]int
	all       []float64
	good      []float64
	byPhase   map[string]*phaseStats
	perSecond map[int]*secondStats
}

type phaseStats struct {
	requests, success int
	errors            map[string]int
	good              []float64
}

type secondStats struct {
	requests, errors int
	latency          []float64
}

func newStats() *stats {
	return &stats{errors: map[string]int{}, byPhase: map[string]*phaseStats{}, perSecond: map[int]*secondStats{}}
}

type driver struct {
	plan      plan
	public    ed25519.PublicKey
	roots     *x509.CertPool
	started   time.Time
	deadline  time.Time
	heartbeat *stats
	download  *stats
	enroll    *stats
	firstBeat *stats
	mu        sync.Mutex
	seen      map[int64][]int64
	applied   map[int64][]int64
	protocols map[string]int
	attempted int
	succeeded int
	sent      int64
	received  int64
	artifacts int64
}

func (d *driver) elapsed() float64 { return time.Since(d.started).Seconds() }

// phaseAt returns the phase in force at t seconds and whether its cadence has
// settled (one full interval has passed since it started).
func (d *driver) phaseAt(t float64) (phase, bool) {
	current := d.plan.Phases[0]
	for _, p := range d.plan.Phases {
		if t >= p.At {
			current = p
		}
	}
	return current, t >= current.At+current.Interval
}

func (s *stats) record(d *driver, begin time.Time, latency float64, kind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests++
	s.all = append(s.all, latency)
	at := begin.Sub(d.started).Seconds()
	second := s.perSecond[int(at)]
	if second == nil {
		second = &secondStats{}
		s.perSecond[int(at)] = second
	}
	second.requests++
	second.latency = append(second.latency, latency)
	p, settled := d.phaseAt(at)
	var entry *phaseStats
	if settled {
		entry = s.byPhase[p.Name]
		if entry == nil {
			entry = &phaseStats{errors: map[string]int{}}
			s.byPhase[p.Name] = entry
		}
		entry.requests++
	}
	if kind == "" {
		s.success++
		s.good = append(s.good, latency)
		if entry != nil {
			entry.success++
			entry.good = append(entry.good, latency)
		}
		return
	}
	s.errors[kind]++
	second.errors++
	if entry != nil {
		entry.errors[kind]++
	}
}

func quantiles(values []float64) map[string]float64 {
	if len(values) == 0 {
		return nil
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	at := func(q float64) float64 { return math.Round(sorted[int(float64(len(sorted)-1)*q)]*1000) / 1000 }
	return map[string]float64{"p50": at(.5), "p95": at(.95), "p99": at(.99), "max": at(1)}
}

func (s *stats) report(d *driver) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	phases := map[string]any{}
	for i, p := range d.plan.Phases {
		entry := s.byPhase[p.Name]
		if entry == nil {
			continue
		}
		end := d.plan.Duration
		if i+1 < len(d.plan.Phases) {
			end = d.plan.Phases[i+1].At
		}
		settled := end - p.At - p.Interval
		phases[p.Name] = map[string]any{"requests": entry.requests, "success": entry.success, "errors": entry.errors, "settled_from": p.At + p.Interval, "settled_until": end, "success_per_second": math.Round(float64(entry.success)/math.Max(settled, 1)*10) / 10, "latency_successful_ms": quantiles(entry.good)}
	}
	keys := []int{}
	for second := range s.perSecond {
		keys = append(keys, second)
	}
	sort.Ints(keys)
	seconds := []map[string]any{}
	for _, second := range keys {
		entry := s.perSecond[second]
		q := quantiles(entry.latency)
		seconds = append(seconds, map[string]any{"t": second, "requests": entry.requests, "errors": entry.errors, "p99_ms": q["p99"], "max_ms": q["max"]})
	}
	return map[string]any{"requests": s.requests, "success": s.success, "errors": s.errors, "latency_all_ms": quantiles(s.all), "latency_successful_ms": quantiles(s.good), "phases": phases, "per_second": seconds}
}

type manifest struct {
	Device           string `json:"device_id"`
	Nonce            string `json:"nonce"`
	Generation       int64  `json:"generation"`
	PolicyGeneration int64  `json:"policy_generation"`
	Desired          *struct {
		Digest string `json:"sha256"`
		Size   int64  `json:"size"`
		Path   string `json:"artifact_path"`
	} `json:"desired"`
}

// client is one simulated device and what its agent would remember.
type client struct {
	id       string
	http     *http.Client
	rng      *rand.Rand
	boot     string
	uptime   float64
	gen      int64 // generation applied (synthetically) and reported
	policy   int64
	sha      string
	state    string
	reported int64 // highest generation whose apply a check-in has reported
	everOK   bool
}

func newTransport(roots *x509.CertPool, certificate *tls.Certificate, source string) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}
	if certificate != nil {
		transport.TLSClientConfig.Certificates = []tls.Certificate{*certificate}
	}
	if source != "" {
		dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second, LocalAddr: &net.TCPAddr{IP: net.ParseIP(source)}}
		transport.DialContext = dialer.DialContext
	}
	transport.MaxConnsPerHost = 2
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.DisableCompression = true
	transport.ForceAttemptHTTP2 = true
	return transport
}

func newClient(transport *http.Transport) *http.Client {
	return &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect forbidden") }}
}

// telemetry is a sample shaped like the agent's: every device-level field the
// server accepts, rates with full float precision, and a few components.
func (c *client) telemetry(components int, uptime float64) map[string]any {
	r := c.rng
	in := 50 + r.Float64()*450
	out := in * (0.97 + r.Float64()*0.03)
	sample := map[string]any{
		"sampled_at":            time.Now().UTC().Format(time.RFC3339),
		"events_per_second":     in,
		"events_out_per_second": out,
		"bytes_in_per_second":   in * (180 + r.Float64()*420),
		"bytes_out_per_second":  out * (180 + r.Float64()*420),
		"errors":                float64(r.Intn(40)),
		"errors_per_minute":     r.Float64() * 0.5,
		"uptime_seconds":        math.Round(uptime),
		"memory_bytes":          float64(60_000_000 + r.Intn(140_000_000)),
		"cpu_seconds":           uptime * (0.01 + r.Float64()*0.04),
		"discarded_events":      float64(r.Intn(5000)),
		"discarded_intentional": float64(r.Intn(4900)),
		"discarded_error":       float64(r.Intn(100)),
		"filtered_per_minute":   r.Float64() * 900,
		"dropped_per_minute":    r.Float64() * 0.2,
		"buffer_bytes":          float64(r.Intn(4_000_000)),
		"buffer_events":         float64(r.Intn(9000)),
		"buffer_utilization":    r.Float64() * 0.2,
	}
	list := []map[string]any{}
	kinds := []struct{ kind, typ string }{{"source", "demo_logs"}, {"transform", "remap"}, {"sink", "blackhole"}, {"source", "internal_metrics"}, {"sink", "prometheus_exporter"}}
	for i := 0; i < components; i++ {
		k := kinds[i%len(kinds)]
		rate := in * (0.9 + r.Float64()*0.1)
		list = append(list, map[string]any{"id": fmt.Sprintf("%s_%d", k.typ, i), "type": k.typ, "kind": k.kind, "events_per_second": rate, "received_events_per_second": rate, "received_bytes_per_second": rate * 310, "sent_bytes_per_second": rate * 305, "errors": float64(r.Intn(10)), "errors_per_minute": r.Float64() * 0.1, "utilization": r.Float64() * 0.3})
	}
	sample["components"] = list
	return sample
}

// check sends one heartbeat and follows a new desired generation: download,
// digest check and a synthetic apply that the follow-up check-in reports. It
// returns the failure kind ("" on success) and whether to follow up in two
// seconds.
func (d *driver) check(c *client) (string, bool) {
	nonceBytes := make([]byte, 32)
	if _, err := crand.Read(nonceBytes); err != nil {
		return "nonce", false
	}
	nonce := base64.StdEncoding.EncodeToString(nonceBytes)
	body, _ := json.Marshal(map[string]any{"protocol_version": 1, "request_id": nonce, "nonce": nonce, "boot_id": c.boot, "agent_version": "capacity-driver", "vector_version": d.plan.VectorVersion, "reported_generation": c.gen, "policy_generation": c.policy, "actual_sha256": c.sha, "apply_state": c.state, "local_paused": false, "remote_pause_acknowledged": false, "telemetry": c.telemetry(d.plan.Components, c.uptime+d.elapsed())})
	request, _ := http.NewRequestWithContext(context.Background(), "POST", d.plan.Server+"/agent/v1/heartbeat", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	begin := time.Now()
	response, err := c.http.Do(request)
	kind, protocol := "", ""
	var data []byte
	var m manifest
	if err != nil {
		kind = "connection_error"
		if errors.Is(err, context.DeadlineExceeded) {
			kind = "timeout"
		}
	} else {
		var readError error
		data, readError = io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
		response.Body.Close()
		protocol = response.Proto
		switch {
		case readError != nil || len(data) > 1<<20:
			kind = "response_read_error"
		case response.StatusCode != 200:
			kind = fmt.Sprintf("HTTP %d", response.StatusCode)
		default:
			var envelope struct {
				Payload   string `json:"payload"`
				Signature string `json:"signature"`
			}
			kind = "manifest_binding_failure"
			if json.Unmarshal(data, &envelope) == nil {
				payload, e1 := base64.StdEncoding.DecodeString(envelope.Payload)
				signature, e2 := base64.StdEncoding.DecodeString(envelope.Signature)
				if e1 == nil && e2 == nil && ed25519.Verify(d.public, payload, signature) && json.Unmarshal(payload, &m) == nil && m.Device == c.id && m.Nonce == nonce && m.Generation >= c.gen {
					kind = ""
				}
			}
		}
	}
	latency := float64(time.Since(begin)) / float64(time.Millisecond)
	d.heartbeat.record(d, begin, latency, kind)
	d.mu.Lock()
	d.sent += int64(len(body))
	d.received += int64(len(data))
	if protocol != "" {
		d.protocols[protocol]++
	}
	if kind == "" && !c.everOK {
		d.succeeded++
	}
	if kind == "" && c.state == "verified_applied" && c.gen > c.reported {
		d.applied[c.gen] = append(d.applied[c.gen], time.Now().UnixMilli())
	}
	d.mu.Unlock()
	if kind != "" {
		return kind, false
	}
	c.everOK = true
	if c.state == "verified_applied" {
		c.reported = c.gen
	}
	c.policy = m.PolicyGeneration
	if m.Desired == nil || m.Generation <= c.gen {
		return "", false
	}
	d.mu.Lock()
	d.seen[m.Generation] = append(d.seen[m.Generation], time.Now().UnixMilli())
	d.mu.Unlock()
	if !d.fetch(c, m.Desired.Path, m.Desired.Digest, m.Desired.Size) {
		return "", false
	}
	c.gen, c.sha, c.state = m.Generation, m.Desired.Digest, "verified_applied"
	return "", true
}

func (d *driver) fetch(c *client, path, digest string, size int64) bool {
	begin := time.Now()
	kind := ""
	var length int64
	response, err := c.http.Get(d.plan.Server + path)
	if err != nil {
		kind = "connection_error"
	} else {
		data, readError := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
		response.Body.Close()
		sum := sha256.Sum256(data)
		length = int64(len(data))
		switch {
		case readError != nil:
			kind = "response_read_error"
		case response.StatusCode != 200:
			kind = fmt.Sprintf("HTTP %d", response.StatusCode)
		case hex.EncodeToString(sum[:]) != digest || length != size:
			kind = "digest_mismatch"
		}
	}
	d.download.record(d, begin, float64(time.Since(begin))/float64(time.Millisecond), kind)
	if kind == "" {
		d.mu.Lock()
		d.artifacts += length
		d.mu.Unlock()
	}
	return kind == ""
}

// run keeps one device checking in until the deadline. When a new phase
// starts, the next check-in moves to a uniformly jittered point within the new
// interval, so the rate changes within one interval, not after the old sleep.
func (d *driver) run(c *client, group *sync.WaitGroup) {
	defer group.Done()
	defer c.http.CloseIdleConnections()
	current, _ := d.phaseAt(0)
	next := d.started.Add(time.Duration(c.rng.Float64() * current.Interval * float64(time.Second)))
	d.mu.Lock()
	d.attempted++
	d.mu.Unlock()
	failures := 0
	for {
		if p, _ := d.phaseAt(d.elapsed()); p.Name != current.Name {
			start := d.started.Add(time.Duration(p.At * float64(time.Second)))
			if candidate := start.Add(time.Duration(c.rng.Float64() * p.Interval * float64(time.Second))); candidate.Before(next) {
				next = candidate
			}
			current = p
		}
		if next.After(d.deadline) {
			return
		}
		wait := time.Until(next)
		for _, candidate := range d.plan.Phases {
			if candidate.At <= current.At {
				continue
			}
			if boundary := time.Until(d.started.Add(time.Duration(candidate.At * float64(time.Second)))); boundary > 0 && boundary < wait {
				wait = boundary
			}
			break
		}
		if wait > 0 {
			time.Sleep(wait)
		}
		if time.Now().Before(next) {
			continue // a phase boundary: reschedule for the new cadence
		}
		kind, followUp := d.check(c)
		base := current.Interval
		if kind != "" {
			failures++
			base = math.Min(300, float64(5*(int64(1)<<min(failures, 6))))
		} else {
			failures = 0
		}
		delay := time.Duration(base * (.8 + .4*c.rng.Float64()) * float64(time.Second))
		if followUp {
			delay = 2 * time.Second
		}
		next = time.Now().Add(delay)
	}
}

func (d *driver) enroller(group *sync.WaitGroup) {
	defer group.Done()
	e := d.plan.Enroll
	if e == nil || e.PerMinute <= 0 || len(e.Sources) == 0 {
		return
	}
	clients := make([]*http.Client, len(e.Sources))
	for i, source := range e.Sources {
		clients[i] = newClient(newTransport(d.roots, nil, source))
	}
	time.Sleep(time.Until(d.started.Add(time.Duration(e.Start * float64(time.Second)))))
	stop := d.started.Add(time.Duration(e.Stop * float64(time.Second)))
	ticker := time.NewTicker(time.Duration(60 / e.PerMinute * float64(time.Second)))
	defer ticker.Stop()
	slots := make(chan struct{}, 64)
	var inflight sync.WaitGroup
	for n := 0; time.Now().Before(stop); n++ {
		select {
		case slots <- struct{}{}:
			inflight.Add(1)
			go func(n int) {
				defer inflight.Done()
				defer func() { <-slots }()
				d.enrollOne(clients[n%len(clients)], n)
			}(n)
		default:
			d.enroll.record(d, time.Now(), 0, "driver_backlog")
		}
		<-ticker.C
	}
	inflight.Wait()
}

func (d *driver) enrollOne(enroller *http.Client, n int) {
	e := d.plan.Enroll
	key, err := ecdsa.GenerateKey(elliptic.P256(), crand.Reader)
	if err != nil {
		return
	}
	name := fmt.Sprintf("%s%05d", e.Prefix, n)
	der, err := x509.CreateCertificateRequest(crand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: name}}, key)
	if err != nil {
		return
	}
	requestID := make([]byte, 16)
	_, _ = crand.Read(requestID)
	body, _ := json.Marshal(map[string]any{"protocol_version": 1, "token": e.Token, "request_id": hex.EncodeToString(requestID), "name": name, "os": "linux", "arch": "amd64", "agent_version": "capacity-driver", "vector_version": d.plan.VectorVersion, "csr_pem": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))})
	request, _ := http.NewRequest("POST", d.plan.Server+"/agent/v1/enroll", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	begin := time.Now()
	response, err := enroller.Do(request)
	kind := ""
	var enrolled struct {
		Device      string `json:"device_id"`
		Certificate string `json:"certificate_pem"`
	}
	if err != nil {
		kind = "connection_error"
	} else {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		response.Body.Close()
		if response.StatusCode != 200 {
			kind = fmt.Sprintf("HTTP %d", response.StatusCode)
		} else if json.Unmarshal(data, &enrolled) != nil || enrolled.Device == "" || enrolled.Certificate == "" {
			kind = "invalid_response"
		}
	}
	d.enroll.record(d, begin, float64(time.Since(begin))/float64(time.Millisecond), kind)
	if kind != "" {
		return
	}
	// The new device's first check-in, with its own certificate and pool.
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return
	}
	certificate, err := tls.X509KeyPair([]byte(enrolled.Certificate), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		d.firstBeat.record(d, time.Now(), 0, "certificate_unusable")
		return
	}
	c := &client{id: enrolled.Device, http: newClient(newTransport(d.roots, &certificate, "")), rng: rand.New(rand.NewSource(int64(n))), state: "unmanaged", boot: "capacity-enrolled"}
	defer c.http.CloseIdleConnections()
	first := time.Now()
	kind, _ = d.check(c)
	d.firstBeat.record(d, first, float64(time.Since(first))/float64(time.Millisecond), kind)
}

func run() error {
	input := flag.String("plan", "", "private fixture plan")
	output := flag.String("out", "", "measurement JSON")
	flag.Parse()
	raw, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	var p plan
	if err = json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if p.Duration <= 0 || len(p.Phases) == 0 || p.Phases[0].At != 0 || len(p.Devices) == 0 || p.Components < 0 || p.Components > 50 {
		return errors.New("invalid measurement parameters")
	}
	for i, ph := range p.Phases {
		if ph.Interval < 2 || ph.Name == "" || (i > 0 && ph.At <= p.Phases[i-1].At) {
			return errors.New("invalid phase list")
		}
	}
	ca, err := os.ReadFile(p.CA)
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return errors.New("invalid fixture CA")
	}
	public, err := base64.StdEncoding.DecodeString(p.SigningKey)
	if err != nil || len(public) != ed25519.PublicKeySize {
		return errors.New("invalid fixture signing key")
	}
	d := &driver{plan: p, public: public, roots: roots, heartbeat: newStats(), download: newStats(), enroll: newStats(), firstBeat: newStats(), seen: map[int64][]int64{}, applied: map[int64][]int64{}, protocols: map[string]int{}}
	setup := time.Now()
	clients := make([]*client, len(p.Devices))
	for i, dev := range p.Devices {
		certificate, err := tls.LoadX509KeyPair(dev.Certificate, dev.Key)
		if err != nil {
			return err
		}
		clients[i] = &client{id: dev.ID, http: newClient(newTransport(roots, &certificate, "")), rng: rand.New(rand.NewSource(int64(20260929 + i))), state: "unmanaged", boot: fmt.Sprintf("capacity-%d", i), uptime: float64(3600 + i%7200)}
	}
	setupSeconds := time.Since(setup).Seconds()
	d.started = time.Now()
	d.deadline = d.started.Add(time.Duration(p.Duration * float64(time.Second)))
	fmt.Printf("{\"traffic_started_unix_ms\":%d,\"setup_seconds\":%.3f}\n", d.started.UnixMilli(), setupSeconds)
	var group sync.WaitGroup
	for _, c := range clients {
		group.Add(1)
		go d.run(c, &group)
	}
	group.Add(1)
	go d.enroller(&group)
	group.Wait()
	rollouts := map[string]any{}
	for generation, seen := range d.seen {
		rollouts[fmt.Sprint(generation)] = map[string]any{"seen_unix_ms": seen, "applied_reported_unix_ms": d.applied[generation]}
	}
	result := map[string]any{
		"transport":                     "Go net/http DefaultTransport clone per device; TLS 1.3 mutual authentication; HTTP/2 when negotiated",
		"go_version":                    runtime.Version(),
		"devices":                       len(clients),
		"setup_seconds_outside_traffic": setupSeconds,
		"traffic_started_unix_ms":       d.started.UnixMilli(),
		"elapsed_seconds":               d.elapsed(),
		"phases":                        p.Phases,
		"components_per_sample":         p.Components,
		"devices_attempted":             d.attempted,
		"devices_succeeded":             d.succeeded,
		"protocol_counts":               d.protocols,
		"request_bytes":                 d.sent,
		"response_bytes":                d.received,
		"artifact_bytes":                d.artifacts,
		"heartbeats":                    d.heartbeat.report(d),
		"artifact_downloads":            d.download.report(d),
		"enrollments":                   d.enroll.report(d),
		"enrolled_first_check_ins":      d.firstBeat.report(d),
		"rollouts":                      rollouts,
	}
	encoded, err := json.MarshalIndent(result, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(*output, append(encoded, '\n'), 0o600)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "capacity driver failed:", err)
		os.Exit(1)
	}
}
