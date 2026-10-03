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
