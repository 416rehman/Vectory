package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fakeVector(t *testing.T, version string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell-script stand-in for Vector")
	}
	path := filepath.Join(t.TempDir(), "bin", "vector")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"vector " + version + " (x86_64-unknown-linux-gnu synthetic)\"; fi\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

type setupServer struct {
	url        string
	pin        string
	enrolls    atomic.Int32
	heartbeats atomic.Int32
	// authenticated counts heartbeats that arrived with a client certificate.
	authenticated atomic.Int32
	revoked       atomic.Bool
	// hold keeps heartbeats unanswered until release is closed.
	hold    atomic.Bool
	release chan struct{}
	// features are listed in every manifest; beats and enrollment record
	// what the agent sent.
	features   []string
	mu         sync.Mutex
	beats      []map[string]any
	beatTimes  []time.Time
	enrollment map[string]any
	// waits counts /agent/v1/wait requests; wait answers them (see
	// wake_test.go), or they get 404 as from a server without the route.
	waits atomic.Int32
	wait  http.HandlerFunc
}

func (s *setupServer) sent() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.beats...)
}

// beatsAt are the arrival times of the heartbeats so far.
func (s *setupServer) beatsAt() []time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Time(nil), s.beatTimes...)
}

func (s *setupServer) setWait(handler http.HandlerFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wait = handler
}

func newSetupServer(t *testing.T) *setupServer { return newSetupServerFor(t, nil) }

// newSetupServerFor is a server whose certificate is valid for names, or for
// 127.0.0.1 and localhost when there are none.
func newSetupServerFor(t *testing.T, names []string) *setupServer {
	ca := makeCA(t)
	pub, signingKey, _ := ed25519.GenerateKey(rand.Reader)
	s := &setupServer{pin: Fingerprint(certificateSHA256(ca.cert)), release: make(chan struct{})}
	server := chainServer(t, ca, names, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agent/v1/install.sh":
			w.WriteHeader(http.StatusOK)
		case "/agent/v1/identity":
			if s.revoked.Load() || r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
				http.Error(w, `{"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}`, http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"device_id": r.TLS.PeerCertificates[0].Subject.CommonName, "name": "setup-edge"})
		case "/agent/v1/heartbeat":
			s.heartbeats.Add(1)
			if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
				s.authenticated.Add(1)
			}
			if s.hold.Load() {
				select {
				case <-s.release:
				case <-r.Context().Done():
					return
				}
			}
			var raw map[string]any
			_ = json.NewDecoder(r.Body).Decode(&raw)
			s.mu.Lock()
			s.beats = append(s.beats, raw)
			s.beatTimes = append(s.beatTimes, time.Now())
			s.mu.Unlock()
			nonce, _ := raw["nonce"].(string)
			now := time.Now().UTC().Truncate(time.Second)
			_ = json.NewEncoder(w).Encode(signed(t, Manifest{ProtocolVersion: 1, DeviceID: "5e7a9c2d-0000-4000-8000-000000000001", Nonce: nonce, IssuedAt: now, ExpiresAt: now.Add(5 * time.Minute), Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}, Features: s.features}, signingKey))
		case "/agent/v1/enroll":
			s.enrolls.Add(1)
			body, _ := io.ReadAll(r.Body)
			var request Enrollment
			_ = json.Unmarshal(body, &request)
			s.mu.Lock()
			_ = json.Unmarshal(body, &s.enrollment)
			s.mu.Unlock()
			if request.Token != "synthetic-setup-token" {
				http.Error(w, `{"error":{"code":"ENROLLMENT_FAILED","message":"Enrollment failed"}}`, http.StatusUnauthorized)
				return
			}
			block, _ := pem.Decode([]byte(request.CSRPEM))
			csr, _ := x509.ParseCertificateRequest(block.Bytes)
			expiry := time.Now().Add(time.Hour).Truncate(time.Second)
			_ = json.NewEncoder(w).Encode(Credentials{DeviceID: "5e7a9c2d-0000-4000-8000-000000000001", CertificatePEM: ca.issue(t, csr.PublicKey, "5e7a9c2d-0000-4000-8000-000000000001", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry})
		case "/agent/v1/wait":
			s.waits.Add(1)
			s.mu.Lock()
			wait := s.wait
			s.mu.Unlock()
			switch {
			case r.TLS == nil || len(r.TLS.PeerCertificates) == 0:
				http.Error(w, `{"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}`, http.StatusUnauthorized)
			case wait == nil:
				http.NotFound(w, r)
			default:
				wait(w, r)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	s.url = server.URL
	return s
}

func setupFixture(t *testing.T) (SetupOptions, string, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "state")
	managed := filepath.Join(root, "managed", "vector.json")
	return SetupOptions{StateDir: dir, ManagedConfig: managed, Service: "none", KeepExistingVector: true, Name: "setup-edge", DashboardURL: "https://vectory.example.test/"}, dir, managed
}

func stepStatus(result SetupResult, id string) string {
	status := ""
	for _, step := range result.Steps {
		if step.ID == id {
			status = step.Status
		}
	}
	return status
}

func TestSetupDryRunChecksEverythingAndChangesNothing(t *testing.T) {
	server := newSetupServer(t)
	options, dir, managed := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary, options.DryRun = server.url, server.pin, fakeVector(t, VectorVersion), true
	options.Token = func() (string, error) { t.Fatal("dry run asked for the token"); return "", nil }
	result, err := Setup(context.Background(), options)
	if err != nil || !result.OK || !result.DryRun {
		t.Fatal(result, err)
	}
	for _, id := range []string{"platform", "server", "vector", "paths", "mode"} {
		if stepStatus(result, id) != "ok" {
			t.Fatalf("step %s: %+v", id, result.Steps)
		}
	}
	if stepStatus(result, "install") != "plan" || stepStatus(result, "enroll") != "plan" {
		t.Fatalf("dry run didn't show the plan: %+v", result.Steps)
	}
	for _, path := range []string{dir, filepath.Dir(managed)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("dry run created %s", path)
		}
	}
	if server.enrolls.Load() != 0 {
		t.Fatal("dry run enrolled")
	}
}

func TestSetupEnrollsWithPinAdoptsWorkloadAndResumes(t *testing.T) {
	server := newSetupServer(t)
	options, dir, managed := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	if err := os.MkdirAll(filepath.Dir(managed), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managed, []byte(`{"sources":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	var progress []string
	options.Progress = func(step SetupStep) { progress = append(progress, step.ID+":"+step.Status) }
	tokens := 0
	options.Token = func() (string, error) { tokens++; return "synthetic-setup-token", nil }
	result, err := Setup(context.Background(), options)
	if err != nil || !result.OK || tokens != 1 || server.enrolls.Load() != 1 {
		t.Fatal(result, err)
	}
	if result.Device == nil || result.Device.Name != "setup-edge" || result.Device.Mode != "restricted" || result.DeviceURL != "https://vectory.example.test/#/devices/5e7a9c2d-0000-4000-8000-000000000001" {
		t.Fatalf("device result: %+v %s", result.Device, result.DeviceURL)
	}
	settings, err := LoadSettings(dir)
	if err != nil || settings.CAFile != filepath.Join(dir, ServerCAFile) || settings.ManagedConfig != managed || settings.CapabilityPolicy.FullVectorConfig {
		t.Fatalf("settings: %+v %v", settings, err)
	}
	if !strings.Contains(strings.Join(progress, " "), "service:info") {
		t.Fatalf("an adopted workload must not be started by setup's check-in: %v", progress)
	}
	// Running it again is safe: nothing is re-enrolled and no token is needed.
	options.Token = func() (string, error) { t.Fatal("re-run asked for a token"); return "", nil }
	options.CASHA256 = ""
	again, err := Setup(context.Background(), options)
	if err != nil || !again.OK || server.enrolls.Load() != 1 || again.Device == nil || again.Device.ID != result.Device.ID {
		t.Fatal(again, err)
	}
}

func TestSetupFailsEarlyWithoutChangesAndExplains(t *testing.T) {
	server := newSetupServer(t)
	options, dir, _ := setupFixture(t)
	options.Token = func() (string, error) { t.Fatal("asked for the token before checks passed"); return "", nil }

	options.Server, options.VectorBinary = server.url, fakeVector(t, "0.57.0")
	options.CASHA256 = server.pin
	result, err := Setup(context.Background(), options)
	if err == nil || stepStatus(result, "vector") != "fail" || !strings.Contains(err.Error(), "Found Vector 0.57.0") || !strings.Contains(err.Error(), "vector.dev/download") {
		t.Fatal("old Vector accepted or unexplained", err)
	}

	options.VectorBinary = fakeVector(t, VectorVersion)
	options.CASHA256 = Fingerprint(certificateSHA256(&x509.Certificate{Raw: []byte("another CA")}))
	if _, err = Setup(context.Background(), options); err == nil || !strings.Contains(err.Error(), "don't match the pinned CA") {
		t.Fatal("pin mismatch accepted", err)
	}

	options.CASHA256, options.CAFile = "", optionPointer("")
	if _, err = Setup(context.Background(), options); err == nil || !strings.Contains(err.Error(), "doesn't trust") {
		t.Fatal("untrusted private CA accepted without a pin", err)
	}

	options.CAFile, options.Server = nil, ""
	if _, err = Setup(context.Background(), options); err == nil || !strings.Contains(err.Error(), "--server") {
		t.Fatal("missing server not explained", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("a failed preflight created the state directory")
	}
}

func TestSetupRefusesToRebindAPossiblyDeliveredEnrollment(t *testing.T) {
	server := newSetupServer(t)
	options, dir, _ := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	options.Token = func() (string, error) { return "wrong-token", nil }
	if _, err := Setup(context.Background(), options); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatal("refusal not reported", err)
	}
	// A refusal is definitive, so another name and token may follow.
	options.Name = "renamed-edge"
	options.Token = func() (string, error) { return "synthetic-setup-token", nil }
	result, err := Setup(context.Background(), options)
	if err != nil || result.Device.Name != "renamed-edge" {
		t.Fatal("refused enrollment blocked a corrected retry", err)
	}
	// Without a service, setup proves the connection with one real check-in.
	// --service none is the operator's own choice: nothing needs attention.
	// The Next line names this agent's absolute path, never whatever
	// `vectory` PATH finds. (The path is quoted where it needs it: always on
	// Windows, where it has backslashes.)
	if server.heartbeats.Load() != 1 || stepStatus(result, "checkin") != "ok" || stepStatus(result, "service") != "" || result.NeedsAttention || !strings.Contains(result.Next, " run --state-dir "+quoteArg(dir)) || !filepath.IsAbs(strings.Trim(strings.Fields(strings.TrimPrefix(result.Next, "Keep the agent running under your supervisor: "))[0], "'")) {
		t.Fatalf("check-in not performed: %+v %q", result.Steps, result.Next)
	}
	if state, _ := LoadState(dir); state.LastHeartbeat == nil || state.DeviceID == "" {
		t.Fatal("check-in not recorded")
	}
	if pending, _ := ReadPendingEnrollment(dir); pending == nil || pending.Name != "renamed-edge" {
		t.Fatal("pending record not rebound", pending)
	}
}

// Ctrl-C during the check-in stops setup with an explanation, and a check-in
// cut short by stopping is not recorded as an outage.
func TestSetupInterruptedDuringTheCheckInIsNotAnOutage(t *testing.T) {
	server := newSetupServer(t)
	defer close(server.release)
	server.hold.Store(true)
	options, dir, _ := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	options.Token = func() (string, error) { return "synthetic-setup-token", nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type outcome struct {
		result SetupResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := Setup(ctx, options)
		done <- outcome{result, err}
	}()
	for deadline := time.Now().Add(10 * time.Second); server.heartbeats.Load() == 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("setup never checked in")
		}
	}
	cancel()
	var got outcome
	select {
	case got = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("setup didn't stop after the interruption")
	}
	last := got.result.Steps[len(got.result.Steps)-1]
	if got.err == nil || got.result.OK || last.Status != "warn" || last.Label != "Check-in" || last.Detail != "Interrupted before the first check-in." {
		t.Fatalf("err %v, steps %+v", got.err, got.result.Steps)
	}
	if state, err := LoadState(dir); err != nil || state.CheckInFailure != nil || state.LastHeartbeat != nil {
		t.Fatalf("an interrupted check-in was recorded: %+v %v", state.CheckInFailure, err)
	}
}

func TestPackagedAgentsRunInPlace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX locations")
	}
	for exe, want := range map[string]bool{"/usr/bin/vectory": true, "/usr/local/bin/vectory": true, "/usr/local/bin/../bin/vectory": true, "/tmp/vectory": false, "/home/ops/Downloads/vectory": false} {
		if got := packagedLocation(exe, "/usr/local/bin/vectory"); got != want {
			t.Fatalf("%s: %v", exe, got)
		}
	}
}

func TestSanitizedDeviceNamesAreValid(t *testing.T) {
	for host, want := range map[string]string{"WEB_01.local": "web_01", "My Mac Book": "my-mac-book", "--edge--": "edge--", "": "device", "db01.prod.example.com": "db01.prod.example.com"} {
		got := sanitizeDeviceName(host)
		if got != want || ValidateDeviceName(got) != nil {
			t.Fatalf("%q -> %q, want %q", host, got, want)
		}
	}
}
