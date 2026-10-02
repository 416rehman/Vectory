package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// The fixture of the tests of checks on request: a control plane that signs a
// manifest for every heartbeat (with a validation request when the test sets
// one) and records what each heartbeat said, a stand-in for Vector that records
// what it is asked to check, and a device whose state and managed
// configuration live in separate directories, as installed ones do.

const (
	checkID  = "6f1d2c3b-4a59-4e8f-9b07-1c2d3e4f5a6b"
	checkID2 = "0b8e7d6c-5a4f-4b3e-8d2c-9a8b7c6d5e4f"
)

type checkPlane struct {
	*httptest.Server
	t        *testing.T
	key      ed25519.PrivateKey
	mu       sync.Mutex
	manifest Manifest
	// artifacts are served by path.
	artifacts map[string][]byte
	bodies    [][]byte
	beats     []map[string]any
	fetched   []string
	// answer lets a test refuse a heartbeat: a status other than 0 is sent
	// instead of the manifest.
	answer func(beat map[string]any) int
	// artifactStatus, when not 0, answers every artifact request with it.
	artifactStatus int
}

func newCheckPlane(t *testing.T, m Manifest, key ed25519.PrivateKey) *checkPlane {
	t.Helper()
	p := &checkPlane{t: t, key: key, manifest: m, artifacts: map[string][]byte{}}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	t.Cleanup(p.Close)
	return p
}

func (p *checkPlane) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/agent/v1/heartbeat":
		body, _ := io.ReadAll(r.Body)
		var beat map[string]any
		_ = json.Unmarshal(body, &beat)
		p.mu.Lock()
		p.bodies, p.beats = append(p.bodies, body), append(p.beats, beat)
		answer, m := p.answer, p.manifest
		p.mu.Unlock()
		if answer != nil {
			if status := answer(beat); status != 0 {
				http.Error(w, `{"error":{"code":"INVALID_INPUT","message":"Invalid input"}}`, status)
				return
			}
		}
		m.Nonce, _ = beat["nonce"].(string)
		m.IssuedAt = time.Now().UTC()
		m.ExpiresAt = m.IssuedAt.Add(5 * time.Minute)
		_ = json.NewEncoder(w).Encode(signed(p.t, m, p.key))
	case strings.HasPrefix(r.URL.Path, "/agent/v1/artifacts/"):
		p.mu.Lock()
		p.fetched = append(p.fetched, r.URL.Path)
		status := p.artifactStatus
		data, ok := p.artifacts[r.URL.Path]
		p.mu.Unlock()
		switch {
		case status != 0:
			http.Error(w, "refused", status)
		case !ok:
			http.NotFound(w, r)
		default:
			_, _ = w.Write(data)
		}
	default:
		http.NotFound(w, r)
	}
}

// with changes the manifest the next heartbeats get.
func (p *checkPlane) with(change func(*Manifest)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	change(&p.manifest)
}

func (p *checkPlane) offer(path string, data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.artifacts[path] = data
}

func (p *checkPlane) sent() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.beats...)
}

func (p *checkPlane) rawBodies() [][]byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([][]byte(nil), p.bodies...)
}

func (p *checkPlane) downloads() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.fetched...)
}

// last is the newest heartbeat the plane received.
func (p *checkPlane) last() map[string]any {
	beats := p.sent()
	if len(beats) == 0 {
		p.t.Fatal("no heartbeat reached the server")
	}
	return beats[len(beats)-1]
}

// checkedCandidate is what the stand-in was asked to check, and what it saw.
type checkedCandidate struct {
	Path     string
	Content  []byte
	FileMode os.FileMode
	DirMode  os.FileMode
	RunTests bool
}

// candidateDriver stands in for Vector in checks on request: it records what
// it is asked to check, and answers as a test says. The apply path's
// activations are counted by the embedded fake.
type candidateDriver struct {
	*fakeDriver
	mu      sync.Mutex
	checked []checkedCandidate
	// answer says how a check ends; nil means it passes.
	answer func(checkedCandidate) (candidateRun, error)
}

func (d *candidateDriver) CheckCandidate(_ context.Context, path string, runTests bool) (candidateRun, error) {
	c := checkedCandidate{Path: path, RunTests: runTests}
	c.Content, _ = os.ReadFile(path)
	if info, err := os.Stat(path); err == nil {
		c.FileMode = info.Mode().Perm()
	}
	if info, err := os.Stat(filepath.Dir(path)); err == nil {
		c.DirMode = info.Mode().Perm()
	}
	d.mu.Lock()
	d.checked = append(d.checked, c)
	answer := d.answer
	d.mu.Unlock()
	if answer != nil {
		return answer(c)
	}
	return candidateRun{}, nil
}

func (d *candidateDriver) checks() []checkedCandidate {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]checkedCandidate(nil), d.checked...)
}

func (d *candidateDriver) respond(answer func(checkedCandidate) (candidateRun, error)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.answer = answer
}

type checkDevice struct {
	t       *testing.T
	e       *Engine
	plane   *checkPlane
	driver  *candidateDriver
	root    string
	state   string
	managed string
}

// newCheckDevice is a device running oldConfig, verified, that is offered that
// same version: its check-ins change nothing, so what a test sees is the
// check and nothing else. The server lists "validation" among its features.
func newCheckDevice(t *testing.T) *checkDevice {
	t.Helper()
	root := privateTempDir(t)
	state, managedDir := filepath.Join(root, "state"), filepath.Join(root, "managed")
	if err := PrivateDir(state); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(managedDir, 0700); err != nil {
		t.Fatal(err)
	}
	managed := filepath.Join(managedDir, "vector.json")
	for path, data := range map[string][]byte{managed: oldConfig, filepath.Join(state, "good-"+Digest(oldConfig)+".json"): oldConfig} {
		if err := AtomicWrite(path, data); err != nil {
			t.Fatal(err)
		}
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	desired := &Desired{VersionID: "v1", SHA256: Digest(oldConfig), Size: int64(len(oldConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(oldConfig), VectorVersion: VectorVersion}
	m := Manifest{ProtocolVersion: 1, DeviceID: "device-a", Generation: 2, PolicyGeneration: 3, Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}, Desired: desired, Features: []string{featureValidation}}
	plane := newCheckPlane(t, m, key)
	plane.offer(desired.ArtifactPath, oldConfig)
	driver := &candidateDriver{fakeDriver: &fakeDriver{alive: true}}
	st := State{Accepted: true, HighestGeneration: 2, HighestPolicyGeneration: 3, DesiredIdentity: Identity(desired), PolicyIdentity: Identity(m.Policy), Desired: desired, Policy: m.Policy,
		LastGoodSHA256: Digest(oldConfig), ReportedGeneration: 2, ApplyState: "verified_applied", ServerFeatures: []string{featureValidation}}
	e := &Engine{Dir: state, Settings: Settings{ManagedConfig: managed, Adopted: true}, State: st, Driver: driver, Client: &Client{HTTP: plane.Client(), Base: plane.URL},
		Credentials: Credentials{DeviceID: "device-a", SigningPublicKey: base64.StdEncoding.EncodeToString(pub)}}
	if err = e.save(); err != nil {
		t.Fatal(err)
	}
	return &checkDevice{t: t, e: e, plane: plane, driver: driver, root: root, state: state, managed: managed}
}

// request is a request to check data, open for ten minutes.
func (d *checkDevice) request(data []byte, id string, runTests bool) ValidationRequest {
	sha := Digest(data)
	return ValidationRequest{ID: id, SHA256: sha, Size: int64(len(data)), ArtifactPath: "/agent/v1/artifacts/" + sha, RunTests: runTests, ExpiresAt: time.Now().UTC().Add(10 * time.Minute).Truncate(time.Second)}
}

// ask publishes data as a candidate and has the manifest carry the request.
func (d *checkDevice) ask(data []byte, id string, runTests bool) ValidationRequest {
	d.t.Helper()
	req := d.request(data, id, runTests)
	d.plane.offer(req.ArtifactPath, data)
	d.carry(req)
	return req
}

// carry has the manifest carry the request.
func (d *checkDevice) carry(req ValidationRequest) {
	d.t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		d.t.Fatal(err)
	}
	d.plane.with(func(m *Manifest) { m.Validation = raw })
}

// forget has the manifest stop carrying a request.
func (d *checkDevice) forget() { d.plane.with(func(m *Manifest) { m.Validation = nil }) }

func (d *checkDevice) poll() {
	d.t.Helper()
	if err := d.e.Poll(context.Background()); err != nil {
		d.t.Fatal(err)
	}
}

// staging lists what the check's staging directory holds.
func (d *checkDevice) staging() []string {
	d.t.Helper()
	entries, err := os.ReadDir(filepath.Join(d.state, validationStagingName))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		d.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// snapshot is what a check must leave as it found it: the managed file, the
// recovery journal, every last known good, and the generations, desired
// version and verified outcome in the state, in memory and on disk.
func (d *checkDevice) snapshot() map[string]string {
	d.t.Helper()
	out := map[string]string{}
	digest := func(label, path string) {
		switch data, err := os.ReadFile(path); {
		case os.IsNotExist(err):
			out[label] = "absent"
		case err != nil:
			d.t.Fatal(err)
		default:
			out[label] = Digest(data)
		}
	}
	digest("managed", d.managed)
	digest("journal", filepath.Join(d.state, "journal.json"))
	goods, _ := filepath.Glob(filepath.Join(d.state, "good-*.json"))
	sort.Strings(goods)
	for _, path := range goods {
		digest(filepath.Base(path), path)
	}
	stateSummary := func(s State) string {
		return fmt.Sprintf("highest=%d policy=%d reported=%d lastgood=%s apply=%s identity=%s failed=%v attempt=%+v desired=%+v", s.HighestGeneration, s.HighestPolicyGeneration, s.ReportedGeneration, s.LastGoodSHA256, s.ApplyState, s.DesiredIdentity, s.FailedGeneration, s.ConfigurationAttempt, s.Desired)
	}
	out["memory"] = stateSummary(d.e.State)
	if durable, err := LoadState(d.state); err == nil {
		out["durable"] = stateSummary(durable)
	} else {
		d.t.Fatal(err)
	}
	return out
}

// result is the validation_result of a heartbeat, or nil.
func result(beat map[string]any) map[string]any {
	r, _ := beat["validation_result"].(map[string]any)
	return r
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// requireNoSecrets fails when any heartbeat the plane received holds one of
// the values, in any of the encodings a heartbeat could carry it in.
func requireNoSecrets(t *testing.T, plane *checkPlane, values ...string) {
	t.Helper()
	for _, body := range plane.rawBodies() {
		for _, value := range values {
			encoded, _ := json.Marshal(value)
			for _, form := range [][]byte{[]byte(value), bytes.Trim(encoded, `"`), []byte(base64.StdEncoding.EncodeToString([]byte(value)))} {
				if bytes.Contains(body, form) {
					t.Fatalf("a heartbeat carries %q:\n%s", value, body)
				}
			}
		}
	}
}
