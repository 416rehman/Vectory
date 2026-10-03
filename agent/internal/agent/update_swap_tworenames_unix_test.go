//go:build !windows

package agent

import (
	"path/filepath"
	"testing"
	"time"
)

// The step on a machine whose swap has two renames, the way Windows has, run for
// real: the step is the real one, killed with SIGKILL at every boundary in another
// process, and the machine is the simulated one of the other step tests with its
// install directory swapping in two renames over the Unix primitives (the sequence
// is twoRenames, the code Windows runs over MoveFileEx). What is checked is the
// reconciler's recovery from the one state a Unix swap never leaves: no executable,
// with the build that was installed beside it under the name the journal gives.

func newTwoRenamesFixture(t *testing.T) *stepFixture {
	t.Helper()
	f := newStepFixture(t)
	f.host.cfg.TwoRenames = true
	f.host.saveConfig()
	return f
}

// twoRenamesBoundaries are the boundaries of a good update that a two-rename swap
// has: those of a swap that makes a link and syncs a directory are not there.
func twoRenamesBoundaries() []killRow {
	var rows []killRow
	for _, row := range goodUpdateBoundaries {
		if row.point != "swap:linked" && row.point != "swap:synced" {
			rows = append(rows, row)
		}
	}
	return rows
}

func TestKillingTheStepAtEveryBoundaryOfATwoRenameUpdateLeavesAnExecutableOrTheBuildThatWasInstalledBesideIt(t *testing.T) {
	for _, row := range twoRenamesBoundaries() {
		// Between the two renames there is no executable.
		gap := row.point == "swap:previous_kept"
		t.Run(row.point, func(t *testing.T) { checkKillAtBoundary(t, newTwoRenamesFixture, row, gap) })
	}
}

func TestKillingTheStepAtEveryBoundaryOfATwoRenameRollbackStillEndsOnThePreviousBuild(t *testing.T) {
	for _, point := range append([]string{"trial", "started"}, rollbackBoundaries...) {
		t.Run(point, func(t *testing.T) { checkKillDuringRollback(t, newTwoRenamesFixture, point, false) })
	}
	// The two renames of a restore: the build under trial steps aside, and the previous
	// one takes its place. Between them there is no executable.
	t.Run("restore:aside", func(t *testing.T) { checkKillDuringRollback(t, newTwoRenamesFixture, "restore:aside", true) })
	t.Run("restore:renamed", func(t *testing.T) { checkKillDuringRollback(t, newTwoRenamesFixture, "restore:renamed", false) })
}

func TestATwoRenameUpdateCommitsAndKeepsThePreviousBuildBesideTheExecutable(t *testing.T) {
	f := newTwoRenamesFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	if f.executableDigest() != release.buildSHA() {
		t.Fatal("the executable isn't the new build")
	}
	if got := fileDigest(t, filepath.Join(f.installDir, updatePreviousName)); got != oldDigest {
		t.Errorf("the build kept beside the executable is %s, want the one that was installed, %s", got, oldDigest)
	}
	if beside := f.beside(); len(beside) != 1 || beside[0] != updatePreviousName {
		t.Errorf("beside the executable: %v", beside)
	}
	journal, found := f.journal()
	if !found || journal.Swap == nil || journal.Swap.Style != updateSwapTwoRenames || journal.Swap.Previous != updatePreviousName || journal.Swap.Staged != ".vectory-update-7" {
		t.Errorf("the journal's swap: %+v", journal.Swap)
	}
	if got := fileDigest(t, f.paths.HelperExecutable); got != release.buildSHA() {
		t.Errorf("the helper copy is %s", got)
	}
}

func TestATwoRenameUpdateThatNeverStartsIsTakenBackWithNothingLeftBesideTheExecutable(t *testing.T) {
	f := newTwoRenamesFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
}

// A second update replaces the build kept from the first: the executable that was
// installed steps onto its name, and what was there is gone.
func TestASecondTwoRenameUpdateReplacesThePreviousBuildTheFirstKept(t *testing.T) {
	f := newTwoRenamesFixture(t)
	first := f.newRelease("0.1.1", "good", releaseOptions{counter: 7})
	f.stage(first)
	f.mustRun()
	f.requireAnswered(first, UpdateOutcomeCommitted, "")
	f.clock.advance(time.Hour)
	second := f.newRelease("0.1.2", "good", releaseOptions{counter: 8})
	f.stage(second)
	f.mustRun()
	f.requireAnswered(second, UpdateOutcomeCommitted, "")
	if f.executableDigest() != second.buildSHA() {
		t.Fatal("the executable isn't the second build")
	}
	if got := fileDigest(t, filepath.Join(f.installDir, updatePreviousName)); got != first.buildSHA() {
		t.Errorf("the build kept beside the executable is %s, want the first update's, %s", got, first.buildSHA())
	}
}
