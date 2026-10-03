//go:build !windows

package agent

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// The ways a request fails on the machine, short of a crash: no room, a service that
// won't stop, a swap the file system refuses, a build that fails the probe, a policy
// that changes while the step works, a second run and a second request. Each leaves
// the host on the build it had, and says why.

// requireOldBuildRunning says the agent still runs the build it had, and the step
// holds nothing of the request.
func (f *stepFixture) requireOldBuildRunning(oldDigest string) {
	f.t.Helper()
	if got := f.executableDigest(); got != oldDigest {
		f.t.Errorf("the executable is %s, want the build it had, %s", got, oldDigest)
	}
	if service := f.service(); service.Version != "0.1.0" || service.State != "active" {
		f.t.Errorf("the service: %+v", service)
	}
	if _, found := f.journal(); found {
		f.t.Error("a journal is left")
	}
	if !f.stagingEmpty() {
		f.t.Error("the staging directory holds files")
	}
	if entries, _ := os.ReadDir(f.paths.Probe); len(entries) != 0 {
		f.t.Errorf("the probe directory holds %d files", len(entries))
	}
	if beside := f.beside(); len(beside) != 0 {
		f.t.Errorf("files are left beside the executable: %v", beside)
	}
}

func TestAnUpdateWithNoRoomForTwoCopiesOfTheBuildIsRefusedBeforeAnythingChanges(t *testing.T) {
	for name, set := range map[string]func(f *stepFixture, free uint64){
		"the install directory's file system": func(f *stepFixture, free uint64) { f.host.cfg.InstallFree = free },
		"the step's own file system":          func(f *stepFixture, free uint64) { f.host.cfg.StepFree = free },
	} {
		t.Run(name+" one byte short", func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			set(f, 2*uint64(len(release.build))-1)
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeFailed, "DISK_FULL")
			f.requireUnchanged(before)
			f.requireOldBuildRunning(before.executable)
			if len(f.host.probeCalls) != 0 {
				t.Errorf("a build that has no room was run: %v", f.host.probeCalls)
			}
		})
		t.Run(name+" exactly enough", func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			set(f, 2*uint64(len(release.build)))
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeCommitted, "")
			if got := f.executableDigest(); got != release.buildSHA() {
				t.Errorf("the executable is %s, want the new build", got)
			}
		})
	}
}

func TestRunningOutOfRoomWhileTheStepWritesEndsTheRequestAsDiskFullAndTheAgentRunsOn(t *testing.T) {
	for name, set := range map[string]func(f *stepFixture){
		"beside the executable":           func(f *stepFixture) { f.host.cfg.StageENOSPC = true },
		"in the step's staging directory": func(f *stepFixture) { f.host.cfg.CopyENOSPC = f.paths.Staging },
		"in the probe directory":          func(f *stepFixture) { f.host.cfg.CopyENOSPC = f.paths.Probe },
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			set(f)
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeFailed, "DISK_FULL")
			f.requireUnchanged(before)
			f.requireOldBuildRunning(before.executable)
		})
	}
}

func TestAServiceThatWontStopLeavesTheOldBuildInPlaceAndTheRequestEndsAsInterrupted(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	f.host.cfg.StopFails = true
	before := f.snapshot()
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	// The release was attempted, so its floor is up and it is never tried again;
	// nothing else changed.
	f.requireUnchanged(before, "counters")
	if got := f.counters().HighestCounters[f.public.Fingerprint()]; got != release.counter {
		t.Errorf("the floor is %d after an attempt of counter %d", got, release.counter)
	}
	f.requireOldBuildRunning(before.executable)
}

func TestASwapTheFileSystemRefusesLeavesTheOldBuildRunningAndSaysWhy(t *testing.T) {
	for name, c := range map[string]struct{ fails, outcome, code string }{
		"for a reason the system gives":     {"rename: input/output error", UpdateOutcomeFailed, "INTERRUPTED"},
		"on a file system turned read-only": {"read-only", UpdateOutcomeRefused, "READ_ONLY"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			f.host.cfg.SwapFails = c.fails
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, c.outcome, c.code)
			f.requireUnchanged(before, "counters", "history")
			if got := f.counters().HighestCounters[f.public.Fingerprint()]; got != release.counter {
				t.Errorf("the floor is %d after an attempt of counter %d", got, release.counter)
			}
			f.requireOldBuildRunning(before.executable)
			// The service was stopped for the swap, and is started again on what is there.
			if history := strings.Join(f.service().History, ","); history != "start 0.1.0,stop,start 0.1.0" {
				t.Errorf("the service's history: %s", history)
			}
		})
	}
}

func TestABuildThatFailsOrMisreportsItselfInTheProbeIsRefusedBeforeAnythingStops(t *testing.T) {
	for _, behavior := range []string{"badprobe", "wrongversion", "wrongos", "hugeprobe", "noversion"} {
		t.Run(behavior, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", behavior, releaseOptions{})
			f.stage(release)
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeFailed, "PROBE_FAILED")
			f.requireUnchanged(before)
			f.requireOldBuildRunning(before.executable)
			if len(f.host.probeCalls) != 1 {
				t.Errorf("the probe ran %d times: %v", len(f.host.probeCalls), f.host.probeCalls)
			}
		})
	}
}

// A person who turns updates off, pauses them or pins the host to another key while
// the step copies and probes is not overtaken: the policy is read again before
// anything stops, and the offer is decided again under it.
func TestAPolicyThatChangesWhileTheStepPreparesIsHonouredBeforeAnythingStops(t *testing.T) {
	other := testPrivateKey(t, 21)
	otherKey := testPublicKey(t, other, "someone else")
	for name, c := range map[string]struct {
		edit func(*UpdatePolicy)
		code string
	}{
		"updates turned off":             {func(p *UpdatePolicy) { p.Consent = UpdateConsentOff }, "UPDATES_OFF"},
		"updates paused":                 {func(p *UpdatePolicy) { p.Paused = true }, "UPDATES_PAUSED"},
		"the host pinned to another key": {func(p *UpdatePolicy) { p.SetPinnedKeys([]ReleaseKey{otherKey}) }, "KEY_NOT_PINNED"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			oldDigest := f.executableDigest()
			changed := false
			updateFault = func(point string) {
				// After the build is probed and staged, before the floor is raised.
				if point == "snapshot" && !changed {
					changed = true
					f.setPolicy(c.edit)
				}
			}
			f.mustRun()
			if !changed {
				t.Fatal("the step never reached the end of its preparation")
			}
			f.requireAnswered(release, outcomeOf(c.code, true), c.code)
			f.requireOldBuildRunning(oldDigest)
			if history := f.service().History; len(history) != 1 {
				t.Errorf("the service was touched: %v", history)
			}
			if floors := f.counters().HighestCounters; floors[f.public.Fingerprint()] != 0 {
				t.Errorf("a floor was raised for a release that was refused: %v", floors)
			}
		})
	}
}

func TestASecondRunWhileOneIsWorkingExitsAtOnceAndApplyAsksToTryAgain(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	held, err := f.host.Lock(f.openPrivate())
	if err != nil {
		t.Fatal(err)
	}
	before := f.snapshot()
	if err := f.run(); err != nil {
		t.Errorf("a timer run that found the step busy failed: %v", err)
	}
	if err := ApplyStagedUpdate(context.Background(), f.stateDir, false, nil); err == nil || !strings.Contains(err.Error(), "another run") {
		t.Errorf("apply while the step is busy: %v", err)
	}
	f.requireUnchanged(before)
	held()
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeCommitted, "")
}

// The agent offers nothing while the step's status shows an update in progress, and
// the step itself takes no second request while its journal is not idle: a request
// that shows up anyway waits until the trial has ended, and is then an ordinary
// request.
func TestARequestThatArrivesWhileATrialIsInProgressWaitsForTheTrialToEnd(t *testing.T) {
	f := newStepFixture(t)
	first := f.newRelease("0.1.1", "good", releaseOptions{counter: 7})
	f.stage(first)
	if !f.runChildUntil("started") {
		t.Fatal("the trial never started")
	}
	second := f.newRelease("0.1.2", "good", releaseOptions{counter: 8})
	f.stage(second)
	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireAnswered(first, UpdateOutcomeCommitted, "")
	if got := f.executableDigest(); got != first.buildSHA() {
		t.Fatalf("the executable is %s, which is not the build of the trial", got)
	}
	if got := f.counters().HighestCounters[f.public.Fingerprint()]; got != 7 {
		t.Errorf("the floor is %d: the second release was begun during the first one's trial", got)
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireAnswered(second, UpdateOutcomeCommitted, "")
	if got := f.executableDigest(); got != second.buildSHA() {
		t.Errorf("the executable is %s, want the second release's build", got)
	}
}

func TestAnInstalledRecordThatIsMissingOrDamagedIsMadeAgainFromTheExecutableItself(t *testing.T) {
	for name, damage := range map[string]func(f *stepFixture){
		"missing": func(f *stepFixture) {
			if err := os.Remove(f.paths.Installed); err != nil {
				f.t.Fatal(err)
			}
		},
		"damaged": func(f *stepFixture) {
			if err := os.WriteFile(f.paths.Installed, []byte("not json"), 0o600); err != nil {
				f.t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			damage(f)
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeCommitted, "")
			// The installed build was asked its version where it is, then the new build was
			// probed from the probe directory.
			calls := f.host.probeCalls
			if len(calls) != 2 || calls[0] != f.exe || !strings.HasPrefix(calls[1], f.paths.Probe+string(os.PathSeparator)) {
				t.Errorf("the probes: %v", calls)
			}
			if record := f.installedRecord(); record.Version != "0.1.1" || record.SHA256 != release.buildSHA() {
				t.Errorf("installed.json: %+v", record)
			}
		})
	}
}

// A swap the file system refuses leaves the service stopped, and the step starts it
// again on the build that is there. A start the service manager doesn't take is no result
// of the request: the run ends with an error and the journal says swapping still, and each
// next run, which finds the old build installed, starts it again, until one does and the
// request ends as interrupted. Ending the request at a failed start would leave the host
// with no agent, because the runs that follow find an idle journal and start nothing.
func TestAStartOfTheOldBuildThatFailsAfterARefusedSwapLeavesTheJournalForTheNextRun(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	f.host.cfg.SwapFails = "rename: input/output error"
	f.host.cfg.StartFails = 3
	oldDigest := f.executableDigest()

	// The first run makes the swap that fails and starts the old build again; the two after
	// it find the journal saying swapping, as a run after a crash does.
	for run := 1; run <= 3; run++ {
		err := f.run()
		if err == nil || !strings.Contains(err.Error(), "couldn't start the agent service") || !strings.Contains(err.Error(), "the next run of the update step starts the service again") {
			t.Fatalf("run %d, which couldn't start the agent, ended with: %v", run, err)
		}
		journal, found := f.journal()
		if !found || journal.Stage != UpdateStageSwapping {
			t.Fatalf("the journal after run %d: %+v (found %v)", run, journal, found)
		}
		if got := f.executableDigest(); got != oldDigest {
			t.Errorf("the executable is %s after run %d, want the build it had, %s", got, run, oldDigest)
		}
		if state := f.service().State; state != "inactive" {
			t.Errorf("the service is %s after run %d, which couldn't start it", state, run)
		}
		if got := f.counters().HighestCounters[f.public.Fingerprint()]; got != release.counter {
			t.Errorf("the floor is %d after an attempt of counter %d", got, release.counter)
		}
		f.clock.advance(30 * time.Second)
	}

	f.mustRun()

	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	f.requireOldBuildRunning(oldDigest)
	if history := strings.Join(f.service().History, ","); history != "start 0.1.0,stop,start 0.1.0" {
		t.Errorf("the service's history: %s", history)
	}
}
