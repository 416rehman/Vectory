//go:build !windows

package agent

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// A rollback that has put the previous build back and can't start it is held open: the
// step tries again at every run, for as long as it takes. A service that can never start
// (its job disabled, its unit masked) would keep the person who turns updates off, or
// removes the service, waiting for ever, with words that give a time that moves on. Removing
// the step, and `update off`, end such a rollback as the step ends an update interrupted after
// the swap, and then remove what they remove. A rollback that hasn't put the previous build
// back is still refused: the step has it to put in place, and says what it is. So is one whose
// agent service isn't registered (its definition, unit or service removed by hand), because
// the step can't tell where the previous build is, and the words say what registers the
// service again (update_removal_registration_test.go).

// removalWatcher is the macOS fixture's host that looks at what the step's files say at the
// moment its units are removed: after the removal has ended the rollback, before the
// directory goes.
type removalWatcher struct {
	*launchdHost
	atRemoval func()
}

func (w *removalWatcher) RemoveUnits() (string, bool, error) {
	w.atRemoval()
	return w.launchdHost.RemoveUnits()
}

// heldRollback drives the step into a rollback whose start can never be made: launchd
// refuses every bootstrap of the agent's job for a thousand hours, as it does for a job an
// administrator disabled. Every run of the step after that is a new process, and ends with an
// error.
func heldRollback(t *testing.T) (f *stepFixture, machine *launchdOverMachine, release *fakeRelease, oldDigest string) {
	t.Helper()
	f = newStepFixture(t)
	machine, _ = f.useLaunchd()
	oldDigest = f.executableDigest()
	release = f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point == "rolling_back" {
			machine.refuseUntil = f.clock.Now().Add(1000 * time.Hour)
		}
	}
	if err := f.run(); err == nil {
		t.Fatal("the run that couldn't start the previous build ended without an error")
	}
	updateFault = nil
	for i := 0; i < 6; i++ {
		f.clock.advance(30 * time.Second)
		f.anotherStepProcess(machine)
		if err := f.run(); err == nil {
			t.Fatalf("run %d started the previous build", i+2)
		}
	}
	journal, found := f.journal()
	if !found || journal.Stage != UpdateStageRollingBack || journal.From == nil || f.executableDigest() != journal.From.SHA256 {
		t.Fatalf("the journal of a rollback that can't start the previous build: %+v (found %v)", journal, found)
	}
	if f.service().State != "inactive" {
		t.Fatalf("the service of a rollback that can't start the previous build: %+v", f.service())
	}
	return f, machine, release, oldDigest
}

// watchRemoval makes the next removal record what the step's journal, status and floors
// say when the units go.
func watchRemoval(f *stepFixture, into *removalSeen) {
	host := updateHostOverride.(*launchdHost)
	updateHostOverride = &removalWatcher{launchdHost: host, atRemoval: func() {
		into.journal, into.found = f.journal()
		into.status = f.status()
		into.counters = f.counters()
		into.called = true
	}}
}

type removalSeen struct {
	called   bool
	journal  updateJournal
	found    bool
	status   UpdateStatus
	counters updateCounters
}

// requireTheRollbackEnded says the step's files, at the moment its units were removed, record
// the end of the rollback as the step records an update interrupted after the swap: rolled
// back, INTERRUPTED, from and to the versions of the update, the floors as they were.
func requireTheRollbackEnded(t *testing.T, f *stepFixture, release *fakeRelease, seen removalSeen, floorsBefore updateCounters) {
	t.Helper()
	if !seen.called {
		t.Fatal("the units were never removed")
	}
	if !seen.found || seen.journal.Stage != updateJournalRolledBack || seen.journal.Code != "INTERRUPTED" || seen.journal.FinishedAt.IsZero() {
		t.Errorf("the journal when the units went: %+v (found %v)", seen.journal, seen.found)
	}
	last := seen.status.Last
	if seen.status.Stage != UpdateStageIdle || last == nil || last.Release != release.manifestSHA() || last.Outcome != UpdateOutcomeRolledBack || last.Code != "INTERRUPTED" || last.FromVersion != "0.1.0" || last.ToVersion != "0.1.2" {
		t.Errorf("the status when the units went: stage %s, last %+v", seen.status.Stage, last)
	}
	if got, want := seen.counters.HighestCounters[f.public.Fingerprint()], floorsBefore.HighestCounters[f.public.Fingerprint()]; got != want || got != release.counter {
		t.Errorf("the floor is %d when the units went; it was %d, and the release's counter is %d: the release must stay tried", got, want, release.counter)
	}
}

func TestRemovingTheStepEndsARollbackThatCanNeverStartThePreviousBuild(t *testing.T) {
	f, machine, release, oldDigest := heldRollback(t)
	before := f.counters()
	var seen removalSeen
	watchRemoval(f, &seen)
	launchctlBefore := len(machine.calls)

	if err := RemoveUpdateHelper(); err != nil {
		t.Fatalf("removing the step while the rollback waits for a start that never comes: %v", err)
	}

	requireTheRollbackEnded(t, f, release, seen, before)
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
	if got := f.executableDigest(); got != oldDigest {
		t.Errorf("the executable is %s: the previous build is the one that stays", got)
	}
	// Ending the rollback asks launchd for nothing: the person who removes the step is the one
	// to start the agent's service.
	for _, call := range machine.calls[launchctlBefore:] {
		if strings.HasPrefix(call, "bootstrap ") || strings.HasPrefix(call, "bootout ") || strings.HasPrefix(call, "kickstart ") {
			t.Errorf("the removal asked launchd: %s", call)
		}
	}
}

func TestTurningUpdatesOffEndsARollbackThatCanNeverStartThePreviousBuildAndSaysSo(t *testing.T) {
	f, _, release, oldDigest := heldRollback(t)
	before := f.counters()
	var seen removalSeen
	watchRemoval(f, &seen)

	done, err := WithdrawUpdates(f.stateDir)
	if err != nil {
		t.Fatalf("turning updates off while the rollback waits for a start that never comes: %v", err)
	}

	if !done.PolicyOff || !done.StepRemoved || !done.RollbackEnded {
		t.Errorf("what the withdrawal did: %+v", done)
	}
	if parts := strings.Join(done.Parts(), ", "); !strings.HasSuffix(parts, "the update step is removed, the rollback that was waiting for the agent's service to start is over") {
		t.Errorf("the withdrawal says %q", parts)
	}
	requireTheRollbackEnded(t, f, release, seen, before)
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
	if f.executableDigest() != oldDigest {
		t.Error("the executable changed")
	}
	if policy := f.policy(); policy.Consent != UpdateConsentOff {
		t.Errorf("the policy after turning updates off: %+v", policy)
	}
}

// restoreTheExchange makes the directory the running agent keeps its offer and its health in,
// which turning updates off deleted: an agent that runs makes it again.
func restoreTheExchange(f *stepFixture) {
	f.t.Helper()
	updates := UpdateExchangeFor(f.stateDir).Dir
	mkdirMode(f.t, updates, 0o700)
	if os.Geteuid() == 0 {
		if err := os.Chown(updates, int(f.host.account.UID), int(f.host.account.GID)); err != nil {
			f.t.Fatal(err)
		}
	}
}

// What `update off` says it ended is what the removal did, and not what the advice it took before
// it changed anything expected: a run of the step that starts the previous build and ends the
// rollback itself in between leaves nothing for the removal to end, and a person is not told that
// nothing will try to start the agent's service when the step has started it.
func TestTurningUpdatesOffSaysItEndedARollbackOnlyWhenTheRemovalEndedIt(t *testing.T) {
	f, machine, _, _ := heldRollback(t)

	done, err := withdrawUpdatesReporting(f.stateDir, func() (bool, error) {
		// The step's next run began after the advice: the person had just enabled the job, the
		// start worked, and the run watched the previous build to the end.
		machine.refuseUntil = time.Time{}
		restoreTheExchange(f)
		f.clock.advance(30 * time.Second)
		f.anotherStepProcess(machine)
		if err := f.run(); err != nil {
			t.Fatalf("the step's run in between: %v", err)
		}
		if journal, found := f.journal(); !found || journal.Stage != updateJournalRolledBack {
			t.Fatalf("the journal after the step's run: %+v (found %v)", journal, found)
		}
		return removeStepReporting(removalUpdateHost())
	})

	if err != nil || !done.StepRemoved {
		t.Fatalf("turning updates off: %+v, %v", done, err)
	}
	if done.RollbackEnded {
		t.Errorf("update off says the rollback that was waiting for a start is over and nothing will try again, although the step had started the previous build and ended the rollback itself: %+v", done)
	}
	if parts := strings.Join(done.Parts(), ", "); strings.Contains(parts, "rollback") {
		t.Errorf("the withdrawal says %q", parts)
	}
}

// The advice `update off` takes before it changes anything can be out of date by the time the
// removal decides under the lock: a run of the step that starts the previous build in between
// makes the removal refuse after the policy was turned off and the staged build deleted. What the
// withdrawal answers then says what was done, so that the command can say it and say that running
// it again finishes the removal, which it does.
func TestTurningUpdatesOffThatIsRefusedAfterItChangedThingsSaysWhatWasDoneAndRunningItAgainFinishesTheRemoval(t *testing.T) {
	f, machine, _, _ := heldRollback(t)
	staged := UpdateExchangeFor(f.stateDir).Dir
	if !exists(staged) {
		t.Fatal("nothing is staged, so the test shows nothing")
	}
	var held func()

	done, err := withdrawUpdates(f.stateDir, func() error {
		// The step's next run began after the advice: the person had just enabled the job, the
		// start worked, and the run is watching the previous build, holding the lock.
		machine.refuseUntil = time.Time{}
		machine.loaded = true
		running := f.service()
		running.State, running.Started, running.Starts = "active", f.clock.Now().UnixNano(), running.Starts+1
		f.host.saveService(running)
		release, lockErr := f.host.Lock(f.openPrivate())
		if lockErr != nil {
			return lockErr
		}
		held = release
		return RemoveUpdateHelper()
	})
	if held != nil {
		held()
	}

	if err == nil || !strings.Contains(err.Error(), "the update step is working now") {
		t.Fatalf("turning updates off while a run holds the lock: %v", err)
	}
	if !done.PolicyOff || !done.Discarded || done.StepRemoved {
		t.Errorf("what the withdrawal did before the removal refused: %+v", done)
	}
	if want := "Done so far: the policy says off, the staged build is deleted."; done.saved() != want {
		t.Errorf("the withdrawal says it did %q, want %q", done.saved(), want)
	}
	if f.policy().Consent != UpdateConsentOff {
		t.Error("the policy doesn't say off")
	}
	if exists(staged) {
		t.Error("the staged build is still there")
	}

	// The run has ended. Running the command again finishes the removal.
	again, err := WithdrawUpdates(f.stateDir)
	if err != nil || !again.StepRemoved {
		t.Fatalf("running the command again: %+v, %v", again, err)
	}
	if _, statErr := os.Lstat(f.paths.StepDir); statErr == nil {
		t.Error("the step's directory is still there")
	}
}

// A withdrawal that has nothing to end doesn't say it did.
func TestTurningUpdatesOffDoesNotSayItEndedARollbackThatWasNotThere(t *testing.T) {
	f := newStepFixture(t)
	done, err := WithdrawUpdates(f.stateDir)
	if err != nil || done.RollbackEnded || !done.StepRemoved {
		t.Fatalf("%+v %v", done, err)
	}
	if strings.Contains(strings.Join(done.Parts(), ", "), "rollback") {
		t.Errorf("the withdrawal says %q", strings.Join(done.Parts(), ", "))
	}
}

// A rollback that has not put the previous build back is mid-way. The step's next run still
// has the previous build to put in place and to start, and removing the step would leave the
// host on a build nobody proved: it is refused, with words that say what the rollback is and
// when it is over, and no time, because none is known. Nothing changes, and the step goes on
// and finishes it.
func TestARollbackThatHasNotPutThePreviousBuildBackIsRefusedByTheRemovalAndByTurningUpdatesOff(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil("rollback:stopped") {
		t.Fatal("the rollback never stopped the service")
	}
	if journal, _ := f.journal(); journal.Stage != UpdateStageRollingBack || f.executableDigest() != release.buildSHA() {
		t.Fatalf("the rollback should be mid-way: journal %+v, executable %s", journal, f.executableDigest())
	}
	units := len(f.host.unitsCalls)
	policy := f.snapshot().policy

	if err := RemoveUpdateHelper(); err == nil || err.Error() != rollbackBusyWords {
		t.Errorf("removing the step: %v", err)
	}
	done, err := WithdrawUpdates(f.stateDir)
	var busy *UpdateBusyError
	if err == nil || !errors.As(err, &busy) || busy.Message != rollbackBusyWords {
		t.Errorf("turning updates off: %+v, %v", done, err)
	}
	for _, wrong := range []string{"takes a few minutes", "ends by", "ends within"} {
		if strings.Contains(rollbackBusyWords, wrong) {
			t.Errorf("the words for a rollback give a time that isn't known: %q", rollbackBusyWords)
		}
	}
	for _, right := range []string{"puts the previous build back and starts it", "every 30 seconds", "watches it for up to 5 minutes"} {
		if !strings.Contains(rollbackBusyWords, right) {
			t.Errorf("the words for a rollback don't say %q: %q", right, rollbackBusyWords)
		}
	}
	if _, statErr := os.Lstat(f.paths.StepDir); statErr != nil {
		t.Error("the step's directory was removed")
	}
	if len(f.host.unitsCalls) != units {
		t.Errorf("the units were touched: %v", f.host.unitsCalls)
	}
	if got := f.snapshot().policy; string(got) != string(policy) {
		t.Errorf("turning updates off changed the policy before it was refused:\n%s\nwas\n%s", got, policy)
	}
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageRollingBack {
		t.Errorf("the journal: %+v (found %v)", journal, found)
	}

	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
}

// releasingClock is the fixture's clock, which lets go of a lock that a run of the step
// holds when the time it was meant to be held until has come.
type releasingClock struct {
	*fakeClock
	until   time.Time
	release func()
}

func (c *releasingClock) Sleep(ctx context.Context, d time.Duration) error {
	err := c.fakeClock.Sleep(ctx, d)
	if c.release != nil && !c.Now().Before(c.until) {
		c.release()
		c.release = nil
	}
	return err
}

// holdTheLockFor takes the step's lock, as a run of the step does, and lets go of it when the
// clock has moved on by d. Nothing moves the clock but those who wait.
func holdTheLockFor(f *stepFixture, d time.Duration) {
	f.t.Helper()
	release, err := f.host.Lock(f.openPrivate())
	if err != nil {
		f.t.Fatal(err)
	}
	updateClockOverride = &releasingClock{fakeClock: f.clock, until: f.clock.Now().Add(d), release: release}
}

// A run of the step that is trying to start the previous build holds the step's lock for most
// of a minute on a Mac (a start that launchd refuses is tried again for a minute), and the
// timer's next run begins on its own beat: a removal that tried the lock once would be told
// that the step is working most of the time. It waits for the run to end, and then ends the
// rollback.
func TestTheRemovalWaitsForTheRunThatIsTryingToStartThePreviousBuildAndThenEndsTheRollback(t *testing.T) {
	for name, remove := range map[string]func(*stepFixture) error{
		"turning updates off": func(f *stepFixture) error { _, err := WithdrawUpdates(f.stateDir); return err },
		"removing the step":   func(*stepFixture) error { return RemoveUpdateHelper() },
	} {
		t.Run(name, func(t *testing.T) {
			f, _, release, _ := heldRollback(t)
			before := f.counters()
			var seen removalSeen
			watchRemoval(f, &seen)
			start := f.clock.Now()
			holdTheLockFor(f, 62*time.Second)

			if err := remove(f); err != nil {
				t.Fatalf("%s while a run of the step was trying to start the previous build: %v", name, err)
			}

			requireTheRollbackEnded(t, f, release, seen, before)
			if waited := f.clock.Now().Sub(start); waited < 62*time.Second || waited >= removalLockWait {
				t.Errorf("it waited %s for a run that held the lock for 62 seconds", waited)
			}
		})
	}
}

// A run that keeps the lock for longer than the removal waits is working, and the removal
// says so. Turning updates off says it before it changes anything, so that a command that
// is refused is a command that did nothing.
func TestTurningUpdatesOffIsRefusedWithNothingChangedWhenTheRunKeepsTheLockForTheWholeWait(t *testing.T) {
	f, _, _, _ := heldRollback(t)
	policy := f.snapshot().policy
	start := f.clock.Now()
	holdTheLockFor(f, 1000*time.Hour)

	done, err := WithdrawUpdates(f.stateDir)
	var busy *UpdateBusyError
	if !errors.As(err, &busy) || busy.Message != rollbackBusyWords {
		t.Fatalf("turning updates off while the step keeps its lock: %+v, %v", done, err)
	}
	if waited := f.clock.Now().Sub(start); waited < removalLockWait {
		t.Errorf("it gave up after %s, and the run may still have been about to end", waited)
	}
	if _, statErr := os.Lstat(f.paths.StepDir); statErr != nil {
		t.Error("the step's directory was removed")
	}
	if got := f.snapshot().policy; string(got) != string(policy) {
		t.Errorf("turning updates off changed the policy before it was refused:\n%s\nwas\n%s", got, policy)
	}
	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), "the update step is working now") {
		t.Errorf("removing the step while it keeps its lock: %v", err)
	}
}

// A previous build that did start is watched by a run that lasts up to five minutes. That
// run isn't trying to start anything, and the removal doesn't wait for it: it says at once that
// the rollback is under way, and changes nothing.
func TestTheRemovalDoesNotWaitForTheRunThatIsWatchingThePreviousBuildItStarted(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil("rollback:started") {
		t.Fatal("the rollback never started the previous build")
	}
	if service := f.service(); service.Version != "0.1.0" || service.State != "active" {
		t.Fatalf("the service after the previous build was started: %+v", service)
	}
	policy := f.snapshot().policy
	start := f.clock.Now()
	held, err := f.host.Lock(f.openPrivate())
	if err != nil {
		t.Fatal(err)
	}
	defer held()

	done, err := WithdrawUpdates(f.stateDir)
	var busy *UpdateBusyError
	if !errors.As(err, &busy) || busy.Message != rollbackBusyWords {
		t.Errorf("turning updates off while the step watches the previous build: %+v, %v", done, err)
	}
	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), "the update step is working now") {
		t.Errorf("removing the step while it watches the previous build: %v", err)
	}
	if !f.clock.Now().Equal(start) {
		t.Errorf("the removal waited %s for a run that was watching a build that runs", f.clock.Now().Sub(start))
	}
	if got := f.snapshot().policy; string(got) != string(policy) {
		t.Errorf("the policy changed:\n%s\nwas\n%s", got, policy)
	}
	if _, statErr := os.Lstat(f.paths.StepDir); statErr != nil {
		t.Error("the step's directory was removed")
	}
}

// A previous build that starts and ends again isn't one that runs when the removal looks: the
// service manager shows its job as waiting for its next start, which the step reads as activating.
// The run that holds the lock is watching it, and the removal waits for that run as it does for one
// that is trying to start the build, and doesn't say at once that the step is working, as it does
// for a build that runs (above).
func TestTheRemovalWaitsForTheRunThatIsWatchingAPreviousBuildThatKeepsEndingAndBeingStartedAgain(t *testing.T) {
	f := newStepFixture(t)
	f.writeJournal(UpdateStageRollingBack, nil)
	crashing := f.service()
	crashing.State, crashing.Behavior, crashing.Started = "activating", "crash", f.clock.Now().UnixNano()
	f.host.saveService(crashing)
	if state, err := f.host.ServiceState(context.Background()); err != nil || state.State != "activating" {
		t.Fatalf("the service of a build that keeps ending: %+v, %v", state, err)
	}
	start := f.clock.Now()
	holdTheLockFor(f, 62*time.Second)

	if err := RemoveUpdateHelper(); err != nil {
		t.Fatalf("removing the step while a run watches a previous build that keeps ending: %v", err)
	}
	if waited := f.clock.Now().Sub(start); waited < 62*time.Second || waited >= removalLockWait {
		t.Errorf("it waited %s for a run that held the lock for 62 seconds", waited)
	}
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
}

// Only a rollback that waits for a start is waited for: the removal of the step meets a run
// of any other kind as it always did, at once.
func TestTheRemovalDoesNotWaitForARunWhenNoRollbackIsWaitingForAStart(t *testing.T) {
	f := newStepFixture(t)
	f.writeJournal(UpdateStageTrial, func(j *updateJournal) { j.Deadline = f.clock.Now().Add(4 * time.Minute) })
	start := f.clock.Now()
	held, err := f.host.Lock(f.openPrivate())
	if err != nil {
		t.Fatal(err)
	}
	defer held()

	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), "the update step is working now") {
		t.Errorf("removing the step while a trial is being watched: %v", err)
	}
	if !f.clock.Now().Equal(start) {
		t.Errorf("the removal waited %s for the run of a trial", f.clock.Now().Sub(start))
	}
}

// The words for a rollback are the same wherever a person meets them, and name no time:
// the deadline in the journal of a rollback is set again each time it has passed while the
// previous build still can't be started, so a time taken from it would move on for ever.
func TestInstallingTheStepWhileARollbackIsUnderWaySaysWhatItIsAndNamesNoTime(t *testing.T) {
	f := newStepFixture(t)
	f.writeJournal(UpdateStageRollingBack, func(j *updateJournal) { j.Deadline = f.clock.Now().Add(4 * time.Minute) })
	err := InstallUpdateHelper(f.stateDir, f.exe)
	if err == nil || err.Error() != rollbackBusyWords {
		t.Errorf("installing the step during a rollback: %v", err)
	}
	f.writeJournal(UpdateStageTrial, func(j *updateJournal) { j.Deadline = f.clock.Now().Add(4 * time.Minute) })
	err = InstallUpdateHelper(f.stateDir, f.exe)
	if err == nil || !strings.Contains(err.Error(), "an update is being tried; it ends by ") {
		t.Errorf("installing the step during a trial: %v", err)
	}
}

// What a rollback is waiting for is the same on every system's step, so the refusal is: it
// is the shared words, not a platform's.
func TestTheWordsForARollbackInProgressAreTheStatusesAndTheJournalsAlike(t *testing.T) {
	for stage, words := range map[string]string{UpdateStageRollingBack: rollbackBusyWords, UpdateStageSwapping: swapBusyWords} {
		status := UpdateStatus{Stage: stage, Deadline: time.Now().Add(time.Minute)}
		journal := updateJournal{Stage: stage, Deadline: time.Now().Add(time.Minute)}
		if err := updateStageBusy(status); err == nil || err.Error() != words {
			t.Errorf("%s, the status: %v", stage, err)
		}
		if err := errUpdateInProgress(journal); err == nil || err.Error() != words {
			t.Errorf("%s, the journal: %v", stage, err)
		}
		// Either can be held open by a service manager that won't stop or start the agent, so
		// neither gives a time, and both say what the step does and how often it tries.
		for _, wrong := range []string{"takes a few minutes", "ends by", "ends within"} {
			if strings.Contains(words, wrong) {
				t.Errorf("%s: the words give a time that isn't known: %q", stage, words)
			}
		}
		if !strings.Contains(words, "every 30 seconds") {
			t.Errorf("%s: the words don't say how often the step tries: %q", stage, words)
		}
	}
}
