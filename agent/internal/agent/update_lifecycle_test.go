package agent

import (
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The policy is saved before the agent service is registered. If a local off
// command finishes in that gap, setup must not install host update units from
// its stale pending result or claim that updates remain enabled.
func TestSetupFinalUpdateStepRespectsOffAfterConsentWasSaved(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	var installed atomic.Bool
	run := &setupRun{host: serviceHost{installUpdates: func(string, string) error {
		installed.Store(true)
		return os.MkdirAll(paths.StepDir, 0o755)
	}}}
	stateDir := t.TempDir()
	plan := &updatePlan{consent: UpdateConsentAuto, track: UpdateTrackPatch, pins: []ReleaseKey{testKey(t, teamKeyLine)}}
	if err := run.applyUpdates(plan, stateDir); err != nil {
		t.Fatal(err)
	}
	off, err := withdrawUpdatesReporting(stateDir, func() (bool, error) {
		installed.Store(false)
		return false, os.RemoveAll(paths.StepDir)
	})
	if err != nil || !off.PolicyOff {
		t.Fatalf("withdrawal: %+v, %v", off, err)
	}
	if err := run.finishUpdates("/usr/local/bin/vectory", stateDir); err != nil {
		t.Fatal(err)
	}
	if installed.Load() || run.result.Updates == nil || run.result.Updates.Consent != UpdateConsentOff || lastUpdatesStep(t, run.result).Status != "warn" {
		t.Fatalf("setup must report off without installing units: installed %v, result %+v", installed.Load(), run.result)
	}
	if _, err := os.Lstat(paths.StepDir); !os.IsNotExist(err) {
		t.Fatalf("step directory exists after off won: %v", err)
	}
}

// Service-uninstall must keep the lifecycle lock until the agent registration
// is gone. A setup that has saved consent but not yet installed the update step
// then rechecks the host after uninstall, instead of leaving units for a
// service that no longer exists.
func TestSetupDoesNotInstallUpdateStepDuringServiceUninstall(t *testing.T) {
	requireRootOwnedWriter(t)
	useUpdateRoots(t)
	var registered, installed atomic.Bool
	registered.Store(true)
	run := &setupRun{host: serviceHost{installUpdates: func(string, string) error {
		if !registered.Load() {
			return errors.New("the agent service is no longer registered")
		}
		installed.Store(true)
		return nil
	}}}
	stateDir := t.TempDir()
	plan := &updatePlan{consent: UpdateConsentAuto, track: UpdateTrackPatch, pins: []ReleaseKey{testKey(t, teamKeyLine)}}
	if err := run.applyUpdates(plan, stateDir); err != nil {
		t.Fatal(err)
	}
	uninstallEntered := make(chan struct{})
	finishUninstall := make(chan struct{})
	releaseUninstall := sync.OnceFunc(func() { close(finishUninstall) })
	defer releaseUninstall()
	uninstallDone := make(chan error, 1)
	go func() {
		uninstallDone <- withUpdateLifecycle(func() error {
			close(uninstallEntered)
			<-finishUninstall
			registered.Store(false)
			return nil
		})
	}()
	select {
	case <-uninstallEntered:
	case err := <-uninstallDone:
		t.Fatalf("service uninstall stopped before deregistration: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("service uninstall did not enter its lifecycle transaction")
	}
	setupDone := make(chan error, 1)
	go func() { setupDone <- run.finishUpdates("/usr/local/bin/vectory", stateDir) }()
	select {
	case err := <-setupDone:
		t.Fatalf("setup finished before service deregistration: %v", err)
	case <-time.After(250 * time.Millisecond):
	}
	releaseUninstall()
	if err := <-uninstallDone; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-setupDone:
		if err == nil || installed.Load() {
			t.Fatalf("setup must refuse a removed service: %v, installed %v", err, installed.Load())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("setup did not finish after service uninstall")
	}
}

// If setup has begun its final installation, off waits until both the helper
// and host units are registered, then removes them. Without lifecycle.lock it
// can observe no StepDir during the blocked install and return too early.
func TestUpdateOffWaitsForSetupHostUnitInstallationThenRemovesIt(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	enteredInstall := make(chan struct{})
	finishInstall := make(chan struct{})
	releaseInstall := sync.OnceFunc(func() { close(finishInstall) })
	defer releaseInstall()
	var installed atomic.Bool
	run := &setupRun{host: serviceHost{installUpdates: func(string, string) error {
		close(enteredInstall)
		<-finishInstall
		if err := os.MkdirAll(paths.StepDir, 0o755); err != nil {
			return err
		}
		installed.Store(true)
		return nil
	}}}
	stateDir := t.TempDir()
	plan := &updatePlan{consent: UpdateConsentAuto, track: UpdateTrackPatch, pins: []ReleaseKey{testKey(t, teamKeyLine)}}
	if err := run.applyUpdates(plan, stateDir); err != nil {
		t.Fatal(err)
	}
	setupDone := make(chan error, 1)
	go func() { setupDone <- run.finishUpdates("/usr/local/bin/vectory", stateDir) }()
	select {
	case <-enteredInstall:
	case err := <-setupDone:
		t.Fatalf("setup stopped before unit install: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("setup did not enter unit installation")
	}
	type result struct {
		off UpdateWithdrawal
		err error
	}
	offDone := make(chan result, 1)
	go func() {
		off, err := withdrawUpdatesReporting(stateDir, func() (bool, error) {
			installed.Store(false)
			return false, os.RemoveAll(paths.StepDir)
		})
		offDone <- result{off, err}
	}()
	select {
	case got := <-offDone:
		t.Fatalf("off finished while setup was still installing host units: %+v", got)
	case <-time.After(250 * time.Millisecond):
	}
	releaseInstall()
	select {
	case err := <-setupDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("setup did not finish")
	}
	select {
	case got := <-offDone:
		if got.err != nil || !got.off.PolicyOff || !got.off.StepRemoved {
			t.Fatalf("off after setup: %+v", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("off did not finish after setup released the lifecycle lock")
	}
	policy, err := ReadUpdatePolicy()
	if err != nil || policy.Consent != UpdateConsentOff || installed.Load() {
		t.Fatalf("off must leave neither consent nor installed units: %+v, %v, installed %v", policy, err, installed.Load())
	}
	if _, err := os.Lstat(paths.StepDir); !os.IsNotExist(err) {
		t.Fatalf("step directory remains after off: %v", err)
	}
}
