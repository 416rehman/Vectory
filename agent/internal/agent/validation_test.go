package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// withoutSpacing lets a test make checks back to back.
func withoutSpacing(t *testing.T) {
	t.Helper()
	previous := validationSpacing
	validationSpacing = 0
	t.Cleanup(func() { validationSpacing = previous })
}

// A verified manifest that carries a request to check a candidate makes the
// agent stage it privately, outside the managed directory, let Vector check it
// (and run its tests when asked), and delete the copy; the result goes out in
// the next heartbeat with the announcements the server's feature allows.
func TestCheckOnRequestStagesChecksAndDeletesTheCopy(t *testing.T) {
	for _, runTests := range []bool{false, true} {
		t.Run(fmt.Sprintf("run_tests=%v", runTests), func(t *testing.T) {
			d := newCheckDevice(t)
			d.poll()
			if len(d.driver.checks()) != 0 || len(d.staging()) != 0 {
				t.Fatal("an ordinary check-in checked something")
			}
			d.ask(newConfig, checkID, runTests)
			before := d.snapshot()
			d.poll()

			checks := d.driver.checks()
			if len(checks) != 1 || checks[0].RunTests != runTests || !bytes.Equal(checks[0].Content, newConfig) {
				t.Fatalf("the candidate wasn't checked once as asked: %+v", checks)
			}
			staged := checks[0]
			if want := filepath.Join(d.state, validationStagingName); filepath.Dir(staged.Path) != want {
				t.Fatalf("staged in %s, want %s", filepath.Dir(staged.Path), want)
			}
			if filepath.Dir(staged.Path) == filepath.Dir(d.managed) || strings.HasPrefix(staged.Path, filepath.Dir(d.managed)+string(filepath.Separator)) {
				t.Fatal("the candidate was staged in the managed directory")
			}
			if runtime.GOOS != "windows" && (staged.FileMode != 0600 || staged.DirMode != 0700) {
				t.Fatalf("the staged copy is %v in a %v directory", staged.FileMode, staged.DirMode)
			}
			if left := d.staging(); len(left) != 0 {
				t.Fatalf("the staged copy was left behind: %v", left)
			}
			if !reflect.DeepEqual(before, d.snapshot()) {
				t.Fatalf("the check changed the device:\n%v\n%v", before, d.snapshot())
			}
			if d.driver.starts != 0 {
				t.Fatal("a check activated Vector")
			}
			if downloads := d.plane.downloads(); !slices.Contains(downloads, "/agent/v1/artifacts/"+Digest(newConfig)) {
				t.Fatalf("the candidate was never downloaded: %v", downloads)
			}

			// The next heartbeat answers, and announces what the agent can do.
			d.poll()
			beat := d.plane.last()
			res := result(beat)
			if res == nil || res["id"] != checkID || res["valid"] != true {
				t.Fatalf("the result is %v", beat["validation_result"])
			}
			keys := []string{}
			for key := range res {
				keys = append(keys, key)
			}
			slices.Sort(keys)
			if !slices.Equal(keys, []string{"diagnostics", "duration_ms", "id", "secrets_missing", "tests", "valid"}) {
				t.Fatalf("result keys %v", keys)
			}
			for _, key := range []string{"diagnostics", "tests", "secrets_missing"} {
				if list, ok := res[key].([]any); !ok || len(list) != 0 {
					t.Fatalf("%s is %#v, want an empty list", key, res[key])
				}
			}
			if features, _ := beat["agent_features"].([]any); !reflect.DeepEqual(features, []any{"validation"}) {
				t.Fatalf("agent_features %v", beat["agent_features"])
			}
			readiness, _ := beat["readiness"].(map[string]any)
			if len(readiness) != 2 || readiness["data_dir_writable"] != true || readiness["allowed_listener_count"] != float64(0) {
				t.Fatalf("readiness %v", beat["readiness"])
			}
		})
	}
}

// A check that fails leaves nothing behind either, and says why.
func TestCheckThatFailsDeletesTheCopyAndSaysWhy(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	bad := []byte(`{"sources":{"synthetic":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["nope"]}}}`)
	d.driver.respond(func(checkedCandidate) (candidateRun, error) {
		return candidateRun{}, &VectorFailure{Phase: "validate", Summary: "Vector rejected the configuration", Output: vectorFixture(t, "missing_input.validate.txt")}
	})
	d.ask(bad, checkID, false)
	d.poll()
	if left := d.staging(); len(left) != 0 {
		t.Fatalf("a failed check left %v", left)
	}
	d.poll()
	res := result(d.plane.last())
	if res == nil || res["valid"] != false {
		t.Fatalf("result %v", res)
	}
	diagnostics, _ := res["diagnostics"].([]any)
	if len(diagnostics) != 1 {
		t.Fatalf("diagnostics %v", diagnostics)
	}
	first, _ := diagnostics[0].(map[string]any)
	if first["code"] != "INPUT_NOT_FOUND" || first["component_id"] != "out" || first["component_kind"] != "sink" || first["field"] != "inputs" || first["severity"] != "error" {
		t.Fatalf("diagnostic %v", first)
	}
}

// A process killed in the middle of a check leaves its staged copy and the
// copy of Vector's runtime settings: the next start deletes them at once, not
// after the age that other leftovers wait for.
func TestStartupDeletesWhatAKilledCheckLeft(t *testing.T) {
	d := newCheckDevice(t)
	dir, err := d.e.stagingDir()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".vectory-stage-" + RandomID() + ".json", "host-runtime-stage-0123456789abcdef.json", atomicTempPrefix + "4242"} {
		if err = os.WriteFile(filepath.Join(dir, name), []byte(`{"sinks":{}}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if len(d.staging()) != 3 {
		t.Fatal("the leftovers weren't set up")
	}
	if err = d.e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if left := d.staging(); len(left) != 0 {
		t.Fatalf("startup left %v", left)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatal("startup removed the staging directory itself")
	}
}

// What a verified manifest must be, to be acted on: a bad signature, another
// device's manifest, a request that has expired or lives longer than the
// manifest allows, one the server didn't list the feature for, and one that
// isn't well formed never start a check, never download the candidate and never
// stage a copy.
func TestRequestsThatAreNotVerifiedNeverStartACheck(t *testing.T) {
	now := func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	cases := []struct {
		name string
		// change alters the plane, with the request req already carried.
		change func(d *checkDevice, req *ValidationRequest)
		// fails: the manifest is refused as a whole.
		fails bool
	}{
		{"bad signature", func(d *checkDevice, _ *ValidationRequest) {
			_, other, _ := ed25519.GenerateKey(rand.Reader)
			d.plane.mu.Lock()
			d.plane.key = other
			d.plane.mu.Unlock()
		}, true},
		{"wrong recipient", func(d *checkDevice, _ *ValidationRequest) {
			d.plane.with(func(m *Manifest) { m.DeviceID = "device-b" })
		}, true},
		{"stale expiry", func(d *checkDevice, req *ValidationRequest) {
			req.ExpiresAt = now().Add(-time.Minute)
			d.carry(*req)
		}, false},
		{"expiry at the manifest's issue time", func(d *checkDevice, req *ValidationRequest) {
			req.ExpiresAt = now().Add(-time.Second)
			d.carry(*req)
		}, false},
		{"long-lived expiry", func(d *checkDevice, req *ValidationRequest) {
			req.ExpiresAt = now().Add(16 * time.Minute)
			d.carry(*req)
		}, false},
		{"no expiry", func(d *checkDevice, req *ValidationRequest) {
			d.plane.with(func(m *Manifest) {
				m.Validation = json.RawMessage(fmt.Sprintf(`{"id":%q,"sha256":%q,"size":%d,"artifact_path":%q,"run_tests":false}`, req.ID, req.SHA256, req.Size, req.ArtifactPath))
			})
		}, false},
		{"feature not listed", func(d *checkDevice, _ *ValidationRequest) {
			d.plane.with(func(m *Manifest) { m.Features = []string{featureWake} })
		}, false},
		{"no features at all", func(d *checkDevice, _ *ValidationRequest) {
			d.plane.with(func(m *Manifest) { m.Features = nil })
		}, false},
		{"id that isn't a uuid", func(d *checkDevice, req *ValidationRequest) { req.ID = "../../etc/passwd"; d.carry(*req) }, false},
		{"digest in capitals", func(d *checkDevice, req *ValidationRequest) {
			req.SHA256 = strings.ToUpper(req.SHA256)
			req.ArtifactPath = "/agent/v1/artifacts/" + req.SHA256
			d.carry(*req)
		}, false},
		{"empty artifact", func(d *checkDevice, req *ValidationRequest) { req.Size = 0; d.carry(*req) }, false},
		{"artifact above the protocol bound", func(d *checkDevice, req *ValidationRequest) { req.Size = maxValidationArtifact + 1; d.carry(*req) }, false},
		{"another artifact path", func(d *checkDevice, req *ValidationRequest) {
			req.ArtifactPath = "/agent/v1/artifacts/../../x"
			d.carry(*req)
		}, false},
		{"an external artifact", func(d *checkDevice, req *ValidationRequest) {
			req.ArtifactPath = "https://evil.example/x"
			d.carry(*req)
		}, false},
		{"not an object", func(d *checkDevice, _ *ValidationRequest) {
			d.plane.with(func(m *Manifest) { m.Validation = json.RawMessage(`"check everything"`) })
		}, false},
		{"fields of the wrong type", func(d *checkDevice, _ *ValidationRequest) {
			d.plane.with(func(m *Manifest) { m.Validation = json.RawMessage(`{"id":5,"sha256":[],"size":"big"}`) })
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newCheckDevice(t)
			now := time.Now()
			d.e.State.LastSigningRefresh = &now // no credential renewal attempt after a rejected signature
			req := d.ask(newConfig, checkID, true)
			c.change(d, &req)
			err := d.e.Poll(context.Background())
			if c.fails != (err != nil) {
				t.Fatalf("poll error %v, want failure %v", err, c.fails)
			}
			if checks := d.driver.checks(); len(checks) != 0 {
				t.Fatalf("a check ran: %+v", checks)
			}
			if slices.Contains(d.plane.downloads(), req.ArtifactPath) {
				t.Fatal("the candidate was downloaded")
			}
			if left := d.staging(); len(left) != 0 {
				t.Fatalf("something was staged: %v", left)
			}
			if d.e.validation.pending != nil {
				t.Fatal("there is a result for a request that was never accepted")
			}
		})
	}
}

// The window rules, at their edges.
func TestValidationWindow(t *testing.T) {
	issued := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	now := issued.Add(2 * time.Second)
	manifest := func(expires time.Time, features ...string) Manifest {
		raw := mustJSON(t, ValidationRequest{ID: checkID, SHA256: Digest(newConfig), Size: int64(len(newConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(newConfig), ExpiresAt: expires})
		return Manifest{IssuedAt: issued, Features: features, Validation: raw}
	}
	for _, c := range []struct {
		name    string
		expires time.Time
		accept  bool
	}{
		{"a minute ahead", now.Add(time.Minute), true},
		{"a second ahead", now.Add(time.Second), true},
		{"now", now, false},
		{"in the past", now.Add(-time.Second), false},
		{"exactly fifteen minutes after the manifest was issued", issued.Add(15 * time.Minute), true},
		{"a second longer", issued.Add(15*time.Minute + time.Second), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := validationRequest(manifest(c.expires, featureValidation), now) != nil; got != c.accept {
				t.Fatalf("accepted %v, want %v", got, c.accept)
			}
		})
	}
	if validationRequest(manifest(now.Add(time.Minute)), now) != nil || validationRequest(Manifest{IssuedAt: issued, Features: []string{featureValidation}}, now) != nil {
		t.Fatal("a request without the feature, or no request, was accepted")
	}
}

// An apply that is under way defers the check: nothing is downloaded or staged
// while it is, and the next check-in, which carries the request again while it
// is open, makes the check once the apply is over.
func TestAnApplyInFlightDefersTheCheck(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	next := &Desired{VersionID: "v2", SHA256: Digest(newConfig), Size: int64(len(newConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(newConfig), VectorVersion: VectorVersion}
	d.plane.offer(next.ArtifactPath, newConfig)
	d.plane.with(func(m *Manifest) { m.Generation, m.Desired = 3, next })
	candidate := []byte(`{"sources":{"other":{"type":"demo_logs","format":"json"}},"sinks":{"discard":{"type":"blackhole","inputs":["other"]}}}`)
	req := d.ask(candidate, checkID, false)

	// The apply is cut short after the managed file was written: its journal and
	// its progress are still there.
	d.e.Fault = func(stage string) error {
		if stage == "written" {
			return errors.New("simulated power loss")
		}
		return nil
	}
	if err := d.e.Poll(context.Background()); err == nil {
		t.Fatal("the fault didn't stop the apply")
	}
	if journalStage(t, d.state) == "" || !d.e.applyInFlight() {
		t.Fatal("the apply isn't in flight")
	}
	if len(d.driver.checks()) != 0 || slices.Contains(d.plane.downloads(), req.ArtifactPath) || len(d.staging()) != 0 {
		t.Fatal("a check ran while an apply was in flight")
	}
	if d.e.validation.pending != nil || d.e.validationAnswered(req.ID) {
		t.Fatal("a deferred check was counted as answered")
	}

	// The apply finishes at the next check-in, and the check follows it.
	d.e.Fault = nil
	d.poll()
	if d.e.State.ApplyState != "verified_applied" || d.e.State.ReportedGeneration != 3 || journalStage(t, d.state) != "" {
		t.Fatalf("the apply didn't finish: %s", d.e.State.ApplyState)
	}
	if checks := d.driver.checks(); len(checks) != 1 || !bytes.Equal(checks[0].Content, candidate) {
		t.Fatalf("the deferred check didn't run after the apply: %+v", checks)
	}
	d.poll()
	if res := result(d.plane.last()); res == nil || res["id"] != checkID {
		t.Fatal("the deferred check has no result")
	}
}

// A journal that belongs to another apply, found with a check requested, also
// means an apply is unfinished.
func TestAJournalDefersTheCheck(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	if err := WriteJSON(filepath.Join(d.state, "journal.json"), Journal{Stage: "prepared", Generation: 9, DesiredSHA256: Digest(newConfig), PreviousSHA256: Digest(oldConfig)}); err != nil {
		t.Fatal(err)
	}
	d.ask(newConfig, checkID, false)
	d.poll()
	if len(d.driver.checks()) != 0 || d.e.validation.pending != nil {
		t.Fatal("a check ran with a journal on disk")
	}
	if err := os.Remove(filepath.Join(d.state, "journal.json")); err != nil {
		t.Fatal(err)
	}
	d.poll()
	if len(d.driver.checks()) != 1 {
		t.Fatal("the check didn't run once the journal was gone")
	}
}

// A paused agent, one that drifted and one whose last apply failed still check:
// a check never depends on, or changes, what the apply path holds.
func TestPausedDriftedAndFailedDevicesStillCheck(t *testing.T) {
	cases := map[string]func(d *checkDevice){
		"paused on the host": func(d *checkDevice) {
			if err := SetPause(d.state, true); err != nil {
				t.Fatal(err)
			}
		},
		"paused from the dashboard": func(d *checkDevice) {
			d.plane.with(func(m *Manifest) { m.Policy.SyncPaused = true; m.PolicyGeneration++ })
		},
		"drifted": func(d *checkDevice) {
			if err := AtomicWrite(d.managed, []byte(`{"sources":{},"sinks":{}}`)); err != nil {
				t.Fatal(err)
			}
			if err := SetPause(d.state, true); err != nil { // keep the apply path from repairing it
				t.Fatal(err)
			}
		},
		"last apply failed": func(d *checkDevice) {
			d.driver.fakeDriver.validateErr = true
			next := &Desired{VersionID: "v2", SHA256: Digest(newConfig), Size: int64(len(newConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(newConfig), VectorVersion: VectorVersion}
			d.plane.offer(next.ArtifactPath, newConfig)
			d.plane.with(func(m *Manifest) { m.Generation, m.Desired = 3, next })
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			d := newCheckDevice(t)
			d.poll()
			setup(d)
			d.ask(newConfig, checkID, false)
			_ = d.e.Poll(context.Background())
			if len(d.driver.checks()) != 1 {
				t.Fatalf("%d checks", len(d.driver.checks()))
			}
			d.driver.fakeDriver.validateErr = false
			_ = d.e.Poll(context.Background())
			if res := result(d.plane.last()); res == nil || res["valid"] != true {
				t.Fatalf("result %v", res)
			}
		})
	}
}

// A check is checked once and its result is sent in every heartbeat until the
// manifest stops carrying it; then it is forgotten, and a manifest that brings
// it back (a restart included) doesn't make another one.
func TestResultIsSentUntilTheManifestStopsCarryingTheRequest(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	req := d.ask(newConfig, checkID, false)
	d.poll() // the check
	for i := 0; i < 3; i++ {
		d.poll() // the manifest still carries the request
		if res := result(d.plane.last()); res == nil || res["id"] != checkID {
			t.Fatalf("heartbeat %d has no result", i)
		}
	}
	if len(d.driver.checks()) != 1 {
		t.Fatalf("%d checks", len(d.driver.checks()))
	}
	d.forget()
	d.poll() // this heartbeat still carries it: the reply is what says it is done
	if result(d.plane.last()) == nil {
		t.Fatal("the last heartbeat before the server's answer doesn't carry the result")
	}
	d.poll()
	if result(d.plane.last()) != nil || d.e.validation.pending != nil {
		t.Fatal("the result is still sent after the manifest stopped carrying its request")
	}

	// The memory of what was answered is what keeps a returning request from
	// being checked again, also after a restart.
	d.carry(req)
	for _, engine := range []*Engine{d.e, {Dir: d.e.Dir, Settings: d.e.Settings, State: d.e.State, Driver: d.driver, Client: d.e.Client, Credentials: d.e.Credentials}} {
		d.e = engine
		d.poll()
	}
	if len(d.driver.checks()) != 1 || d.e.validation.pending != nil {
		t.Fatalf("an answered request was checked again: %d checks", len(d.driver.checks()))
	}
	raw, err := os.ReadFile(filepath.Join(d.state, validationAnsweredName))
	if err != nil || !strings.Contains(string(raw), checkID) {
		t.Fatalf("the answered ids on disk: %q %v", raw, err)
	}
	if info, err := os.Stat(filepath.Join(d.state, validationAnsweredName)); runtime.GOOS != "windows" && (err != nil || info.Mode().Perm() != 0600) {
		t.Fatalf("answered ids are %v: %v", info.Mode(), err)
	}
}

// A new request replaces the one the server took back: the old result is
// dropped, and the new request is checked.
func TestANewerRequestReplacesAnUnsentResult(t *testing.T) {
	withoutSpacing(t)
	d := newCheckDevice(t)
	d.poll()
	d.ask(newConfig, checkID, false)
	d.poll()
	if d.e.validation.pending == nil || d.e.validation.pending.ID != checkID {
		t.Fatal("no result to replace")
	}
	other := []byte(`{"sources":{"other":{"type":"demo_logs","format":"json"}},"sinks":{"discard":{"type":"blackhole","inputs":["other"]}}}`)
	d.ask(other, checkID2, false)
	d.poll()
	if res := d.e.validation.pending; res == nil || res.ID != checkID2 {
		t.Fatal("the new request wasn't checked")
	}
	if !d.e.validationAnswered(checkID) {
		t.Fatal("the replaced request isn't remembered")
	}
	d.poll()
	if res := result(d.plane.last()); res == nil || res["id"] != checkID2 {
		t.Fatalf("the heartbeat carries %v", res)
	}
}

// Requests that come one after another are spaced: the second waits for a
// later check-in, which carries it again.
func TestChecksAreSpacedOut(t *testing.T) {
	d := newCheckDevice(t)
	clock := time.Now()
	d.e.Now = func() time.Time { return clock }
	d.poll()
	d.ask(newConfig, checkID, false)
	d.poll()
	other := []byte(`{"sources":{"other":{"type":"demo_logs","format":"json"}},"sinks":{"discard":{"type":"blackhole","inputs":["other"]}}}`)
	d.ask(other, checkID2, false)
	d.poll()
	if len(d.driver.checks()) != 1 {
		t.Fatal("a second check followed at once")
	}
	clock = clock.Add(validationSpacing + time.Second)
	d.poll()
	if checks := d.driver.checks(); len(checks) != 2 || !bytes.Equal(checks[1].Content, other) {
		t.Fatalf("the second request wasn't checked after the spacing: %d", len(checks))
	}
}

// A result is not kept for a request that has expired, even when the server
// still carries it: an expired request is not one this agent acts on.
func TestAResultIsDroppedWhenItsRequestHasExpired(t *testing.T) {
	d := newCheckDevice(t)
	clock := time.Now()
	d.e.Now = func() time.Time { return clock }
	d.poll()
	req := d.request(newConfig, checkID, false)
	req.ExpiresAt = time.Now().UTC().Add(2 * time.Minute).Truncate(time.Second)
	d.plane.offer(req.ArtifactPath, newConfig)
	d.carry(req)
	d.poll()
	if d.e.validation.pending == nil {
		t.Fatal("no result to expire")
	}
	clock = req.ExpiresAt.Add(time.Second)
	d.poll()
	if d.e.validation.pending != nil || !d.e.validationAnswered(checkID) {
		t.Fatal("an expired result is still pending")
	}
	d.poll()
	if result(d.plane.last()) != nil || len(d.driver.checks()) != 1 {
		t.Fatal("an expired request was answered again")
	}
}

// A candidate larger than an agent accepts (but within what the protocol lets a
// request name) is answered, in words, without a download.
func TestACandidateLargerThanAgentsAcceptIsAnswered(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	req := d.request(newConfig, checkID, false)
	req.Size = MaxArtifact + 1
	d.carry(req)
	d.poll()
	d.poll()
	res := result(d.plane.last())
	if res == nil || res["valid"] != false {
		t.Fatalf("result %v", res)
	}
	first := res["diagnostics"].([]any)[0].(map[string]any)
	if first["code"] != "DOWNLOAD_TOO_LARGE" || len(d.driver.checks()) != 0 || slices.Contains(d.plane.downloads(), req.ArtifactPath) {
		t.Fatalf("diagnostic %v, downloads %v", first, d.plane.downloads())
	}
}

// Everything that can go wrong in the download ends in a diagnostic that says
// what, and that the check can be run again; nothing is staged.
func TestDownloadFailuresAreAnsweredInWords(t *testing.T) {
	cases := []struct {
		name, code string
		setup      func(d *checkDevice, req ValidationRequest)
	}{
		{"altered bytes", "ARTIFACT_MISMATCH", func(d *checkDevice, req ValidationRequest) {
			d.plane.offer(req.ArtifactPath, bytes.Replace(newConfig, []byte("interval"), []byte("intervaL"), 1))
		}},
		{"short download", "ARTIFACT_MISMATCH", func(d *checkDevice, req ValidationRequest) {
			d.plane.offer(req.ArtifactPath, newConfig[:len(newConfig)-3])
		}},
		{"the digest is no longer offered", "CHECK_EXPIRED", func(d *checkDevice, _ ValidationRequest) {
			d.plane.mu.Lock()
			d.plane.artifactStatus = 404
			d.plane.mu.Unlock()
		}},
		{"refused", "CHECK_EXPIRED", func(d *checkDevice, _ ValidationRequest) {
			d.plane.mu.Lock()
			d.plane.artifactStatus = 403
			d.plane.mu.Unlock()
		}},
		{"server error", "SERVER_ERROR", func(d *checkDevice, _ ValidationRequest) {
			d.plane.mu.Lock()
			d.plane.artifactStatus = 500
			d.plane.mu.Unlock()
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newCheckDevice(t)
			d.poll()
			req := d.ask(newConfig, checkID, false)
			c.setup(d, req)
			d.poll()
			d.poll()
			res := result(d.plane.last())
			if res == nil || res["valid"] != false {
				t.Fatalf("result %v", res)
			}
			first := res["diagnostics"].([]any)[0].(map[string]any)
			hint, _ := first["hint"].(string)
			if first["code"] != c.code || !strings.Contains(hint, "Run the check again.") || strings.Contains(hint, "next check-in") {
				t.Fatalf("diagnostic %v", first)
			}
			if len(d.driver.checks()) != 0 || len(d.staging()) != 0 {
				t.Fatal("a download that failed was checked or staged")
			}
		})
	}
}

// A device whose agent never adopted a Vector binary can't check, and says so.
func TestADeviceThatHasNotAdoptedVectorSaysSo(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	d.e.Settings.Adopted = false
	d.ask(newConfig, checkID, false)
	_ = d.e.Poll(context.Background())
	d.e.Settings.Adopted = true
	d.poll()
	res := result(d.plane.last())
	if res == nil || res["valid"] != false || res["diagnostics"].([]any)[0].(map[string]any)["code"] != "ADOPTION_REQUIRED" {
		t.Fatalf("result %v", res)
	}
}

// A check that is cut short because the agent is stopping has no result: there
// is nothing true to say, and the next start makes it again.
func TestAStoppedCheckHasNoResult(t *testing.T) {
	d := newCheckDevice(t)
	d.poll()
	ctx, cancel := context.WithCancel(context.Background())
	d.driver.respond(func(checkedCandidate) (candidateRun, error) {
		cancel()
		return candidateRun{}, &VectorFailure{Phase: "timeout", Summary: "stopped"}
	})
	d.ask(newConfig, checkID, false)
	_ = d.e.Poll(ctx)
	if d.e.validation.pending != nil || d.e.validationAnswered(checkID) {
		t.Fatal("a check the agent's stopping cut short has an answer")
	}
	if left := d.staging(); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
}
