//go:build !windows

package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The step is killed for real, in another process, at every boundary of an update:
// SIGKILL, with no deferred function and no handler running, as a power cut stops
// it. The child is this test binary started again with the work to do in an
// environment variable; it runs the step against the machine in files and stops
// at the named boundary by printing it and waiting to be killed. The parent then
// looks at what the dead process left, and runs the step again, as the timer does
// at the next tick or after a reboot.
//
// Whatever the boundary: the executable is the old build or the new one, in full
// and never part of either; a floor that was raised is on disk; the temporary file
// beside the executable and the probe's copy are gone after the next run; and the
// result is the one the table says.

const updateStepChildEnv = "VECTORY_TEST_UPDATE_STEP_CHILD"

type updateStepChild struct {
	Root     string      `json:"root"`
	Paths    UpdatePaths `json:"paths"`
	Machine  string      `json:"machine"`
	StateDir string      `json:"state_dir"`
	StopAt   string      `json:"stop_at"`
}

func init() {
	if raw := os.Getenv(updateStepChildEnv); raw != "" {
		os.Exit(updateStepChildMain(raw))
	}
}

func updateStepChildMain(raw string) int {
	var request updateStepChild
	if err := json.Unmarshal([]byte(raw), &request); err != nil {
		fmt.Println("error:", err)
		return 2
	}
	rootOwnedTrust = ownerTrust{uid: uint32(os.Geteuid()), hasUID: true, anchor: request.Root}
	updateLocationsOverride = &request.Paths
	host := loadFakeHost(request.Machine)
	updateHostOverride, updateClockOverride = host, host.clock
	updateFault = func(point string) {
		if point == request.StopAt {
			fmt.Println("at " + point)
			time.Sleep(time.Hour)
		}
	}
	if err := RunUpdateHelper(context.Background(), request.StateDir); err != nil {
		fmt.Println("error:", err)
		return 1
	}
	fmt.Println("done")
	return 0
}

// runChildUntil starts the step in another process and kills it when it reaches
// the boundary. It reports whether the boundary was reached: a step that finishes
// first never stopped there.
func (f *stepFixture) runChildUntil(point string) bool {
	f.t.Helper()
	raw, err := json.Marshal(updateStepChild{Root: f.root, Paths: f.paths, Machine: f.machine, StateDir: f.stateDir, StopAt: point})
	if err != nil {
		f.t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), updateStepChildEnv+"="+string(raw))
	out, err := cmd.StdoutPipe()
	if err != nil {
		f.t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		f.t.Fatal(err)
	}
	lines := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	deadline := time.After(60 * time.Second)
	for {
		select {
		case line, ok := <-lines:
			switch {
			case !ok:
				return false
			case line == "at "+point:
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				return true
			case strings.HasPrefix(line, "error:"):
				f.t.Fatalf("the child step failed before %s: %s", point, line)
			case line == "done":
				return false
			}
		case <-deadline:
			f.t.Fatalf("the child step never reached %s", point)
		}
	}
}

// requireOneCompleteExecutable says the executable is one of the two builds, whole.
func (f *stepFixture) requireOneCompleteExecutable(builds ...string) {
	f.t.Helper()
	got := f.executableDigest()
	for _, build := range builds {
		if got == build {
			return
		}
	}
	f.t.Fatalf("the executable is %s, which is neither of the builds %v: part of a file, or a file nobody installed", got, builds)
}

// requireOneCompleteExecutableOrTheGap is requireOneCompleteExecutable, or, where the
// swap has two renames and the step was stopped between them (gap), says there is no
// executable and the build that was installed is beside it, whole.
func (f *stepFixture) requireOneCompleteExecutableOrTheGap(oldDigest, newDigest string, gap bool) {
	f.t.Helper()
	if !gap {
		f.requireOneCompleteExecutable(oldDigest, newDigest)
		return
	}
	if _, err := os.Stat(f.exe); err == nil {
		f.t.Fatal("there is an executable at the moment between the two renames")
	}
	if got := fileDigest(f.t, filepath.Join(f.installDir, updatePreviousName)); got != oldDigest {
		f.t.Fatalf("the build kept beside the executable is %s, and the one that was installed is %s", got, oldDigest)
	}
}

type killRow struct {
	point string
	// want is where the next run leaves the update.
	want string
	// raised says the floor was on disk at the kill.
	raised bool
}

var goodUpdateBoundaries = []killRow{
	{"run:started", "committed", false},
	{"accepted", "interrupted", false},
	{"identified", "interrupted", false},
	{"copied", "interrupted", false},
	{"verified", "interrupted", false},
	{"built", "interrupted", false},
	{"probe:copied", "interrupted", false},
	{"probed", "interrupted", false},
	{"named", "interrupted", false},
	{"staged", "interrupted", false},
	{"snapshot", "interrupted", false},
	{"floor_raised", "interrupted", true},
	{"swapping", "interrupted", true},
	{"stopped", "interrupted", true},
	{"swap:linked", "interrupted", true},
	{"swap:previous_kept", "interrupted", true},
	{"swap:renamed", "committed", true},
	{"swap:synced", "committed", true},
	{"swapped", "committed", true},
	{"trial", "committed", true},
	{"started", "committed", true},
	{"healthy", "committed", true},
	{"committed", "committed", true},
	{"commit:installed", "committed", true},
	{"commit:pins", "committed", true},
	{"commit:status", "committed", true},
	{"commit:helper", "committed", true},
	{"commit:cleaned", "committed", true},
}

// journalSaysSwapping names the boundaries, among those an update is interrupted at,
// from which the journal says swapping: the step has begun to replace the executable's
// name, stopped the service or linked the previous build, which a later run puts right.
var journalSaysSwapping = map[string]bool{"swapping": true, "stopped": true, "swap:linked": true, "swap:previous_kept": true}

func TestKillingTheStepAtEveryBoundaryOfAGoodUpdateLeavesOneCompleteExecutableAndTheRightResult(t *testing.T) {
	for _, row := range goodUpdateBoundaries {
		t.Run(row.point, func(t *testing.T) { checkKillAtBoundary(t, newStepFixture, row, false) })
	}
}

// checkKillAtBoundary kills the step at a boundary of a good update on the machine
// newFixture makes, and checks what the next run leaves. gap says the directory holds
// no executable at the kill: the moment between the two renames of a swap that has
// two, with the previous build beside it, which the next run puts back.
func checkKillAtBoundary(t *testing.T, newFixture func(*testing.T) *stepFixture, row killRow, gap bool) {
	f := newFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	asItWas := f.snapshot()

	if !f.runChildUntil(row.point) {
		t.Fatalf("an update never reached %s", row.point)
	}
	f.requireOneCompleteExecutableOrTheGap(oldDigest, release.buildSHA(), gap)
	if got := f.counters().HighestCounters[f.public.Fingerprint()]; (got == 7) != row.raised {
		t.Fatalf("at %s the floor is %d on disk; it is raised from floor_raised on", row.point, got)
	}
	if journal, found := f.journal(); found && journal.active() && journal.Stage != UpdateStagePreparing && !row.raised {
		t.Fatalf("the journal says %s before the floor was raised", journal.Stage)
	}

	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireOneCompleteExecutable(oldDigest, release.buildSHA())
	if entries, _ := os.ReadDir(f.paths.Probe); len(entries) != 0 {
		t.Errorf("the probe directory holds %d files after the next run", len(entries))
	}
	for _, name := range f.beside() {
		if strings.HasPrefix(name, updateStagedPrefix) || strings.HasSuffix(name, ".new") {
			t.Errorf("a temporary file is left beside the executable: %s", name)
		}
	}
	service := f.service()
	status := f.status()
	switch row.want {
	case "committed":
		if f.executableDigest() != release.buildSHA() || status.Last == nil || status.Last.Outcome != UpdateOutcomeCommitted || status.Last.Release != release.manifestSHA() {
			t.Fatalf("after a kill at %s the update should have committed: %+v", row.point, status.Last)
		}
		if f.installedRecord().SHA256 != release.buildSHA() || service.Version != "0.1.1" || service.State != "active" {
			t.Errorf("committed, and the host is %+v / %+v", f.installedRecord(), service)
		}
		if got := fileDigest(t, f.paths.HelperExecutable); got != release.buildSHA() {
			t.Errorf("the helper copy is %s", got)
		}
		if !f.stagingEmpty() {
			t.Error("the staging directory holds files after the commit")
		}
	case "interrupted":
		if f.executableDigest() != oldDigest || status.Last == nil || status.Last.Outcome != UpdateOutcomeFailed || status.Last.Code != "INTERRUPTED" || status.Last.Release != release.manifestSHA() {
			t.Fatalf("after a kill at %s the update should have been interrupted: %+v", row.point, status.Last)
		}
		if service.Version != "0.1.0" || service.State != "active" {
			t.Errorf("the host after an interruption: %+v", service)
		}
		if _, found := f.journal(); found {
			t.Error("a journal is left after an interruption")
		}
		if !f.stagingEmpty() {
			t.Error("the staging directory holds files after an interruption")
		}
		if got := f.counters().HighestCounters[f.public.Fingerprint()]; (got == 7) != row.raised {
			t.Errorf("the floor is %d after an interruption at %s", got, row.point)
		}
		// An interruption before the journal says swapping leaves the host exactly as it
		// was: the executable, the service, the pins, the policy and what is beside the
		// executable. The floor is the one thing it may have spent, because it is raised
		// just before the journal is written. Later ones leave the same executable and
		// policy, and the next run puts the rest right.
		if !journalSaysSwapping[row.point] {
			var ignore []string
			if row.raised {
				ignore = []string{"counters"}
			}
			f.requireUnchanged(asItWas, ignore...)
		} else if after := f.snapshot(); after.executable != asItWas.executable || !bytes.Equal(after.policy, asItWas.policy) || !bytes.Equal(after.installed, asItWas.installed) {
			t.Errorf("an interruption at %s changed the executable, the policy or the record of what is installed", row.point)
		}
		// A request that is written again is a new question: it is applied when the
		// floor never rose, and it is a replay when it did, which the host refuses.
		f.clock.advance(time.Hour)
		f.stage(release)
		f.mustRun()
		if row.raised {
			f.requireAnswered(release, UpdateOutcomeRefused, "COUNTER_REPLAYED")
			if f.executableDigest() != oldDigest {
				t.Error("an interrupted release was tried again")
			}
			// A release with a higher counter is a new question, and it installs.
			f.clock.advance(time.Hour)
			next := f.newRelease("0.1.2", "good", releaseOptions{counter: 8})
			f.stage(next)
			f.mustRun()
			f.requireAnswered(next, UpdateOutcomeCommitted, "")
			if f.executableDigest() != next.buildSHA() || f.counters().HighestCounters[f.public.Fingerprint()] != 8 {
				t.Errorf("a release with a higher counter wasn't installed after the interruption: %+v", f.status().Last)
			}
		} else if f.executableDigest() != release.buildSHA() || f.status().Last.Outcome != UpdateOutcomeCommitted {
			t.Errorf("a release interrupted before its floor rose wasn't applied when it was offered again: %+v", f.status().Last)
		}
	}
}

var rollbackBoundaries = []string{"rollback:build_freed", "rolling_back", "rollback:stopped", "rollback:restored", "rollback:started", "rolled_back", "rollback:status"}

func TestKillingTheStepAtEveryBoundaryOfARollbackStillEndsOnThePreviousBuild(t *testing.T) {
	for _, point := range append([]string{"trial", "started"}, rollbackBoundaries...) {
		t.Run(point, func(t *testing.T) { checkKillDuringRollback(t, newStepFixture, point, false) })
	}
}

// checkKillDuringRollback kills the step at a boundary of the rollback of a build
// that never starts, on the machine newFixture makes, and checks that the next run
// ends on the previous build. gap says the directory has no executable at the kill.
func checkKillDuringRollback(t *testing.T, newFixture func(*testing.T) *stepFixture, point string, gap bool) {
	f := newFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil(point) {
		t.Fatalf("a rollback never reached %s", point)
	}
	if gap {
		if _, err := os.Stat(f.exe); err == nil {
			t.Fatal("there is an executable at the moment between the two renames of a rollback")
		}
	} else {
		f.requireOneCompleteExecutable(oldDigest, release.buildSHA())
	}
	if f.counters().HighestCounters[f.public.Fingerprint()] != 7 {
		t.Fatal("the floor isn't on disk during the trial")
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	// A trial that was interrupted continues once and, the build still not
	// starting, is taken back with the code that says why.
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if service := f.service(); service.Version != "0.1.0" || service.State != "active" {
		t.Errorf("the host after a rollback that was interrupted at %s: %+v", point, service)
	}
	if got := f.installedRecord().SHA256; got != oldDigest {
		t.Errorf("installed.json names %s after a rollback", got)
	}
}

func TestATrialInterruptedTwiceIsTakenBackWithTheCodeThatSaysSo(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "good", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil("started") {
		t.Fatal("the trial never started")
	}
	// The step comes back and is stopped again, in the trial it continues.
	f.clock.advance(30 * time.Second)
	if !f.runChildUntil("started") {
		t.Fatal("the continued trial never started the service")
	}
	if journal, _ := f.journal(); journal.Interruptions != 1 || journal.Stage != UpdateStageTrial {
		t.Fatalf("the journal after one interruption: %+v", journal)
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "INTERRUPTED")
	if status := f.status(); status.Last.Outcome != UpdateOutcomeRolledBack {
		t.Errorf("an interruption after the swap is a rollback: %+v", status.Last)
	}
}

func TestKillingTheStepWhileItRefusesABuildLeavesTheHostAsItWas(t *testing.T) {
	for _, point := range []string{"accepted", "identified", "copied", "verified", "built", "probe:copied", "abort:dropped"} {
		t.Run(point, func(t *testing.T) {
			f := newStepFixture(t)
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.1", "badprobe", releaseOptions{})
			f.stage(release)
			if !f.runChildUntil(point) {
				t.Fatalf("a refused build never reached %s", point)
			}
			f.clock.advance(30 * time.Second)
			f.mustRun()
			status := f.status()
			wantCode := "INTERRUPTED"
			if point == "abort:dropped" {
				wantCode = "PROBE_FAILED"
			}
			if status.Last == nil || status.Last.Code != wantCode || status.Last.Outcome != UpdateOutcomeFailed {
				t.Fatalf("after a kill at %s: %+v", point, status.Last)
			}
			if f.executableDigest() != oldDigest || f.counters().HighestCounters[f.public.Fingerprint()] != 0 || len(f.beside()) != 0 {
				t.Error("a refused build changed the host")
			}
			if _, found := f.journal(); found || !f.stagingEmpty() {
				t.Error("files are left of a refused build")
			}
		})
	}
}

func TestAnExecutableReplacedWhileTheStepWasDeadIsLeftAloneWhateverTheJournalSays(t *testing.T) {
	for _, point := range []string{"swapping", "stopped", "trial", "started"} {
		t.Run(point, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			if !f.runChildUntil(point) {
				t.Fatalf("an update never reached %s", point)
			}
			// While the step was dead, someone put another build in the executable's place.
			f.installBuild(fakeBuild("0.1.5", "good", "by hand"))
			hand := f.executableDigest()
			f.clock.advance(30 * time.Second)
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeFailed, "BINARY_CHANGED")
			if f.executableDigest() != hand {
				t.Fatal("the step replaced an executable it hadn't installed")
			}
			// The service is started if it was stopped, so it runs what is installed; one
			// that was never stopped, or is running the build under trial, is left running.
			wantRunning := map[string]string{"swapping": "0.1.0", "stopped": "0.1.5", "trial": "0.1.5", "started": "0.1.1"}[point]
			if service := f.service(); service.Version != wantRunning || service.State != "active" {
				t.Errorf("the host: %+v, want %s running", service, wantRunning)
			}
			if got := f.installedRecord(); got.SHA256 != hand || got.Version != "0.1.5" {
				t.Errorf("installed.json: %+v", got)
			}
			if _, found := f.journal(); found {
				t.Error("a journal is left")
			}
			if floors := f.counters().HighestCounters; floors[f.public.Fingerprint()] != 7 {
				t.Errorf("the floor was lowered: %v", floors)
			}
		})
	}
}

// A swap that is interrupted leaves the executable or its replacement, never neither.
// When the executable is gone anyway (a person removed it while the step was dead) the
// step can't open the install it has to settle, makes no executable of the file that
// is beside it, and keeps its journal for a run that can.
func TestAnExecutableThatIsGoneWhileTheStepWasDeadIsNotMadeAgainOfWhatIsBesideIt(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil("swapping") {
		t.Fatal("an update never reached swapping")
	}
	if err := os.Remove(f.exe); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.installDir, ".vectory-previous"), fakeBuild("0.1.5", "good", "by hand"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(30 * time.Second)
	if err := f.run(); err == nil {
		t.Error("a run that couldn't settle the update said nothing")
	}
	if content, err := os.ReadFile(f.exe); err == nil {
		t.Errorf("the step made an executable of a file it can't vouch for: %s", digestOf(content))
	}
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageSwapping {
		t.Errorf("the journal after a run that couldn't settle: %+v (found %v)", journal, found)
	}
}

func TestALeftoverTemporaryFileIsRemovedAndNoOtherFileBesideTheExecutableIsTouched(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil("staged") {
		t.Fatal("never staged")
	}
	if _, err := os.Stat(filepath.Join(f.installDir, ".vectory-update-7")); err != nil {
		t.Fatalf("the temporary file isn't there to remove: %v", err)
	}
	// Files an administrator keeps there are none of the step's business.
	keep := filepath.Join(f.installDir, "vector")
	if err := os.WriteFile(keep, []byte("not ours"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	if _, err := os.Stat(filepath.Join(f.installDir, ".vectory-update-7")); err == nil {
		t.Error("the temporary file was left")
	}
	if data, err := os.ReadFile(keep); err != nil || string(data) != "not ours" {
		t.Errorf("a file the step doesn't own: %q, %v", data, err)
	}
}
