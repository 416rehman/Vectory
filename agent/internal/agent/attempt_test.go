package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// This fixture exercises the real Poll encoder and signed manifest acceptance.
// The HTTP transport is test-local; separate TLS tests cover client authentication.
func attemptPollFixture(t *testing.T, e *Engine, manifest *Manifest, artifact *[]byte) *[]map[string]any {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.Credentials = Credentials{DeviceID: manifest.DeviceID, SigningPublicKey: base64.StdEncoding.EncodeToString(pub)}
	var received []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent/v1/heartbeat" {
			var h map[string]any
			if err := json.NewDecoder(r.Body).Decode(&h); err != nil {
				t.Error(err)
				return
			}
			received = append(received, h)
			m := *manifest
			m.Nonce = h["nonce"].(string)
			m.IssuedAt = time.Now().UTC()
			m.ExpiresAt = m.IssuedAt.Add(5 * time.Minute)
			_ = json.NewEncoder(w).Encode(signed(t, m, key))
			return
		}
		if manifest.Desired != nil && r.URL.Path == manifest.Desired.ArtifactPath {
			_, _ = w.Write(*artifact)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	e.Client = &Client{HTTP: srv.Client(), Base: srv.URL}
	return &received
}

func requireAttempt(t *testing.T, e *Engine, m Manifest, state, code string) {
	t.Helper()
	a := e.State.ConfigurationAttempt
	if a == nil || a.Generation != m.Generation || a.VersionID != m.Desired.VersionID || a.SHA256 != m.Desired.SHA256 || a.State != state || a.SecretRevision != e.State.SecretRevision {
		t.Fatalf("incorrect attempt: %+v", a)
	}
	if code == "" && a.Error != nil || code != "" && (a.Error == nil || a.Error.Code != code) {
		t.Fatalf("incorrect attempt error: %+v", a.Error)
	}
	durable, err := LoadState(e.Dir)
	if err != nil || !reflect.DeepEqual(durable.ConfigurationAttempt, a) {
		t.Fatal("attempt result not durable", err)
	}
}

func TestConfigurationAttemptEarlyFailures(t *testing.T) {
	for _, test := range []struct {
		name, code string
		data       []byte
		setup      func(*Engine, *Manifest, *fakeDriver)
	}{
		{"compatibility", "INCOMPATIBLE", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) { m.Desired.VectorVersion = "0.0.0" }},
		{"adoption", "ADOPTION_REQUIRED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) { e.Settings.Adopted = false }},
		{"download", "DOWNLOAD_FAILED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) { m.Desired.ArtifactPath += "-denied" }},
		{"secret", "SECRET_RESOLUTION_FAILED", secretTemplate("https://example.test/events"), nil},
		{"capability", "CAPABILITY_DENIED", []byte(`{"sources":{"execute":{"type":"exec","command":["echo","no"]}}}`), nil},
		{"validation", "VALIDATION_FAILED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) { d.validateErr = true }},
		{"staging", "WRITE_FAILED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) {
			e.Settings.ManagedConfig = filepath.Join(e.Settings.ManagedConfig, "child.json")
		}},
		{"managed-read", "PATH_UNSAFE", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) { e.Settings.ManagedConfig = e.Dir }},
		{"backup-write", "WRITE_FAILED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) {
			if err := os.Mkdir(filepath.Join(e.Dir, "pre-attempt.json"), 0700); err != nil {
				t.Fatal(err)
			}
		}},
		{"journal-write", "WRITE_FAILED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) {
			if err := os.Mkdir(filepath.Join(e.Dir, "journal.json"), 0700); err != nil {
				t.Fatal(err)
			}
		}},
		{"authorization-expired", "MANIFEST_EXPIRED", newConfig, func(e *Engine, m *Manifest, d *fakeDriver) { m.ExpiresAt = time.Now().Add(-time.Minute) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			e, m, d := fixture(t, test.data)
			if test.setup != nil {
				test.setup(e, &m, d)
			}
			if err := e.Reconcile(context.Background(), m); err == nil {
				t.Fatal("candidate failure not surfaced")
			}
			requireAttempt(t, e, m, "failed", test.code)
			if e.State.ReportedGeneration != 1 || e.State.LastGoodSHA256 != Digest(oldConfig) || d.starts != 0 {
				t.Fatal("failure advanced verified workload")
			}
		})
	}
}

func TestConfigurationAttemptSignedRetryAndUnassignment(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	m.Desired.VersionID = "00000000-0000-4000-8000-000000000002"
	e.State.DesiredIdentity = Identity(m.Desired)
	artifact := newConfig
	heartbeats := attemptPollFixture(t, e, &m, &artifact)
	d.validateErr = true
	if err := e.Poll(context.Background()); err == nil {
		t.Fatal("validation passed")
	}
	requireAttempt(t, e, m, "failed", "VALIDATION_FAILED")
	oldAttempt := cloneAttempt(e.State.ConfigurationAttempt)
	// A policy-only heartbeat must not rebind or erase candidate failure.
	m.PolicyGeneration++
	m.Policy.TelemetryEnabled = false
	if err := e.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(oldAttempt, e.State.ConfigurationAttempt) {
		t.Fatal("policy change erased candidate evidence")
	}
	// Server-authorized retry uses a new generation. At the durable acceptance
	// boundary the old failure has already gone, even if the process crashes.
	m.Generation++
	e.Fault = func(stage string) error {
		if stage == "accepted" {
			return errors.New("accepted crash")
		}
		return nil
	}
	if err := e.Poll(context.Background()); err == nil {
		t.Fatal("fault did not fire")
	}
	requireAttempt(t, e, m, "desired", "")
	if e.State.Error != nil || e.State.FailedGeneration != nil || e.State.ReportedGeneration != 1 {
		t.Fatal("retry inherited old failure or verification")
	}
	durable, err := LoadState(e.Dir)
	if err != nil {
		t.Fatal(err)
	}
	e.State = durable
	e.Fault = nil
	d.validateErr = false
	if err := e.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if last := (*heartbeats)[len(*heartbeats)-1]; last["apply_state"] != "desired" || last["error"] != nil {
		t.Fatal("stale error sent after retry acceptance")
	}
	requireAttempt(t, e, m, "verified_applied", "")
	if e.State.ReportedGeneration != m.Generation {
		t.Fatal("successful retry not verified")
	}
	m.Generation++
	m.Desired = nil
	if err = e.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.State.ConfigurationAttempt != nil || e.State.Error != nil || !d.Alive() {
		t.Fatal("unassignment retained attempt or stopped workload")
	}
	if err = e.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if last := (*heartbeats)[len(*heartbeats)-1]; last["configuration_attempt"] != nil || last["error"] != nil {
		t.Fatal("unassigned heartbeat leaked old attempt")
	}
}

func TestConfigurationAttemptPauseAndStartupIsolation(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.validateErr = true
	_ = e.Reconcile(context.Background(), m)
	original := cloneAttempt(e.State.ConfigurationAttempt)
	if err := SetPause(e.Dir, true); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, e.State.ConfigurationAttempt) {
		t.Fatal("pause erased completed attempt")
	}
	if err := SetPause(e.Dir, false); err != nil {
		t.Fatal(err)
	}
	// The old workload fails startup with a different issue. Do not attribute it
	// to the newer candidate; its independently snapshotted error is unchanged.
	d.alive = false
	if err := e.StartExisting(context.Background()); err == nil {
		t.Fatal("startup unexpectedly passed")
	}
	if e.State.Error.Stage != "startup" || !reflect.DeepEqual(original, e.State.ConfigurationAttempt) {
		t.Fatal("startup replaced candidate error")
	}
	d.validateErr = false
	if err := e.StartExisting(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "failed", "VALIDATION_FAILED")
	if e.State.Error.Stage != "validation" {
		t.Fatal("suppressed retry retained unrelated startup error")
	}
	// A newly accepted candidate that is paused never claims work was performed.
	m.Generation++
	e.State.HighestGeneration = m.Generation
	if err := SetPause(e.Dir, true); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "paused", "")
}

func TestConfigurationAttemptObservationOfVerifiedProcess(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	d.alive = false
	d.validateErr = true
	if err := e.StartExisting(context.Background()); err == nil {
		t.Fatal("startup unexpectedly passed")
	}
	requireAttempt(t, e, m, "verification_unknown", "VALIDATION_FAILED")
	d.validateErr = false
	if err := e.StartExisting(context.Background()); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "verified_applied", "")
}

func TestConfigurationAttemptJournalRecovery(t *testing.T) {
	for _, stage := range []string{"validated", "prepared", "written", "reload_requested", "activated", "verified"} {
		t.Run(stage, func(t *testing.T) {
			e, m, _ := fixture(t, newConfig)
			e.Fault = func(at string) error {
				if at == stage {
					return errors.New("power loss")
				}
				return nil
			}
			if err := e.Reconcile(context.Background(), m); err == nil {
				t.Fatal("fault missing")
			}
			state, err := LoadState(e.Dir)
			if err != nil {
				t.Fatal(err)
			}
			recovered := &Engine{Dir: e.Dir, Settings: e.Settings, State: state, Driver: &fakeDriver{}}
			if err = recovered.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err = recovered.StartExisting(context.Background()); err != nil {
				t.Fatal(err)
			}
			if stage == "verified" {
				requireAttempt(t, recovered, m, "verified_applied", "")
			} else if stage == "validated" {
				requireAttempt(t, recovered, m, "validated", "")
			} else {
				requireAttempt(t, recovered, m, "rolled_back", "APPLY_ROLLED_BACK")
			}
		})
	}
}

func TestConfigurationAttemptStaleAndLegacyJournalDoNotRebind(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "older authenticated journal", true: "legacy no identity"}[legacy], func(t *testing.T) {
			e, m, _ := fixture(t, newConfig)
			e.Fault = func(at string) error {
				if at == "written" {
					return errors.New("power loss")
				}
				return nil
			}
			_ = e.Reconcile(context.Background(), m)
			var j Journal
			if err := ReadJSON(filepath.Join(e.Dir, "journal.json"), &j); err != nil {
				t.Fatal(err)
			}
			if legacy {
				j.ConfigurationAttempt = nil
				if err := WriteJSON(filepath.Join(e.Dir, "journal.json"), j); err != nil {
					t.Fatal(err)
				}
			}
			m.Generation++
			e.State.HighestGeneration = m.Generation
			e.selectAttempt(m)
			if err := e.save(); err != nil {
				t.Fatal(err)
			}
			if err := e.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			requireAttempt(t, e, m, "desired", "")
			if e.State.ReportedGeneration != 1 {
				t.Fatal("recovery advanced verified generation")
			}
		})
	}
}

func TestConfigurationAttemptDoesNotInventLegacyFailure(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.validateErr = true
	_ = e.Reconcile(context.Background(), m)
	// Simulate an upgraded legacy state: suppression and generic error exist,
	// but no authenticated attempt record had ever been persisted.
	e.State.ConfigurationAttempt = nil
	if err := e.save(); err != nil {
		t.Fatal(err)
	}
	d.validateErr = false
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "desired", "")
	if d.starts != 0 {
		t.Fatal("upgrade discarded existing retry suppression")
	}
}

func TestConfigurationAttemptSecretRotation(t *testing.T) {
	e, m, d, p := secretFixture(t)
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "verified_applied", "")
	first := e.actual()
	if err := AtomicWrite(p, []byte("second-secret-value")); err != nil {
		t.Fatal(err)
	}
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "rolled_back", "APPLY_ROLLED_BACK")
	if e.State.ConfigurationAttempt.SecretRevision != 2 || e.State.AppliedSecretRevision != 1 || e.actual() != first {
		t.Fatal("failed rotation lost revision distinction")
	}
	if err := AtomicWrite(p, []byte("corrected-secret-value")); err != nil {
		t.Fatal(err)
	}
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	requireAttempt(t, e, m, "verified_applied", "")
	if e.State.ConfigurationAttempt.SecretRevision != 3 || e.State.AppliedSecretRevision != 3 {
		t.Fatal("corrected rotation missing revision")
	}
}

func TestConfigurationAttemptProtocolCounterLimits(t *testing.T) {
	e, m, _, _ := secretFixture(t)
	e.State.SecretRevision = MaxJSONCounter
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("counter overflow permitted")
	}
	requireAttempt(t, e, m, "failed", "SECRET_REVISION_EXHAUSTED")
	if e.State.SecretRevision != MaxJSONCounter {
		t.Fatal("counter changed at limit")
	}
	// Legacy out-of-range state cannot be transmitted or silently truncated.
	e.State.SecretRevision++
	e.Client = nil
	if err := e.Poll(context.Background()); err == nil {
		t.Fatal("unsafe legacy counter sent")
	}
	if e.State.SecretRevision != MaxJSONCounter+1 {
		t.Fatal("unsafe legacy state clipped")
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Manifest){
		func(m *Manifest) { m.Generation = MaxJSONCounter + 1 },
		func(m *Manifest) { m.Generation = 0 },
		func(m *Manifest) { m.PolicyGeneration = MaxJSONCounter + 1 },
	} {
		candidate := sampleManifest()
		mutate(&candidate)
		if _, err := VerifyEnvelope(signed(t, candidate, key), base64.StdEncoding.EncodeToString(pub), candidate.DeviceID, candidate.Nonce, candidate.IssuedAt, State{}); err == nil {
			t.Fatal("signed out-of-range manifest accepted")
		}
	}
}

func TestConfigurationAttemptRejectedSignaturePreservesEvidence(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.validateErr = true
	_ = e.Reconcile(context.Background(), m)
	before := cloneAttempt(e.State.ConfigurationAttempt)
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, untrusted, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e.Credentials = Credentials{DeviceID: m.DeviceID, SigningPublicKey: base64.StdEncoding.EncodeToString(pub)}
	now := time.Now()
	e.State.LastSigningRefresh = &now
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var h Heartbeat
		_ = json.NewDecoder(r.Body).Decode(&h)
		hostile := m
		hostile.Generation++
		hostile.Nonce = h.Nonce
		hostile.Desired = nil
		_ = json.NewEncoder(w).Encode(signed(t, hostile, untrusted))
	}))
	defer srv.Close()
	e.Client = &Client{HTTP: srv.Client(), Base: srv.URL}
	if err := e.Poll(context.Background()); !errors.Is(err, ErrManifestSignature) {
		t.Fatal("untrusted response accepted", err)
	}
	if !reflect.DeepEqual(before, e.State.ConfigurationAttempt) || e.State.HighestGeneration != m.Generation {
		t.Fatal("untrusted response changed outcome")
	}
}

func TestConfigurationAttemptRollbackFailureAndSecretCrash(t *testing.T) {
	t.Run("unavailable rollback", func(t *testing.T) {
		e, m, d := fixture(t, newConfig)
		e.State.LastGoodSHA256 = ""
		d.failNext = true
		if err := e.Reconcile(context.Background(), m); err == nil {
			t.Fatal("missing rollback failure")
		}
		requireAttempt(t, e, m, "failed", "ROLLBACK_UNAVAILABLE")
	})
	t.Run("failed rollback", func(t *testing.T) {
		e, m, d := fixture(t, newConfig)
		if err := os.Remove(e.goodPath()); err != nil {
			t.Fatal(err)
		}
		d.failNext = true
		if err := e.Reconcile(context.Background(), m); err == nil {
			t.Fatal("missing rollback failure")
		}
		requireAttempt(t, e, m, "failed", "ROLLBACK_FAILED")
	})
	t.Run("secret crash after activation", func(t *testing.T) {
		e, m, _, p := secretFixture(t)
		if err := e.Reconcile(context.Background(), m); err != nil {
			t.Fatal(err)
		}
		if err := AtomicWrite(p, []byte("rotated-value")); err != nil {
			t.Fatal(err)
		}
		e.Fault = func(at string) error {
			if at == "activated" {
				return errors.New("power loss")
			}
			return nil
		}
		if err := e.Reconcile(context.Background(), m); err == nil {
			t.Fatal("fault missing")
		}
		st, err := LoadState(e.Dir)
		if err != nil {
			t.Fatal(err)
		}
		e.State = st
		e.Driver = &fakeDriver{}
		if err = e.Recover(context.Background()); err != nil {
			t.Fatal(err)
		}
		requireAttempt(t, e, m, "rolled_back", "APPLY_ROLLED_BACK")
		if e.State.ConfigurationAttempt.SecretRevision != 2 || e.State.AppliedSecretRevision != 1 {
			t.Fatal("recovery lost secret attempt identity")
		}
	})
}

func TestConfigurationAttemptNativeSignedHeartbeat(t *testing.T) {
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for native signed failure reporting")
	}
	dir := t.TempDir()
	withDir := func(raw []byte) []byte {
		var v map[string]any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		v["data_dir"] = dir
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	good := withDir(newConfig)
	e, m, _ := fixture(t, good)
	e.Settings.VectorBinary = binary
	e.Settings.VectorBinarySHA256, _ = FileDigest(binary)
	e.Settings.CapabilityPolicy.AllowedFileRoots = []string{dir}
	e.Settings.ValidationSeconds, e.Settings.StartupSeconds = 30, 20
	driver := &VectorDriver{Settings: e.Settings}
	e.Driver = driver
	t.Cleanup(func() { _ = driver.Stop() })
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	// The following candidate passes local capability checks, but pinned Vector
	// rejects its VRL. The prior process and verified generation must survive.
	bad := withDir([]byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"transforms":{"broken":{"type":"remap","inputs":["synthetic"],"source":"this is invalid vrl"}},"sinks":{"discard":{"type":"blackhole","inputs":["broken"]}}}`))
	m.Generation = 3
	m.Desired = &Desired{VersionID: "00000000-0000-4000-8000-000000000003", SHA256: Digest(bad), Size: int64(len(bad)), ArtifactPath: "/agent/v1/artifacts/" + Digest(bad), VectorVersion: VectorVersion}
	heartbeats := attemptPollFixture(t, e, &m, &bad)
	if err := e.Poll(context.Background()); err == nil {
		t.Fatal("native invalid VRL unexpectedly accepted")
	}
	if e.State.Error == nil || e.State.Error.Code != "VALIDATION_FAILED" || e.State.ReportedGeneration != 2 || !driver.Alive() || e.actual() != Digest(good) {
		t.Fatal("failure did not retain actual verified workload")
	}
	_ = e.Poll(context.Background())
	h := (*heartbeats)[1]
	t.Logf("native result: reported_generation=%v apply_state=%v configuration_attempt=%v", h["reported_generation"], h["apply_state"], h["configuration_attempt"])
	a, ok := h["configuration_attempt"].(map[string]any)
	if !ok || a["generation"] != float64(3) || a["version_id"] != m.Desired.VersionID || a["sha256"] != Digest(bad) || a["state"] != "failed" {
		t.Fatal("heartbeat omitted exact failed candidate identity")
	}
	if h["reported_generation"] != float64(2) || h["actual_sha256"] != Digest(good) {
		t.Fatal("failed candidate replaced verified heartbeat evidence")
	}
	if _, err := os.Stat(filepath.Join(e.Dir, "state.json")); err != nil {
		t.Fatal(err)
	}
}
