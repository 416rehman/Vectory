package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeDriver struct {
	alive       bool
	starts      int
	failNext    bool
	validateErr bool
}

func (d *fakeDriver) Validate(context.Context, string) error {
	if d.validateErr {
		return errors.New("validation rejected")
	}
	return nil
}
func (d *fakeDriver) Activate(context.Context, string) error {
	d.starts++
	if d.failNext {
		d.failNext = false
		return errors.New("startup failed")
	}
	d.alive = true
	return nil
}
func (d *fakeDriver) Alive() bool { return d.alive }
func (d *fakeDriver) Stop() error { d.alive = false; return nil }

var oldConfig = []byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"sinks":{"discard":{"type":"blackhole","inputs":["synthetic"]}}}`)
var newConfig = []byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json","interval":2}},"sinks":{"discard":{"type":"blackhole","inputs":["synthetic"]}}}`)

func fixture(t *testing.T, data []byte) (*Engine, Manifest, *fakeDriver) {
	t.Helper()
	dir := t.TempDir()
	config := filepath.Join(dir, "managed.json")
	if err := AtomicWrite(config, oldConfig); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(dir, "good-"+Digest(oldConfig)+".json"), oldConfig); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/artifacts/"+Digest(data) {
			http.Error(w, "denied", 403)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	driver := &fakeDriver{alive: true}
	m := sampleManifest()
	m.Desired = &Desired{VersionID: "v2", SHA256: Digest(data), Size: int64(len(data)), ArtifactPath: "/agent/v1/artifacts/" + Digest(data), VectorVersion: VectorVersion}
	st := State{Accepted: true, HighestGeneration: m.Generation, HighestPolicyGeneration: m.PolicyGeneration, DesiredIdentity: Identity(m.Desired), PolicyIdentity: Identity(m.Policy), Desired: m.Desired, Policy: m.Policy, LastGoodSHA256: Digest(oldConfig), ReportedGeneration: 1, ApplyState: "verified_applied"}
	e := &Engine{Dir: dir, Settings: Settings{ManagedConfig: config, Adopted: true}, State: st, Driver: driver, Client: &Client{HTTP: srv.Client(), Base: srv.URL}}
	if err := e.save(); err != nil {
		t.Fatal(err)
	}
	return e, m, driver
}
func TestReconcileDriftPauseAndIdempotence(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	ctx := context.Background()
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	if e.State.ApplyState != "verified_applied" || e.State.ReportedGeneration != 2 || d.starts != 1 {
		t.Fatal(e.State, d.starts)
	}
	if err := e.Reconcile(ctx, m); err != nil || d.starts != 1 {
		t.Fatal("unnecessary restart", err)
	}
	if err := AtomicWrite(e.Settings.ManagedConfig, oldConfig); err != nil {
		t.Fatal(err)
	}
	if err := SetPause(e.Dir, true); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	if e.actual() != Digest(oldConfig) || d.starts != 1 {
		t.Fatal("pause mutated configuration")
	}
	if err := SetPause(e.Dir, false); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(ctx, m); err != nil {
		t.Fatal(err)
	}
	if e.actual() != Digest(newConfig) || d.starts != 2 {
		t.Fatal("drift was not repaired")
	}
}
func TestActivationFailureRollback(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if e.State.ApplyState != "rolled_back" || e.actual() != Digest(oldConfig) || d.starts != 2 {
		t.Fatal(e.State, d.starts)
	}
	if err := e.Reconcile(context.Background(), m); err != nil || d.starts != 2 {
		t.Fatal("rejected generation retried", err)
	}
}
func TestInvalidConfigNeverWrites(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.validateErr = true
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("validation failure hidden")
	}
	if e.actual() != Digest(oldConfig) || d.starts != 0 {
		t.Fatal("invalid content committed")
	}
}
func TestCrashBoundariesRecoverCompleteGood(t *testing.T) {
	for _, stage := range []string{"validated", "prepared", "written", "reload_requested", "activated", "verified"} {
		t.Run(stage, func(t *testing.T) {
			e, m, _ := fixture(t, newConfig)
			e.Fault = func(at string) error {
				if at == stage {
					return errors.New("simulated power loss")
				}
				return nil
			}
			if err := e.Reconcile(context.Background(), m); err == nil {
				t.Fatal("fault did not fire")
			}
			st, err := LoadState(e.Dir)
			if err != nil {
				t.Fatal(err)
			}
			recovered := &Engine{Dir: e.Dir, Settings: e.Settings, State: st, Driver: &fakeDriver{}}
			if err = recovered.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			if stage == "verified" {
				if recovered.actual() != Digest(newConfig) {
					t.Fatal("durable verified config was rolled back")
				}
			} else if recovered.actual() != Digest(oldConfig) {
				t.Fatal("incomplete configuration after recovery")
			}
		})
	}
}
func TestPauseRacesValidation(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	e.Fault = func(stage string) error {
		if stage == "validated" {
			return SetPause(e.Dir, true)
		}
		return nil
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if d.starts != 0 || e.actual() != Digest(oldConfig) || e.State.ApplyState != "paused" {
		t.Fatal("pause race lost")
	}
}
func TestExpiredManifestDoesNotWrite(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	m.ExpiresAt = time.Now().Add(-time.Minute)
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("expired commit allowed")
	}
	if d.starts != 0 || e.actual() != Digest(oldConfig) {
		t.Fatal("expired config committed")
	}
}
func TestGoodNeverReplacedWithDrift(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	if err := AtomicWrite(e.Settings.ManagedConfig, []byte(`{"local":"drift"}`)); err != nil {
		t.Fatal(err)
	}
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if e.actual() != Digest(oldConfig) {
		t.Fatal("rollback promoted local drift")
	}
}
func TestOfflineRestartRestoresGoodButPausePreservesManualContent(t *testing.T) {
	for _, paused := range []bool{false, true} {
		t.Run(fmt.Sprint(paused), func(t *testing.T) {
			e, _, d := fixture(t, newConfig)
			d.alive = false
			if err := AtomicWrite(e.Settings.ManagedConfig, newConfig); err != nil {
				t.Fatal(err)
			}
			if paused {
				if err := SetPause(e.Dir, true); err != nil {
					t.Fatal(err)
				}
			}
			if err := e.StartExisting(context.Background()); err != nil {
				t.Fatal(err)
			}
			expected := Digest(oldConfig)
			if paused {
				expected = Digest(newConfig)
			}
			if e.actual() != expected {
				t.Fatal("offline recovery violated pause/last-good boundary")
			}
			if !d.Alive() {
				t.Fatal("local workload did not start")
			}
			if e.State.LastGoodSHA256 != Digest(oldConfig) {
				t.Fatal("manual content became last good")
			}
		})
	}
}
func TestRollbackFailureCanBeReported(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	if err := os.Remove(e.goodPath()); err != nil {
		t.Fatal(err)
	}
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("missing rollback error")
	}
	if e.State.Error == nil || e.State.Error.Code != "ROLLBACK_FAILED" || e.State.ApplyState != "failed" {
		t.Fatal("rollback failure not durable")
	}
	if _, err := os.Stat(filepath.Join(e.Dir, "journal.json")); err != nil {
		t.Fatal("recovery journal discarded")
	}
}
func TestNativeVectorActivationAndRollback(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY to verified Vector 0.58.0 for native integration")
	}
	dataDir := t.TempDir()
	withDataDir := func(raw []byte) []byte {
		var v map[string]any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		v["data_dir"] = dataDir
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	nativeConfig := withDataDir(newConfig)
	e, m, _ := fixture(t, nativeConfig)
	e.Settings.CapabilityPolicy.AllowedFileRoots = []string{dataDir}
	e.Settings.VectorBinary = binary
	h, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	e.Settings.VectorBinarySHA256 = h
	e.Settings.ValidationSeconds = 30
	e.Settings.StartupSeconds = 20
	driver := &VectorDriver{Settings: e.Settings}
	e.Driver = driver
	defer driver.Stop()
	probePath := filepath.Join(e.Dir, "probe.json")
	if err = AtomicWrite(probePath, nativeConfig); err != nil {
		t.Fatal(err)
	}
	if err = driver.Validate(context.Background(), probePath); err != nil {
		t.Fatal(err)
	}
	if err = driver.Activate(context.Background(), probePath); err != nil {
		t.Fatal("direct native startup:", err)
	}
	if err = driver.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err = ProbeVector(context.Background(), e.Settings); err != nil {
		t.Fatal(err)
	}
	if err = e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if !driver.Alive() || e.State.ApplyState != "verified_applied" {
		t.Fatal("actual Vector not verified")
	}
	if err = AtomicWrite(e.Settings.ManagedConfig, oldConfig); err != nil {
		t.Fatal(err)
	}
	if err = e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if e.actual() != Digest(nativeConfig) || !driver.Alive() {
		t.Fatal("native drift repair failed")
	}
	// A finite source starts successfully but exits before the liveness window.
	exits := withDataDir([]byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json","count":1,"interval":0.001}},"sinks":{"discard":{"type":"blackhole","inputs":["synthetic"]}}}`))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(exits) }))
	defer srv.Close()
	e.Client = &Client{HTTP: srv.Client(), Base: srv.URL}
	m.Generation = 3
	m.Desired = &Desired{VersionID: "finite", SHA256: Digest(exits), Size: int64(len(exits)), ArtifactPath: "/agent/v1/artifacts/" + Digest(exits), VectorVersion: VectorVersion}
	e.State.HighestGeneration = 3
	e.State.Desired = m.Desired
	if err = e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if e.State.ApplyState != "rolled_back" || e.actual() != Digest(nativeConfig) || !driver.Alive() {
		t.Fatalf("native failed activation not rolled back: %+v", e.State)
	}
}
