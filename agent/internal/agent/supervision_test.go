package agent

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestWorkloadRecoveryPreservesRejectedCandidate(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.validateErr = true
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("candidate unexpectedly accepted")
	}
	attempt := cloneAttempt(e.State.ConfigurationAttempt)
	failed, reported := *e.State.FailedGeneration, e.State.ReportedGeneration
	d.validateErr, d.alive = false, false
	s := &workloadSupervisor{}
	if err := s.check(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if !d.alive || d.starts != 1 || e.actual() != Digest(oldConfig) || e.State.ReportedGeneration != reported || *e.State.FailedGeneration != failed || !reflect.DeepEqual(attempt, e.State.ConfigurationAttempt) {
		t.Fatal("established workload recovery changed candidate or verified identity")
	}
	if e.State.ApplyState != "failed" || e.State.Error.Code != "VALIDATION_FAILED" {
		t.Fatal("recovered old workload mislabeled candidate success")
	}
}

func TestWorkloadRecoveryUnassignedAndPause(t *testing.T) {
	for _, mode := range []string{"unassigned", "local pause", "remote pause"} {
		t.Run(mode, func(t *testing.T) {
			e, m, d := fixture(t, newConfig)
			m.Desired = nil
			e.State.Desired = nil
			if err := e.Reconcile(context.Background(), m); err != nil {
				t.Fatal(err)
			}
			if mode == "local pause" {
				if err := SetPause(e.Dir, true); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "remote pause" {
				e.State.Policy.SyncPaused = true
			}
			d.alive = false
			if err := (&workloadSupervisor{}).check(context.Background(), e); err != nil {
				t.Fatal(err)
			}
			if mode == "unassigned" {
				if !d.alive || e.State.ApplyState != "unmanaged" || e.State.Error != nil {
					t.Fatal("unassigned workload not restored")
				}
			} else if d.starts != 0 || e.State.ApplyState != "verification_unknown" || e.State.Error.Code != "PROCESS_EXITED" {
				t.Fatal("pause restarted the process or hid its exit")
			}
			if e.actual() != Digest(oldConfig) || e.State.ReportedGeneration != 1 {
				t.Fatal("health recovery modified verified content or generation")
			}
		})
	}
}

type pauseValidationDriver struct {
	*fakeDriver
	dir string
}

func (d pauseValidationDriver) Validate(context.Context, string) error { return SetPause(d.dir, true) }

func TestWorkloadPauseArrivesDuringValidation(t *testing.T) {
	e, _, d := fixture(t, newConfig)
	d.alive = false
	e.Driver = pauseValidationDriver{d, e.Dir}
	if err := (&workloadSupervisor{}).check(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if d.starts != 0 || !LocalPaused(e.Dir) {
		t.Fatal("watchdog crossed local pause during validation")
	}
	if e.actual() != Digest(oldConfig) {
		t.Fatal("pause race changed managed content")
	}
}

func TestWorkloadRecoveryBackoffSurvivesShortLivedChildren(t *testing.T) {
	e, _, d := fixture(t, newConfig)
	now := time.Now()
	e.Now = func() time.Time { return now }
	s := &workloadSupervisor{}
	base := time.Now()
	for second := 0; second <= 610; second++ {
		now = base.Add(time.Duration(second) * time.Second)
		d.alive = false // Includes children that acknowledged startup but exit soon after.
		if err := s.check(context.Background(), e); err != nil {
			t.Fatal(err)
		}
		want := 0
		for _, at := range []int{0, 10, 30, 70, 150, 310, 610} {
			if second >= at {
				want++
			}
		}
		if d.starts != want {
			t.Fatalf("at %ds: starts=%d, want %d", second, d.starts, want)
		}
	}
	d.alive = true
	now = base.Add(671 * time.Second)
	if err := s.check(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if s.attempts != 0 {
		t.Fatal("stable running process did not reset retry backoff")
	}
}

func TestWorkloadRecoveryFailuresAreBoundedAndNoUnverifiedAdoption(t *testing.T) {
	e, _, d := fixture(t, newConfig)
	now := time.Now()
	e.Now = func() time.Time { return now }
	d.alive, d.validateErr = false, true
	s := &workloadSupervisor{}
	if err := s.check(context.Background(), e); err == nil {
		t.Fatal("expected real validation failure")
	}
	if s.attempts != 1 || !s.nextAttempt.After(now) {
		t.Fatal("failure has no backoff")
	}
	for i := 0; i < 9; i++ {
		now = now.Add(time.Second)
		if err := s.check(context.Background(), e); err != nil {
			t.Fatal("validation retried before deadline")
		}
	}
	if s.attempts != 1 {
		t.Fatal("repeated failures spun")
	}
	if e.State.Error.Code != "VALIDATION_FAILED" || e.State.Error.Stage != "startup" {
		t.Fatal("health observation erased the actionable local startup failure")
	}
	e.State.LastGoodSHA256 = ""
	now = now.Add(time.Hour)
	if err := s.check(context.Background(), e); err != nil || d.starts != 0 {
		t.Fatal("watchdog adopted unverified content", err)
	}
}

func TestWorkloadRecoveryDoesNotBypassJournalOrChangedPolicy(t *testing.T) {
	e, _, d := fixture(t, newConfig)
	d.alive = false
	if err := WriteJSON(filepath.Join(e.Dir, "journal.json"), Journal{Generation: 2}); err != nil {
		t.Fatal(err)
	}
	if err := (&workloadSupervisor{}).check(context.Background(), e); err == nil || d.starts != 0 {
		t.Fatal("unresolved journal bypassed")
	}
	if err := os.Remove(filepath.Join(e.Dir, "journal.json")); err != nil {
		t.Fatal(err)
	}
	e.Settings.CapabilityPolicy.AllowedFileRoots = nil
	denied := []byte(`{"sources":{"x":{"type":"exec","command":["bad"]}},"sinks":{"out":{"type":"blackhole","inputs":["x"]}}}`)
	e.State.LastGoodSHA256 = Digest(denied)
	if err := AtomicWrite(e.goodPath(), denied); err != nil {
		t.Fatal(err)
	}
	if err := (&workloadSupervisor{}).check(context.Background(), e); err == nil || d.starts != 0 || e.actual() != Digest(oldConfig) {
		t.Fatal("recovery weakened current local policy")
	}
}

func TestWorkloadRecoveryCancelledBeforeAction(t *testing.T) {
	e, _, d := fixture(t, newConfig)
	d.alive = false
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := (&workloadSupervisor{}).check(ctx, e); err != nil || d.starts != 0 {
		t.Fatal("cancelled watchdog started workload", err)
	}
}

func TestReconcileCannotBypassEstablishedWorkloadBackoff(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	e.Now = func() time.Time { return now }
	s := &workloadSupervisor{}
	e.supervisor = s
	d.alive = false
	if err := s.check(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	starts := d.starts
	d.alive = false
	for i := 0; i < 9; i++ {
		now = now.Add(time.Second)
		if err := e.Reconcile(context.Background(), m); err != nil {
			t.Fatal(err)
		}
		if err := s.check(context.Background(), e); err != nil {
			t.Fatal(err)
		}
	}
	if d.starts != starts || e.State.ReportedGeneration != m.Generation || e.State.ApplyState != "verification_unknown" {
		t.Fatal("heartbeat bypassed local restart backoff or lost verified counter")
	}
	now = now.Add(time.Second)
	if err := s.check(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if d.starts != starts+1 {
		t.Fatal("next bounded recovery did not run")
	}
}

func TestHeartbeatObservesDeadWorkloadWithoutRelabelingCandidate(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.validateErr = true
	_ = e.Reconcile(context.Background(), m)
	attempt := cloneAttempt(e.State.ConfigurationAttempt)
	data := newConfig
	heartbeats := attemptPollFixture(t, e, &m, &data)
	d.alive = false
	if err := SetPause(e.Dir, true); err != nil {
		t.Fatal(err)
	}
	if err := e.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := (*heartbeats)[0]
	if h["apply_state"] != "verification_unknown" || h["local_paused"] != true || h["error"].(map[string]any)["code"] != "PROCESS_EXITED" {
		t.Fatal("heartbeat hid paused workload death")
	}
	if h["configuration_attempt"].(map[string]any)["state"] != "failed" || !reflect.DeepEqual(e.State.ConfigurationAttempt, attempt) || e.State.ReportedGeneration != 1 || d.starts != 0 {
		t.Fatal("health observation changed candidate failure, counters, or pause behavior")
	}
}

func TestWorkloadExitAfterSuccessfulRollbackIsNotReportedAsStillRestored(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	attempt := cloneAttempt(e.State.ConfigurationAttempt)
	d.alive = false
	if err := e.observeProcessExit(); err != nil {
		t.Fatal(err)
	}
	if e.State.Error.Code != "PROCESS_EXITED" || e.State.ApplyState != "verification_unknown" || !reflect.DeepEqual(attempt, e.State.ConfigurationAttempt) {
		t.Fatal("historical rollback success hid current workload exit")
	}
}

type supervisionTransport func(*http.Request) (*http.Response, error)

func (f supervisionTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWorkloadRecoveryBetweenRenewalAndHeartbeat(t *testing.T) {
	e, m, d := fixture(t, newConfig)
	if err := e.Reconcile(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	data := newConfig
	attemptPollFixture(t, e, &m, &data)
	base := e.Client.HTTP.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	renewed, recoveredBeforeHeartbeat := false, false
	e.Client.HTTP.Transport = supervisionTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/agent/v1/renew" {
			renewed = true
			d.alive = false // Child exits while a failed renewal is in flight.
		}
		if r.URL.Path == "/agent/v1/heartbeat" {
			recoveredBeforeHeartbeat = renewed && d.alive
		}
		return base.RoundTrip(r)
	})
	s := &workloadSupervisor{}
	e.supervisor = s
	if err := s.poll(context.Background(), e, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if !recoveredBeforeHeartbeat || e.State.ReportedGeneration != m.Generation || d.starts != 2 {
		t.Fatal("renewal and heartbeat accumulated without a local recovery check")
	}
}
