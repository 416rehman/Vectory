//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// What a rollback needs of the clock and of the step's own file system: the previous
// build gets its five minutes from its own start, however long the build under trial
// took to stop, and the journal and the status of the rollback have room because the
// step's copy of the build is freed first.

// stagedNames lists what the step's staging directory holds.
func (f *stepFixture) stagedNames() []string {
	f.t.Helper()
	entries, err := os.ReadDir(f.paths.Staging)
	if err != nil {
		f.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// startedAt is when the service's current process began, on the machine's clock.
func (f *stepFixture) startedAt() time.Time { return time.Unix(0, f.service().Started).UTC() }

// useSilentPreviousBuild installs a build that is healthy for nothing: it runs and
// never checks in, so a rollback to it can't prove itself.
func (f *stepFixture) useSilentPreviousBuild() {
	f.t.Helper()
	f.installBuild(fakeBuild("0.1.0", "silent", "installed"))
	f.recordInstalled("0.1.0")
	f.runningBuild()
}

func TestThePreviousBuildIsWatchedFromItsOwnStartHoweverLongTheBuildUnderTrialTookToStop(t *testing.T) {
	f := newStepFixture(t)
	f.host.cfg.SlowStopOf = "0.1.2"
	f.host.saveConfig()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	began := f.clock.Now()

	f.mustRun()

	// The build under trial took the service manager's whole stop limit to stop, which
	// is longer than the five minutes the rollback had when it was decided. The previous
	// build checks in 3 s after it starts, and the rollback says it is healthy.
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if elapsed := f.status().Last.At.Sub(began); elapsed < fakeSlowStop {
		t.Fatalf("the stop didn't take the clock's %s: the rollback ended after %s", fakeSlowStop, elapsed)
	}
	health, err := ReadUpdateHealth(f.host.healthPath())
	if err != nil {
		t.Fatal(err)
	}
	if health.AgentSHA256 != oldDigest || health.CheckedInAt.Sub(f.startedAt()) != 3*time.Second {
		t.Errorf("the previous build's check-in: %+v, started %s", health, f.startedAt())
	}
	if history := strings.Join(f.service().History, ","); history != "start 0.1.0,stop,start 0.1.2,stop,start 0.1.0" {
		t.Errorf("the service's history: %s", history)
	}
}

func TestAPreviousBuildThatNeverChecksInIsStillGivenFiveMinutesAndEndsAsUnhealthy(t *testing.T) {
	f := newStepFixture(t)
	f.useSilentPreviousBuild()
	f.host.cfg.SlowStopOf = "0.1.2"
	f.host.saveConfig()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)

	f.mustRun()

	if got := f.executableDigest(); got != oldDigest {
		t.Fatalf("the executable is %s, want the previous build", got)
	}
	f.requireAnswered(release, UpdateOutcomeRolledBack, "ROLLBACK_UNHEALTHY")
	// The watch began when the previous build did and ran its five minutes, no less and
	// no more than the step's two-second look past them.
	if watched := f.status().Last.At.Sub(f.startedAt()); watched < updateTrialDuration-time.Second || watched > updateTrialDuration+10*time.Second {
		t.Errorf("the previous build was watched for %s", watched)
	}
}

// A rollback that continues after a crash may find the deadline it wrote long past:
// the previous build is given its five minutes from the moment it is started again.
func TestARollbackThatContinuesAfterItsDeadlinePassedGivesThePreviousBuildItsFiveMinutes(t *testing.T) {
	for name, c := range map[string]struct {
		silent bool
		code   string
	}{
		"a previous build that checks in":       {false, "START_FAILED"},
		"a previous build that never checks in": {true, "ROLLBACK_UNHEALTHY"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			if c.silent {
				f.useSilentPreviousBuild()
			}
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", "crash", releaseOptions{})
			f.stage(release)
			if !f.runChildUntil("rolling_back") {
				t.Fatal("the rollback never began")
			}
			journal, _ := f.journal()
			if journal.Stage != UpdateStageRollingBack || !journal.Deadline.After(f.clock.Now()) {
				t.Fatalf("the journal when the step died: %+v", journal)
			}
			f.clock.advance(time.Hour)

			f.mustRun()

			if got := f.executableDigest(); got != oldDigest {
				t.Fatalf("the executable is %s, want the previous build", got)
			}
			f.requireAnswered(release, UpdateOutcomeRolledBack, c.code)
			if c.silent {
				if watched := f.status().Last.At.Sub(f.startedAt()); watched < updateTrialDuration-time.Second || watched > updateTrialDuration+10*time.Second {
					t.Errorf("the previous build was watched for %s", watched)
				}
			}
		})
	}
}

// The new build's five minutes count from the start of its service too: a start that
// waits for the system before the process begins is no part of them.
func TestTheTrialsFiveMinutesCountFromTheStartOfTheServiceAndNotFromTheRequestToStartIt(t *testing.T) {
	f := newStepFixture(t)
	f.host.cfg.SlowStartOf = "0.1.1"
	f.host.saveConfig()
	release := f.newRelease("0.1.1", "late", releaseOptions{})
	f.stage(release)

	f.mustRun()

	// The start waited 120 s, and the build checked in 200 s after it began: 320 s after
	// the journal said trial, and well inside the five minutes the build had.
	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	if f.executableDigest() != release.buildSHA() {
		t.Error("the build wasn't kept")
	}

	// The window is still five minutes: a build that checks in after them is taken back.
	g := newStepFixture(t)
	g.host.cfg.SlowStartOf = "0.1.1"
	g.host.saveConfig()
	oldDigest := g.executableDigest()
	tooLate := g.newRelease("0.1.1", "slow", releaseOptions{})
	g.stage(tooLate)
	g.mustRun()
	g.requireTakenBack(oldDigest, tooLate, "NO_CHECK_IN")
}

func TestTheStepsCopyOfTheBuildIsRemovedBeforeTheRollbackJournalIsWritten(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	type look struct {
		stage string
		names []string
	}
	seen := map[string]look{}
	updateFault = func(point string) {
		switch point {
		case "started", "rollback:build_freed", "rolling_back":
			journal, _ := f.journal()
			seen[point] = look{journal.Stage, f.stagedNames()}
		}
	}

	f.mustRun()

	f.requireTakenBack(oldDigest, release, "START_FAILED")
	build := UpdateBuildFile(runtime.GOOS)
	if got := seen["started"]; got.stage != UpdateStageTrial || !slices.Contains(got.names, build) {
		t.Fatalf("during the trial the journal says %s and staging holds %v: there is no copy to free", got.stage, got.names)
	}
	// The copy is gone while the journal still says trial, so it is gone before the
	// journal that says rolling_back is written; the small files of the request stay
	// for the rollback to read.
	freed := seen["rollback:build_freed"]
	if freed.stage != UpdateStageTrial || slices.Contains(freed.names, build) {
		t.Errorf("when the copy was freed the journal said %s and staging held %v", freed.stage, freed.names)
	}
	for _, kept := range []string{UpdateReleaseFile, UpdateSignaturesFile, UpdateRolloversFile, updateHealthBeforeFile} {
		if !slices.Contains(freed.names, kept) {
			t.Errorf("%s was removed with the copy of the build: %v", kept, freed.names)
		}
	}
	if got := seen["rolling_back"]; got.stage != UpdateStageRollingBack || slices.Contains(got.names, build) {
		t.Errorf("when the journal said rolling_back, the journal said %s and staging held %v", got.stage, got.names)
	}
}

// Whatever else the step's directory holds, a rollback ends and leaves it empty.
func TestARollbackCompletesWhenTheStagingDirectoryHoldsMoreThanTheRequest(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point != "trial" {
			return
		}
		leftovers := filepath.Join(f.paths.Staging, "leftovers")
		if err := os.MkdirAll(filepath.Join(leftovers, "deeper"), 0o700); err != nil {
			t.Error(err)
			return
		}
		for name, size := range map[string]int{"filler": 2 << 20, "leftovers/one": 4096, "leftovers/deeper/two": 4096} {
			if err := os.WriteFile(filepath.Join(f.paths.Staging, name), make([]byte, size), 0o600); err != nil {
				t.Error(err)
			}
		}
	}

	f.mustRun()

	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if f.service().State != "active" || f.service().Version != "0.1.0" {
		t.Errorf("the host after the rollback: %+v", f.service())
	}
}

// A step killed after it freed the copy leaves a journal that still says trial and
// needs none of the copy: the trial continues once, and its end is the build's own.
func TestAStepKilledAfterItFreedTheCopyOfABuildFinishesTheTrialWhateverTheBuildDoes(t *testing.T) {
	t.Run("a build that fails again is taken back", func(t *testing.T) {
		f := newStepFixture(t)
		oldDigest := f.executableDigest()
		release := f.newRelease("0.1.2", "crash", releaseOptions{})
		f.stage(release)
		if !f.runChildUntil("rollback:build_freed") {
			t.Fatal("the rollback never freed the copy")
		}
		if journal, _ := f.journal(); journal.Stage != UpdateStageTrial {
			t.Fatalf("the journal when the step died: %+v", journal)
		}
		if slices.Contains(f.stagedNames(), UpdateBuildFile(runtime.GOOS)) {
			t.Fatal("the copy was there when the step died")
		}
		f.clock.advance(30 * time.Second)
		f.mustRun()
		f.requireTakenBack(oldDigest, release, "START_FAILED")
	})
	t.Run("a build that checks in during the continued trial is kept", func(t *testing.T) {
		f := newStepFixture(t)
		// It checks in 400 s after it starts: after the first trial's five minutes, and
		// inside the continued one.
		release := f.newRelease("0.1.2", "slow", releaseOptions{})
		f.stage(release)
		if !f.runChildUntil("rollback:build_freed") {
			t.Fatal("the rollback never freed the copy")
		}
		f.clock.advance(30 * time.Second)
		f.mustRun()
		f.requireAnswered(release, UpdateOutcomeCommitted, "")
		if got := f.executableDigest(); got != release.buildSHA() {
			t.Fatalf("the executable is %s, want the build that checked in", got)
		}
		if got := fileDigest(t, f.paths.HelperExecutable); got != release.buildSHA() {
			t.Errorf("the helper copy is %s", got)
		}
		if !f.stagingEmpty() {
			t.Errorf("staging still holds %v", f.stagedNames())
		}
	})
}

// ---------------------------------------------------------------- a start the service manager doesn't take

// requireRollbackWaitingForAStart says the rollback put the previous build back and
// couldn't start it: nothing ended, the journal and the status say the rollback is going
// on, the files of the request are still there, and the agent isn't running.
func (f *stepFixture) requireRollbackWaitingForAStart(oldDigest string, release *fakeRelease) {
	f.t.Helper()
	journal, found := f.journal()
	if !found || journal.Stage != UpdateStageRollingBack || journal.Code != "START_FAILED" {
		f.t.Fatalf("the journal of a rollback that couldn't start the previous build: %+v (found %v)", journal, found)
	}
	if got := f.executableDigest(); got != oldDigest {
		f.t.Errorf("the executable is %s, the rollback had put the previous build %s back", got, oldDigest)
	}
	if status := f.status(); status.Stage != UpdateStageRollingBack || (status.Last != nil && status.Last.Release == release.manifestSHA()) {
		f.t.Errorf("the status: stage %s, last %+v", status.Stage, status.Last)
	}
	if f.service().State != "inactive" {
		f.t.Errorf("the service after a start that failed: %+v", f.service())
	}
	if f.stagingEmpty() {
		f.t.Error("the staging directory was emptied before the request ended")
	}
}

// A start the service manager doesn't take says nothing about the previous build, which
// nobody has seen run: the rollback is not over, and the request doesn't end as
// ROLLBACK_UNHEALTHY. Each run, every 30 seconds, ends with an error and leaves the journal
// saying rolling_back, and the first run that starts the previous build ends the request
// with the result of a build that ran. Ending it at the first failure would leave the
// host with no agent, because the runs that follow find an idle journal and start nothing.
func TestARollbackWhoseStartFailsLeavesTheJournalRollingBackAndEachRunStartsThePreviousBuildAgain(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	armed := false
	updateFault = func(point string) {
		// After the trial's own start, which worked: the next two starts fail.
		if point == "rollback:restored" && !armed {
			armed = true
			f.host.cfg.StartFails = 2
		}
	}

	for run := 1; run <= 2; run++ {
		err := f.run()
		if err == nil || !strings.Contains(err.Error(), "couldn't start the previous build") || !strings.Contains(err.Error(), "the next run of the update step starts it again") {
			t.Fatalf("run %d, which couldn't start the previous build, ended with: %v", run, err)
		}
		f.requireRollbackWaitingForAStart(oldDigest, release)
		f.clock.advance(30 * time.Second)
	}

	f.mustRun()

	f.requireTakenBack(oldDigest, release, "START_FAILED")
	service := f.service()
	if service.Version != "0.1.0" || service.State != "active" {
		t.Errorf("the host after the rollback: %+v", service)
	}
	if starts := strings.Count(strings.Join(service.History, ","), "start 0.1.0"); starts != 2 {
		t.Errorf("the previous build was started %d times in all (the first before the update, and one after the starts that failed): %v", starts, service.History)
	}
}

// A rollback whose stop fails has put nothing back and started nothing. The build that
// is being taken back may still be running, and the previous build, which isn't in place
// and never ran, says nothing: ending the request there would record a rollback to a
// build that doesn't run, with the words "didn't report healthy within 5 minutes of its
// start" about a build nobody started, while the build that was taken back keeps
// running. The run ends with an error, the journal says rolling_back, the files of the
// request stay, and the next run that can stop the service puts the previous build back,
// starts it and ends the request with the result of a build that ran.
func TestARollbackWhoseStopFailsStaysOpenWhileTheBuildBeingTakenBackRunsAndTheNextRunFinishesIt(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.3", "silent", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point == "rolling_back" {
			f.host.cfg.StopFails = true
		}
	}

	// Two hours of runs while the service won't stop: well past the five minutes a
	// rollback is watched for.
	for i := 0; i < 240; i++ {
		err := f.run()
		if err == nil || !strings.Contains(err.Error(), "couldn't stop the agent service") || !strings.Contains(err.Error(), "the next run of the update step stops it again") {
			t.Fatalf("run %d, which couldn't stop the service, ended with: %v", i+1, err)
		}
		f.clock.advance(30 * time.Second)
	}

	journal, found := f.journal()
	if !found || journal.Stage != UpdateStageRollingBack || journal.Code != "NO_CHECK_IN" {
		t.Fatalf("the journal of a rollback that couldn't stop the build it takes back: %+v (found %v)", journal, found)
	}
	if got := f.executableDigest(); got != release.buildSHA() {
		t.Errorf("the executable is %s: the previous build was put over a build that still runs", got)
	}
	if service := f.service(); service.Version != "0.1.3" || service.State != "active" {
		t.Errorf("the service: %+v", service)
	}
	if status := f.status(); status.Stage != UpdateStageRollingBack || (status.Last != nil && status.Last.Release == release.manifestSHA()) {
		t.Errorf("the status says the request is over: stage %s, last %+v", status.Stage, status.Last)
	}
	if f.stagingEmpty() {
		t.Error("the staging directory was emptied before the request ended")
	}
	if history := strings.Join(f.service().History, ","); history != "start 0.1.0,stop,start 0.1.3" {
		t.Errorf("the service was touched while it couldn't be stopped: %s", history)
	}

	f.host.cfg.StopFails = false
	f.mustRun()

	f.requireTakenBack(oldDigest, release, "NO_CHECK_IN")
	service := f.service()
	if service.Version != "0.1.0" || service.State != "active" {
		t.Errorf("the host after the rollback: %+v", service)
	}
	if history := strings.Join(service.History, ","); history != "start 0.1.0,stop,start 0.1.3,stop,start 0.1.0" {
		t.Errorf("the service's history: %s", history)
	}
}

// A rollback whose start keeps failing never turns into the end of the request by
// itself, however long it lasts: the step has nothing but the next run to offer, and
// it offers it for as long as it takes.
func TestARollbackWhoseStartKeepsFailingNeverEndsTheRequest(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	armed := false
	updateFault = func(point string) {
		if point == "rollback:restored" && !armed {
			armed = true
			f.host.cfg.StartFails = 1000
		}
	}

	// Two hours of runs, 30 seconds apart: well past the five minutes a rollback is
	// watched for, and past the deadline the journal carries.
	for i := 0; i < 240; i++ {
		if err := f.run(); err == nil {
			t.Fatalf("run %d didn't fail although the service manager takes no start", i+1)
		}
		f.clock.advance(30 * time.Second)
	}
	f.requireRollbackWaitingForAStart(oldDigest, release)

	f.host.cfg.StartFails = 0
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
}
