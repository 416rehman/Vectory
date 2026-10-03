package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

// A pipeline may name a component with any letters Vector accepts, and Vector
// logs about it by that name. These tests run the real Vector on such a
// pipeline, let it log an error for every event, and check in: the device must
// keep checking in. The control plane here refuses what the server refuses.

type nonASCIIDevice struct {
	e      *Engine
	driver *VectorDriver
	plane  *checkPlane
	config []byte
}

// newNonASCIIDevice runs a restricted-mode pipeline whose remap is named id and
// fails on every event (`parse_json!` of a syslog line), until Vector has logged
// about it.
func newNonASCIIDevice(t *testing.T, id string) *nonASCIIDevice {
	t.Helper()
	e, driver := nativeRuntimeFixture(t)
	restricted := CapabilityPolicy{}
	e.Settings.CapabilityPolicy, driver.Settings.CapabilityPolicy = restricted, restricted
	config := writeManaged(t, e.Settings.ManagedConfig, map[string]any{
		"sources": map[string]any{"app": map[string]any{"type": "demo_logs", "format": "syslog", "interval": 0.2}},
		"transforms": map[string]any{id: map[string]any{
			"type": "remap", "inputs": []string{"app"}, "drop_on_error": true, "source": ". = parse_json!(.message)",
		}},
		"sinks": map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{id}}},
	})
	if err := restricted.Check(config); err != nil {
		t.Fatalf("restricted mode refused the pipeline: %v", err)
	}
	ctx := context.Background()
	if err := driver.Validate(ctx, e.Settings.ManagedConfig); err != nil {
		t.Fatalf("vector validate: %v %+v", err, e.diagnoseFailure(err, config))
	}
	if err := driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		t.Fatalf("activation: %v %+v", err, e.diagnoseFailure(err, config))
	}

	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	desired := &Desired{VersionID: "v1", SHA256: Digest(config), Size: int64(len(config)), ArtifactPath: "/agent/v1/artifacts/" + Digest(config), VectorVersion: VectorVersion}
	features := []string{featureLogSummary, featureHostRuntime, featureStateDir, featureDiagnostics}
	m := Manifest{ProtocolVersion: 1, DeviceID: "device-a", Generation: 2, PolicyGeneration: 3, Policy: Policy{HeartbeatSeconds: 60}, Desired: desired, Features: features}
	plane := newCheckPlane(t, m, key)
	plane.offer(desired.ArtifactPath, config)
	e.State = State{Accepted: true, HighestGeneration: 2, HighestPolicyGeneration: 3, DesiredIdentity: Identity(desired), PolicyIdentity: Identity(m.Policy),
		Desired: desired, Policy: m.Policy, LastGoodSHA256: Digest(config), ReportedGeneration: 2, ApplyState: "verified_applied", ServerFeatures: features}
	e.Client = &Client{HTTP: plane.Client(), Base: plane.URL}
	e.Credentials = Credentials{DeviceID: "device-a", SigningPublicKey: base64.StdEncoding.EncodeToString(pub)}
	if err = AtomicWrite(filepath.Join(e.Dir, "good-"+Digest(config)+".json"), config); err != nil {
		t.Fatal(err)
	}
	if err = e.save(); err != nil {
		t.Fatal(err)
	}

	// Vector has logged an error for the component once its summary names it.
	deadline := time.Now().Add(30 * time.Second)
	for {
		for _, group := range e.Log.summaries(e.redactorFor(config)) {
			if group.ComponentID == id {
				return &nonASCIIDevice{e: e, driver: driver, plane: plane, config: config}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("Vector never logged an error that names %q; the log:\n%v", id, e.Log.recent())
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// refuseIDs has the plane refuse a heartbeat whose log groups or diagnostics
// name a component with an ID the rule does not accept.
func (d *nonASCIIDevice) refuseIDs(accepts func(id string) bool) {
	d.plane.mu.Lock()
	defer d.plane.mu.Unlock()
	d.plane.answer = func(beat map[string]any) int {
		groups, _ := beat["vector_log_summary"].([]any)
		for _, g := range groups {
			group, _ := g.(map[string]any)
			if id, named := group["component_id"].(string); named && !accepts(id) {
				return http.StatusBadRequest
			}
		}
		return 0
	}
}

func (d *nonASCIIDevice) reportedIDs(t *testing.T, beat map[string]any) []string {
	t.Helper()
	var ids []string
	groups, _ := beat["vector_log_summary"].([]any)
	for _, g := range groups {
		group, _ := g.(map[string]any)
		if id, named := group["component_id"].(string); named {
			ids = append(ids, id)
		}
	}
	return ids
}

func TestNativeAComponentWithANonASCIINameThatLogsAnErrorIsReportedAndTheDeviceKeepsCheckingIn(t *testing.T) {
	for _, id := range []string{"café", "日志", "٣"} {
		t.Run(id, func(t *testing.T) {
			d := newNonASCIIDevice(t, id)
			d.refuseIDs(reportableID)
			if err := d.e.Poll(context.Background()); err != nil {
				t.Fatalf("the check-in failed: %v", err)
			}
			beats := d.plane.sent()
			if len(beats) != 1 {
				t.Fatalf("%d requests, want the one the server accepts", len(beats))
			}
			if ids := d.reportedIDs(t, beats[0]); len(ids) == 0 || ids[0] != id {
				t.Fatalf("the log group doesn't name %q: %v", id, ids)
			}
			if d.e.State.CheckInFailure != nil || d.e.State.LastHeartbeat == nil || !d.driver.Alive() {
				t.Fatalf("the device is off the control plane or Vector stopped: %+v", d.e.State.CheckInFailure)
			}
		})
	}
}

// A server from before the rule changed refuses such an ID, and the device still
// checks in: the log summary is the only thing left out, and the agent says so.
func TestNativeAnOlderServerThatRefusesTheIDStillGetsTheCheckIn(t *testing.T) {
	d := newNonASCIIDevice(t, "café")
	d.refuseIDs(func(id string) bool {
		for _, b := range []byte(id) {
			if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b == '_' || b == '.' || b == '-') {
				return false
			}
		}
		return true
	})
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	for i := 0; i < 2; i++ {
		if err := d.e.Poll(context.Background()); err != nil {
			t.Fatalf("check-in %d failed: %v", i+1, err)
		}
	}
	beats := d.plane.sent()
	if len(beats) != 4 {
		t.Fatalf("%d requests, want two for each check-in", len(beats))
	}
	for i, beat := range beats {
		if withSummary := len(d.reportedIDs(t, beat)) > 0; withSummary != (i%2 == 0) {
			t.Fatalf("request %d: the summary is there: %v", i+1, withSummary)
		}
		if beat["state_dir"] == nil || beat["host_runtime"] == nil {
			t.Fatalf("request %d lost a report that nothing refused: %v", i+1, carries(beat))
		}
	}
	if len(said) != 1 || said[0] != "The server refused a check-in; the agent sent it again without the Vector log summary." {
		t.Fatalf("the log said %q", said)
	}
	if d.e.State.CheckInFailure != nil || !d.driver.Alive() {
		t.Fatalf("the device is off the control plane: %+v", d.e.State.CheckInFailure)
	}
}
