//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// requireTakenBack says the update was rolled back: the previous build is the
// executable again, the floor stays raised, the result says why, and the files
// of the request are gone.
func (f *stepFixture) requireTakenBack(oldDigest string, release *fakeRelease, code string) {
	f.t.Helper()
	if got := f.executableDigest(); got != oldDigest {
		f.t.Fatalf("the executable is %s after a rollback, want the previous build %s", got, oldDigest)
	}
	f.requireAnswered(release, UpdateOutcomeRolledBack, code)
	journal, found := f.journal()
	if !found || journal.Stage != updateJournalRolledBack || journal.Code != code || journal.FinishedAt.IsZero() {
		f.t.Fatalf("the journal after a rollback: %+v (found %v)", journal, found)
	}
	if floors := f.counters().HighestCounters; floors[f.public.Fingerprint()] < release.counter {
		f.t.Errorf("the floor %v was lowered by the rollback below %d", floors, release.counter)
	}
	if !f.stagingEmpty() {
		f.t.Error("the staging directory still holds the request's files")
	}
	if beside := f.beside(); len(beside) != 0 {
		f.t.Errorf("files are left beside the executable after a rollback: %v", beside)
	}
	if got := fileDigest(f.t, f.paths.HelperExecutable); got == release.buildSHA() {
		f.t.Error("the helper copy became the build that was rolled back")
	}
}

func TestABuildThatCannotStartIsTakenBackWithoutWaitingForTheDeadline(t *testing.T) {
	for behavior, limit := range map[string]time.Duration{"crash": 30 * time.Second, "fail": 10 * time.Second, "exit": 10 * time.Second} {
		t.Run(behavior, func(t *testing.T) {
			f := newStepFixture(t)
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", behavior, releaseOptions{})
			f.stage(release)
			started := f.clock.Now()
			f.mustRun()
			f.requireTakenBack(oldDigest, release, "START_FAILED")
			if elapsed := f.clock.Now().Sub(started); elapsed > limit {
				t.Errorf("the rollback took %s of the five minutes", elapsed)
			}
			service := f.service()
			if got := strings.Join(service.History, ","); got != "start 0.1.0,stop,start 0.1.2,stop,start 0.1.0" {
				t.Errorf("the service's history: %s", got)
			}
			if service.Version != "0.1.0" || service.State != "active" {
				t.Errorf("the service after the rollback: %+v", service)
			}
			status := f.status()
			if status.Last.FromVersion != "0.1.0" || status.Last.ToVersion != "0.1.2" || status.Last.FirstCheckInMS != nil {
				t.Errorf("the result: %+v", status.Last)
			}
			if record := f.installedRecord(); record.Version != "0.1.0" || record.SHA256 != oldDigest {
				t.Errorf("installed.json after a rollback: %+v", record)
			}
		})
	}
}

func TestABuildThatNeverChecksInIsTakenBackAtTheDeadline(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.3", "silent", releaseOptions{})
	f.stage(release)
	f.mustRun()
	started := f.status().Last.At
	f.requireTakenBack(oldDigest, release, "NO_CHECK_IN")
	journal, _ := f.journal()
	if journal.StartedAt.Before(fixtureStart) || started.Sub(journal.StartedAt) < updateTrialDuration {
		t.Errorf("the step gave up after %s of a trial that lasts %s", started.Sub(journal.StartedAt), updateTrialDuration)
	}
}

func TestABuildThatChecksInWithoutVectorIsUnhealthyOnlyIfVectorRanBefore(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "novector", releaseOptions{})
	f.stage(release)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "UNHEALTHY")

	// A host that had no Vector running before takes the same build: its report is no change.
	g := newStepFixture(t)
	g.setVectorBefore(UpdateVectorNone)
	same := g.newRelease("0.1.2", "novector", releaseOptions{})
	g.stage(same)
	g.mustRun()
	if g.executableDigest() != same.buildSHA() || g.status().Last.Outcome != UpdateOutcomeCommitted {
		t.Errorf("a host with no Vector running before, and a build that reports none: %+v", g.status().Last)
	}
}

// setVectorBefore rewrites the health record of the running agent with Vector in
// the given state.
func (f *stepFixture) setVectorBefore(vector string) {
	f.t.Helper()
	s := f.service()
	s.Vector = vector
	f.host.saveService(s)
	f.host.writeHealth(s, f.start.Add(-30*time.Second), vector)
}

func TestHealthThatIsNotTheNewBuildsCheckInIsNeverAcceptedAsOne(t *testing.T) {
	cases := map[string]struct {
		behavior string
		// before runs at the moment the service has stopped, and may write a record.
		before func(f *stepFixture, release *fakeRelease)
	}{
		"the record names another build":                        {behavior: "wrongsha"},
		"the record is the old process's, with its boot id":     {behavior: "wrongboot"},
		"the record says the check-in is an hour from now":      {behavior: "future"},
		"the build checks in after the deadline":                {behavior: "slow"},
		"the record is the old build's and nothing replaces it": {behavior: "silent"},
		"a record of the new build from before the trial": {behavior: "silent", before: func(f *stepFixture, release *fakeRelease) {
			f.host.writeHealth(fakeService{Digest: release.buildSHA(), Version: release.version, Boot: digestOf([]byte("some boot"))}, f.clock.Now().Add(-time.Hour), UpdateVectorRunning)
		}},
		"a record of the new build that is older than the trial's start": {behavior: "silent", before: func(f *stepFixture, release *fakeRelease) {
			s := fakeService{Digest: release.buildSHA(), Version: release.version, Boot: digestOf([]byte("some boot"))}
			// Written, in the file system's time, before the trial though its own time says otherwise.
			f.host.writeHealth(s, f.clock.Now().Add(time.Minute), UpdateVectorRunning)
			past := f.clock.Now().Add(-time.Hour)
			if err := os.Chtimes(f.host.healthPath(), past, past); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", c.behavior, releaseOptions{})
			f.stage(release)
			if c.before != nil {
				updateFault = func(point string) {
					if point == "stopped" {
						c.before(f, release)
					}
				}
			}
			f.mustRun()
			f.requireTakenBack(oldDigest, release, "NO_CHECK_IN")
		})
	}
}

func TestHealthFromAnotherAccountOrThroughALinkIsNotACheckIn(t *testing.T) {
	good := func(f *stepFixture, release *fakeRelease) {
		f.host.writeHealth(fakeService{Digest: release.buildSHA(), Version: release.version, Boot: digestOf([]byte("some boot"))}, f.clock.Now().Add(5*time.Second), UpdateVectorRunning)
	}
	// A link stays a link through the rollback, which watches the same file, so the
	// previous build can't prove itself either: the step says so.
	finalCode := map[string]string{"a record that is a link": "ROLLBACK_UNHEALTHY"}
	for name, setup := range map[string]func(f *stepFixture){
		"a record owned by root": func(f *stepFixture) {
			if err := os.Lchown(f.host.healthPath(), 0, 0); err != nil {
				t.Fatal(err)
			}
		},
		"a record that is a link": func(f *stepFixture) {
			elsewhere := filepath.Join(f.root, "elsewhere.json")
			if err := os.Rename(f.host.healthPath(), elsewhere); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(elsewhere, f.host.healthPath()); err != nil {
				t.Fatal(err)
			}
		},
		"a record of 5 KiB": func(f *stepFixture) {
			data, _ := os.ReadFile(f.host.healthPath())
			f.host.writeAsAccount(f.host.healthPath(), append(data[:len(data)-1], []byte(strings.Repeat(" ", 5000)+"\n")...), f.clock.Now().Add(5*time.Second))
		},
		"a record that isn't one": func(f *stepFixture) {
			f.host.writeAsAccount(f.host.healthPath(), []byte(`{"schema":"vectory.update-health.v1"}`), f.clock.Now().Add(5*time.Second))
		},
	} {
		t.Run(name, func(t *testing.T) {
			if name == "a record owned by root" && os.Geteuid() != 0 {
				t.Skip("changing the owner of a file takes root")
			}
			f := newStepFixture(t)
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", "silent", releaseOptions{})
			f.stage(release)
			updateFault = func(point string) {
				if point == "started" {
					good(f, release)
					setup(f)
				}
			}
			f.mustRun()
			code := finalCode[name]
			if code == "" {
				code = "NO_CHECK_IN"
			}
			f.requireTakenBack(oldDigest, release, code)
		})
	}
}

func TestARollbackNeedsNoRoomAndTheFloorStaysWhereTheAttemptPutIt(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point == "trial" {
			// The file systems fill up: the new build can't record anything, and
			// the rollback is a rename of a file that is already there.
			f.host.cfg.InstallFree, f.host.cfg.StepFree = 1, 1
		}
	}
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if floors := f.counters().HighestCounters; floors[f.public.Fingerprint()] != 7 {
		t.Errorf("the floor after a rollback: %v", floors)
	}
}

func TestTheFloorIsOnDiskBeforeTheServiceStops(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.2", "good", releaseOptions{})
	f.stage(release)
	var floorAtTheStop, journalAtTheStop map[string]uint64
	var stage string
	updateFault = func(point string) {
		if point == "stopped" {
			floorAtTheStop = f.counters().HighestCounters
			journal, _ := f.journal()
			stage = journal.Stage
			journalAtTheStop = map[string]uint64{"counter": journal.Counter}
		}
	}
	f.mustRun()
	if floorAtTheStop[f.public.Fingerprint()] != 7 || stage != UpdateStageSwapping || journalAtTheStop["counter"] != 7 {
		t.Errorf("when the service stopped, the floor was %v and the journal said %s", floorAtTheStop, stage)
	}
}

func TestTheSameReleaseOfferedAgainAfterARollbackIsRefusedAndTheServiceIsNotTouched(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	snapshot := f.snapshot()

	// A new rollout offers the release it already tried: the manifest and the build
	// are the same, and the request is written again under another rollout.
	f.clock.advance(time.Hour)
	f.stage(release)
	data, err := MarshalUpdateRequest(UpdateRequest{ManifestSHA256: release.manifestSHA(), ArtifactSHA256: release.buildSHA(), RolloutID: "0d6f7b9e-1111-4222-8333-444455556666", OfferedAt: f.clock.Now()})
	if err != nil {
		t.Fatal(err)
	}
	f.host.writeAsAccount(UpdateExchangeFor(f.stateDir).Request, data, f.clock.Now())
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeRefused, "RELEASE_ALREADY_TRIED")
	if after := f.snapshot(); after.executable != snapshot.executable || strings.Join(after.history, ",") != strings.Join(snapshot.history, ",") {
		t.Errorf("the service was touched again: %v", after.history)
	}
	// A fix is a new release with a higher counter, and it goes through.
	f.clock.advance(time.Hour)
	fixed := f.newRelease("0.1.3", "good", releaseOptions{counter: 8})
	f.stage(fixed)
	f.mustRun()
	if f.executableDigest() != fixed.buildSHA() || f.status().Last.Outcome != UpdateOutcomeCommitted || f.counters().HighestCounters[f.public.Fingerprint()] != 8 {
		t.Errorf("the fix after a rollback: %+v", f.status().Last)
	}
}

func TestWhenThePreviousBuildIsNotHealthyEitherTheStepLeavesItInPlaceAndStops(t *testing.T) {
	f := newStepFixture(t)
	f.installBuild(fakeBuild("0.1.0", "silent", "installed"))
	f.recordInstalled("0.1.0")
	f.runningBuild()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	f.mustRun()
	if got := f.executableDigest(); got != oldDigest {
		t.Fatalf("the executable is %s, want the previous build", got)
	}
	f.requireAnswered(release, UpdateOutcomeRolledBack, "ROLLBACK_UNHEALTHY")
	history := strings.Join(f.service().History, ",")
	if history != "start 0.1.0,stop,start 0.1.2,stop,start 0.1.0" {
		t.Errorf("the step went on after the previous build didn't check in: %s", history)
	}
	// The next runs do nothing more: no alternating between builds.
	f.clock.advance(time.Hour)
	for i := 0; i < 3; i++ {
		f.mustRun()
	}
	if strings.Join(f.service().History, ",") != history || f.executableDigest() != oldDigest {
		t.Error("the step acted on a host it had given up on")
	}
}

func TestAPreviousBuildThatIsMissingOrNotTheOneTheJournalNamesIsNeverRestored(t *testing.T) {
	for name, damage := range map[string]func(f *stepFixture){
		"gone": func(f *stepFixture) { _ = os.Remove(filepath.Join(f.installDir, ".vectory-previous")) },
		"replaced": func(f *stepFixture) {
			writeMode(f.t, filepath.Join(f.installDir, ".vectory-previous"), "another build", 0o755)
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.2", "crash", releaseOptions{})
			f.stage(release)
			updateFault = func(point string) {
				if point == "trial" {
					damage(f)
				}
			}
			f.mustRun()
			if got := f.executableDigest(); got != release.buildSHA() {
				t.Fatalf("the step put a build it couldn't vouch for in place: %s", got)
			}
			f.requireAnswered(release, UpdateOutcomeRolledBack, "ROLLBACK_UNHEALTHY")
			if f.service().State == "inactive" {
				t.Error("the service was left stopped")
			}
		})
	}
}

func TestTheBuildThatCommittedBecomesTheHelperAndTheOldOneIsKeptBesideTheExecutable(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	// A helper copy from setup: the build that is installed.
	data, _ := os.ReadFile(f.exe)
	if err := os.WriteFile(f.paths.HelperExecutable, data, 0o755); err != nil {
		t.Fatal(err)
	}
	first := f.newRelease("0.1.1", "good", releaseOptions{counter: 7})
	f.stage(first)
	f.mustRun()
	if got := fileDigest(t, f.paths.HelperExecutable); got != first.buildSHA() {
		t.Fatalf("the helper after the first update: %s", got)
	}
	// Another update: the one kept beside the executable is the build before it.
	f.clock.advance(time.Hour)
	second := f.newRelease("0.1.2", "good", releaseOptions{counter: 8})
	f.stage(second)
	f.mustRun()
	if got := fileDigest(t, filepath.Join(f.installDir, ".vectory-previous")); got != first.buildSHA() {
		t.Errorf("the previous build after two updates is %s, want the first update", got)
	}
	if oldDigest == first.buildSHA() {
		t.Fatal("the test's builds are not different")
	}
	if got := fileDigest(t, f.paths.HelperExecutable); got != second.buildSHA() {
		t.Errorf("the helper after the second update: %s", got)
	}
	// No file of the helper's directory is left over.
	entries, _ := os.ReadDir(f.paths.Helper)
	if len(entries) != 1 {
		t.Errorf("the helper's directory holds %d files", len(entries))
	}
}

func TestACommitThatCantPlaceTheHelperKeepsTryingAtTheNextRun(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	// A helper directory that can't take a new file: a file in the way of the name
	// the copy is written to.
	if err := os.WriteFile(filepath.Join(f.paths.Helper, "vectory.next"), []byte("in the way"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f.paths.Helper, 0o500); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		t.Skip("root writes into a directory whatever its mode says")
	}
	f.mustRun()
	if f.executableDigest() != release.buildSHA() || f.status().Last.Outcome != UpdateOutcomeCommitted {
		t.Fatalf("the update didn't commit: %+v", f.status().Last)
	}
	if f.stagingEmpty() {
		t.Error("the staging directory was emptied while the helper copy is still to do")
	}
	if err := os.Chmod(f.paths.Helper, 0o700); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	if got := fileDigest(t, f.paths.HelperExecutable); got != release.buildSHA() {
		t.Errorf("the helper copy after the retry: %s", got)
	}
	if !f.stagingEmpty() {
		t.Error("the staging directory wasn't emptied once the helper copy was placed")
	}
}
