//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The API the host side calls: installing the step, removing it, and asking
// whether a host can be updated. The service manager is the fixture's recorder; the
// directories, the helper copy and the records are real.

// freshHost is a fixture whose step has never been installed: the host consents,
// runs agent 0.1.0 and has no step directory.
func freshHost(t *testing.T) *stepFixture {
	t.Helper()
	f := newStepFixture(t)
	if err := os.RemoveAll(f.paths.StepDir); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *stepFixture) openPrivate() *rootOwned {
	f.t.Helper()
	private, err := openRootOwned(f.paths.Private, rootOwnedDirectory)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { private.Close() })
	return private
}

// writeJournal leaves a journal in the stage, as a step that was interrupted there
// would have.
func (f *stepFixture) writeJournal(stage string, edit func(*updateJournal)) {
	f.t.Helper()
	journal := updateJournal{
		Stage: stage, Release: strings.Repeat("a", 64), Signers: []string{f.public.Fingerprint()}, Counter: 7,
		From:      &updateBuild{Version: "0.1.0", SHA256: f.executableDigest()},
		To:        &updateBuild{Version: "0.1.1", SHA256: strings.Repeat("b", 64)},
		StartedAt: f.clock.Now(),
		Swap:      &updateSwap{Style: updateSwapRename, Staged: ".vectory-update-7", Previous: updatePreviousName},
	}
	switch stage {
	case UpdateStageTrial, UpdateStageRollingBack:
		journal.Deadline = f.clock.Now().Add(5 * time.Minute)
	}
	switch stage {
	case UpdateStageRollingBack, updateJournalRolledBack:
		journal.Code = "NO_CHECK_IN"
	}
	switch stage {
	case updateJournalCommitted, updateJournalRolledBack:
		journal.FinishedAt = f.clock.Now()
	case UpdateStagePreparing:
		journal.Signers, journal.From, journal.To, journal.Counter = []string{}, nil, nil, 0
	}
	if edit != nil {
		edit(&journal)
	}
	if err := writeUpdateJournal(f.openPrivate(), journal); err != nil {
		f.t.Fatal(err)
	}
}

func modeOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestInstallingTheStepMakesItsDirectoriesPlacesTheHelperRecordsTheBuildAndRegistersTheUnits(t *testing.T) {
	f := freshHost(t)
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{
		f.paths.StepDir: 0o755, f.paths.Probe: 0o755, f.paths.Private: 0o700, f.paths.Staging: 0o700, f.paths.Helper: 0o700,
		f.paths.PolicyDir: 0o755, f.paths.HelperExecutable: 0o755, f.paths.Installed: 0o600,
	} {
		if got := modeOf(t, path); got != want {
			t.Errorf("%s is %04o, want %04o", path, got, want)
		}
	}
	if got, want := fileDigest(t, f.paths.HelperExecutable), f.executableDigest(); got != want {
		t.Errorf("the helper is %s, the executable %s", got, want)
	}
	record := f.installedRecord()
	if record.Version != "0.1.0" || record.SHA256 != f.executableDigest() || record.Release != "" || !record.RecordedAt.Equal(f.clock.Now()) {
		t.Errorf("installed.json: %+v", record)
	}
	want := fmt.Sprintf("install %+v", updateUnitSpec{StateDir: f.stateDir, InstallDir: f.installDir, Helper: f.paths.HelperExecutable})
	if len(f.host.unitsCalls) != 1 || f.host.unitsCalls[0] != want {
		t.Errorf("the units: %v, want %s", f.host.unitsCalls, want)
	}
	// What the step takes next run is where nothing is in progress.
	if _, found := f.journal(); found {
		t.Error("installing left a journal")
	}
	release, err := f.host.Lock(f.openPrivate())
	if err != nil {
		t.Fatalf("installing left the step's lock held: %v", err)
	}
	release()
	// The executable and what is beside it are as they were.
	if names := f.beside(); len(names) != 0 {
		t.Errorf("installing left %v beside the executable", names)
	}
}

func TestInstallingTheStepAgainChangesNothingThatIsAlreadyRightAndFollowsAnUpgradeByHand(t *testing.T) {
	f := freshHost(t)
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	helper, installed := fileDigest(t, f.paths.HelperExecutable), f.installedRecord()
	helperInfo, err := os.Stat(f.paths.HelperExecutable)
	if err != nil {
		t.Fatal(err)
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	again, err := os.Stat(f.paths.HelperExecutable)
	if err != nil || !os.SameFile(helperInfo, again) || fileDigest(t, f.paths.HelperExecutable) != helper {
		t.Errorf("a helper that is already the executable was replaced: %v", err)
	}
	if got := f.installedRecord(); got != installed {
		t.Errorf("installed.json changed: %+v, was %+v", got, installed)
	}
	if len(f.host.unitsCalls) != 2 {
		t.Errorf("the units are registered each time: %v", f.host.unitsCalls)
	}

	// A person replaced the executable by hand: the next setup brings the helper and
	// the record along.
	f.installBuild(fakeBuild("0.1.5", "good", "by-hand"))
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	if got := fileDigest(t, f.paths.HelperExecutable); got != f.executableDigest() || got == helper {
		t.Errorf("the helper after an upgrade by hand: %s", got)
	}
	if got := f.installedRecord(); got.Version != "0.1.5" || got.SHA256 != f.executableDigest() {
		t.Errorf("installed.json after an upgrade by hand: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(f.paths.Helper, "vectory.next")); err == nil {
		t.Error("a half-made helper is left")
	}
}

func TestInstallingTheStepClearsAForkAndKeepsTheFloors(t *testing.T) {
	f := freshHost(t)
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	conflict := &RolloverConflict{From: f.public.Fingerprint(), To: [2]string{strings.Repeat("1", 64), strings.Repeat("2", 64)}}
	floors := map[string]uint64{f.public.Fingerprint(): 7}
	if err := writeUpdateCounters(f.openPrivate(), updateCounters{HighestCounters: floors, RolloverConflict: conflict}); err != nil {
		t.Fatal(err)
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	got := f.counters()
	if got.RolloverConflict != nil || got.HighestCounters[f.public.Fingerprint()] != 7 || len(got.HighestCounters) != 1 {
		t.Errorf("after pinning again: %+v", got)
	}
}

func TestInstallingTheStepOnAHostThatCantBeUpdatedChangesNothingAndSaysWhy(t *testing.T) {
	for name, c := range map[string]struct {
		setup func(*stepFixture) (dir, executable string)
		want  string
	}{
		"a package's executable":  {func(f *stepFixture) (string, string) { f.host.cfg.Packaged = true; return f.stateDir, f.exe }, "PACKAGE_MANAGED"},
		"a read-only file system": {func(f *stepFixture) (string, string) { f.host.cfg.ReadOnly = true; return f.stateDir, f.exe }, "READ_ONLY"},
		"another executable than the service's": {func(f *stepFixture) (string, string) {
			return f.stateDir, filepath.Join(f.installDir, "other")
		}, "NO_SERVICE"},
		"a service that runs as root": {func(f *stepFixture) (string, string) { f.host.account.UID = 0; return f.stateDir, f.exe }, "NO_SERVICE"},
		"an install directory others can write": {func(f *stepFixture) (string, string) {
			_ = os.Chmod(f.installDir, 0o775)
			return f.stateDir, f.exe
		}, "UNTRUSTED_LOCATION"},
	} {
		t.Run(name, func(t *testing.T) {
			f := freshHost(t)
			dir, executable := c.setup(f)
			err := InstallUpdateHelper(dir, executable)
			var refusal *UpdateRefusal
			if !errors.As(err, &refusal) || refusal.Code != c.want {
				t.Fatalf("installing: %v, want %s", err, c.want)
			}
			if _, err := os.Lstat(f.paths.StepDir); err == nil {
				t.Error("the step's directory was made")
			}
			if len(f.host.unitsCalls) != 0 {
				t.Errorf("the units were registered: %v", f.host.unitsCalls)
			}
		})
	}
}

func TestInstallingTheStepNeedsAbsolutePathsAndASettledStepAndNobodyElseUsingIt(t *testing.T) {
	f := freshHost(t)
	for _, c := range []struct{ dir, executable string }{
		{"state", f.exe}, {f.stateDir, "vectory"}, {f.stateDir, f.installDir + "/../bin/vectory"}, {"", ""},
	} {
		if err := InstallUpdateHelper(c.dir, c.executable); err == nil || !strings.Contains(err.Error(), "absolute") {
			t.Errorf("%q and %q: %v", c.dir, c.executable, err)
		}
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	helper := fileDigest(t, f.paths.HelperExecutable)
	f.installBuild(fakeBuild("0.1.5", "good", "by-hand"))

	// Replacing the helper while a build is under trial would put that build in the
	// place of the one that takes it back.
	for _, stage := range []string{UpdateStagePreparing, UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack} {
		f.writeJournal(stage, nil)
		err := InstallUpdateHelper(f.stateDir, f.exe)
		if err == nil || !strings.Contains(err.Error(), "an update is being") {
			t.Errorf("a journal in %s: %v", stage, err)
		}
		if got := fileDigest(t, f.paths.HelperExecutable); got != helper {
			t.Errorf("a journal in %s: the helper was replaced", stage)
		}
	}
	if err := os.WriteFile(f.paths.Journal, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); err == nil || !strings.Contains(err.Error(), "can't be read") {
		t.Errorf("a journal nobody can read: %v", err)
	}
	if err := os.Remove(f.paths.Journal); err != nil {
		t.Fatal(err)
	}

	// A settled journal is no obstacle, and one run of the step at a time.
	f.writeJournal(updateJournalRolledBack, nil)
	release, err := f.host.Lock(f.openPrivate())
	if err != nil {
		t.Fatal(err)
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); err == nil || !strings.Contains(err.Error(), "working now") {
		t.Errorf("while the step runs: %v", err)
	}
	release()
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatalf("after a rolled back update: %v", err)
	}
	if got := fileDigest(t, f.paths.HelperExecutable); got != f.executableDigest() {
		t.Error("the helper wasn't brought along")
	}
}

func TestRemovingTheStepStopsItsUnitsAndLeavesNothingBesideTheExecutableButTheExecutable(t *testing.T) {
	f := freshHost(t)
	if err := RemoveUpdateHelper(); err != nil {
		t.Fatalf("with no step: %v", err)
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	executable := f.executableDigest()
	// What an update left beside the executable, and a file that is somebody else's.
	for _, name := range []string{updatePreviousName, updatePreviousName + ".new", ".vectory-update-7", "vectory-keep"} {
		if err := os.WriteFile(filepath.Join(f.installDir, name), []byte(name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.writeJournal(updateJournalRolledBack, nil)
	if err := RemoveUpdateHelper(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
	if got := f.beside(); strings.Join(got, ",") != "vectory-keep" {
		t.Errorf("beside the executable: %v", got)
	}
	if f.executableDigest() != executable {
		t.Error("the executable changed")
	}
	if last := f.host.unitsCalls[len(f.host.unitsCalls)-1]; last != "remove" {
		t.Errorf("the units: %v", f.host.unitsCalls)
	}
	if err := RemoveUpdateHelper(); err != nil {
		t.Errorf("removing what is already gone: %v", err)
	}
}

func TestRemovingTheStepIsRefusedWhileABuildIsUnderTrialAndSaysWhenItEnds(t *testing.T) {
	f := freshHost(t)
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	units := len(f.host.unitsCalls)
	for _, stage := range []string{UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack} {
		f.writeJournal(stage, nil)
		err := RemoveUpdateHelper()
		if err == nil || !strings.Contains(err.Error(), "an update is being") {
			t.Errorf("a journal in %s: %v", stage, err)
		}
		if _, statErr := os.Lstat(f.paths.Private); statErr != nil {
			t.Errorf("a journal in %s: the step's directory was removed", stage)
		}
		if len(f.host.unitsCalls) != units {
			t.Errorf("a journal in %s: the units were touched: %v", stage, f.host.unitsCalls)
		}
	}
	// A trial that should have ended says that nobody has settled it.
	f.writeJournal(UpdateStageTrial, func(j *updateJournal) { j.Deadline = f.clock.Now().Add(-time.Hour) })
	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), "hasn't settled") {
		t.Errorf("a trial past its deadline: %v", err)
	}
	// The trial's end is named by the time it ends.
	deadline := f.clock.Now().Add(10 * time.Minute)
	f.writeJournal(UpdateStageTrial, func(j *updateJournal) { j.Deadline = deadline })
	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), deadline.Local().Format("15:04")) {
		t.Errorf("a trial that ends at %s: %v", deadline.Local().Format("15:04"), err)
	}

	// Before the service has been stopped nothing has been replaced.
	f.writeJournal(UpdateStagePreparing, func(j *updateJournal) {
		j.Swap = &updateSwap{Style: updateSwapRename, Staged: ".vectory-update-7", Previous: updatePreviousName}
	})
	if err := os.WriteFile(filepath.Join(f.installDir, ".vectory-update-7"), []byte("half"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RemoveUpdateHelper(); err != nil {
		t.Fatalf("a request that hadn't stopped anything: %v", err)
	}
	if got := f.beside(); len(got) != 0 {
		t.Errorf("the temporary file the journal names is still there: %v", got)
	}
}

func TestRemovingTheStepReadsAJournalItCantReadAsAReasonToStopAndWaitsForTheStepToFinish(t *testing.T) {
	f := freshHost(t)
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	units := len(f.host.unitsCalls)
	if err := os.WriteFile(f.paths.Journal, []byte("not a journal"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), "can't be read") {
		t.Errorf("a journal that can't be read: %v", err)
	}
	if err := os.Remove(f.paths.Journal); err != nil {
		t.Fatal(err)
	}
	release, err := f.host.Lock(f.openPrivate())
	if err != nil {
		t.Fatal(err)
	}
	if err := RemoveUpdateHelper(); err == nil || !strings.Contains(err.Error(), "working now") {
		t.Errorf("while the step runs: %v", err)
	}
	release()
	if len(f.host.unitsCalls) != units {
		t.Errorf("the units were touched: %v", f.host.unitsCalls)
	}
	if _, err := os.Lstat(f.paths.StepDir); err != nil {
		t.Errorf("the step's directory was removed: %v", err)
	}
}

func TestEligibilityIsAnAnswerAnyAccountCanAskForAndNeverAnEligibleOneForAnotherExecutable(t *testing.T) {
	f := newStepFixture(t)
	// The service runs the fixture's executable, and this is the test binary.
	if got := UpdateEligibility(f.stateDir); got != "NO_SERVICE" {
		t.Errorf("an agent that isn't the one the service runs: %s", got)
	}
	// What asking leaves behind: nothing.
	before := f.snapshot()
	UpdateEligibility(f.stateDir)
	f.requireUnchanged(before)

	// The rest of the answers, for the executable the service does run.
	for _, c := range []struct {
		name  string
		setup func()
		want  string
	}{
		{"eligible", func() {}, UpdateEligible},
		{"a package's", func() { f.host.cfg.Packaged = true }, "PACKAGE_MANAGED"},
		{"read-only", func() { f.host.cfg.Packaged, f.host.cfg.ReadOnly = false, true }, "READ_ONLY"},
	} {
		c.setup()
		facts := inspectHost(f.host, f.stateDir, f.exe)
		if facts.install != nil {
			facts.install.Close()
		}
		if facts.code != c.want {
			t.Errorf("%s: %s (%s)", c.name, facts.code, facts.detail)
		}
	}
}

func TestEligibilityOfAHostWithNoServiceRegisteredIsNoService(t *testing.T) {
	updateHostOverride = nil
	t.Cleanup(func() { updateHostOverride = nil })
	got := UpdateEligibility("/nonexistent/vectory-state-for-a-test")
	if runtime.GOOS == "linux" && got != "NO_SERVICE" {
		t.Errorf("a Linux host with no such service: %s", got)
	}
	if runtime.GOOS != "linux" && got != "PLATFORM_NOT_IN_RELEASE" {
		t.Errorf("a platform with no step: %s", got)
	}
}
