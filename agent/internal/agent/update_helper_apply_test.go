//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

// `vectory update apply` is the installed agent. Once a swap has happened, the
// installed agent is the build under trial, which must not judge its own health or
// undo its own installation: an update that was interrupted after the swap is settled
// by the update step's own run, from the helper copy, and apply says so and leaves it.

// fileSeen is one file of the step as a test sees it: whether it is there, what it
// holds and which file it is, so that a file written again under the same bytes is
// told from one nobody wrote.
type fileSeen struct {
	exists bool
	data   []byte
	inode  uint64
}

func seeFile(t *testing.T, path string) fileSeen {
	t.Helper()
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return fileSeen{}
	}
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return fileSeen{exists: true, data: data, inode: info.Sys().(*syscall.Stat_t).Ino}
}

// stepFiles is everything an update leaves on the machine: the step's files, what is
// beside the executable, the executable and what the service manager was told.
type stepFiles struct {
	journal, counters, installed, status, request fileSeen
	staged, beside, history                       []string
	executable                                    string
}

func (f *stepFixture) stepFiles() stepFiles {
	f.t.Helper()
	return stepFiles{
		journal: seeFile(f.t, f.paths.Journal), counters: seeFile(f.t, f.paths.Counters), installed: seeFile(f.t, f.paths.Installed),
		status: seeFile(f.t, f.paths.Status), request: seeFile(f.t, UpdateExchangeFor(f.stateDir).Request),
		staged: f.stagedNames(), beside: f.beside(), history: append([]string(nil), f.service().History...), executable: f.executableDigest(),
	}
}

func TestApplyLeavesAnUpdateThatHasSwappedToTheUpdateStepAndTheStepSettlesIt(t *testing.T) {
	for _, row := range []struct {
		name, behavior, killedAt string
		outcome, code            string
	}{
		{"journal says swapping, before the stop", "good", "swapping", UpdateOutcomeFailed, "INTERRUPTED"},
		{"journal says swapping, after the swap", "good", "swapped", UpdateOutcomeCommitted, ""},
		{"journal says trial", "good", "trial", UpdateOutcomeCommitted, ""},
		{"journal says rolling_back", "crash", "rolling_back", UpdateOutcomeRolledBack, "START_FAILED"},
	} {
		t.Run(row.name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", row.behavior, releaseOptions{})
			f.stage(release)
			if !f.runChildUntil(row.killedAt) {
				t.Fatalf("an update never reached %s", row.killedAt)
			}
			journal, found := f.journal()
			if !found || !journal.active() || journal.Stage == UpdateStagePreparing {
				t.Fatalf("the journal when the step died: %+v (found %v)", journal, found)
			}
			before := f.stepFiles()
			var said []string

			err := ApplyStagedUpdate(bg(), f.stateDir, false, func(line string) { said = append(said, line) })

			// The refusal says what is happening, how long it takes and where to look.
			for _, want := range []string{
				"an update that already began is being settled by the background update step",
				"usually within a minute or two",
				"sudo vectory update status --state-dir " + ShellQuote(f.stateDir),
			} {
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Fatalf("apply on a journal in %s: %v, which doesn't say %q", journal.Stage, err, want)
				}
			}
			// It does nothing: no step is announced, no journal, result or floor is written, the
			// service isn't touched and the executable stays what it was.
			if len(said) != 0 {
				t.Errorf("apply announced %v", said)
			}
			if after := f.stepFiles(); !reflect.DeepEqual(before, after) {
				t.Errorf("apply changed the host:\nbefore %+v\nafter  %+v", before, after)
			}

			// The update step's own run settles it, as it does when nobody ran apply.
			f.clock.advance(30 * time.Second)
			f.mustRun()
			f.requireAnswered(release, row.outcome, row.code)
			if got := f.service(); got.State != "active" {
				t.Errorf("the service after the step settled the update: %+v", got)
			}
		})
	}
}

// Nothing has been swapped while the journal says preparing, so apply ends it itself,
// as the timer's run would.
func TestApplyEndsAnUpdateThatWasInterruptedWhilePreparingItself(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	if !f.runChildUntil("probed") {
		t.Fatal("an update never reached the probe")
	}
	if journal, _ := f.journal(); journal.Stage != UpdateStagePreparing {
		t.Fatalf("the journal when the step died: %+v", journal)
	}

	if err := ApplyStagedUpdate(bg(), f.stateDir, false, nil); err != nil {
		t.Fatalf("apply on a journal in preparing: %v", err)
	}

	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	f.requireOldBuildRunning(oldDigest)
}

// The update that apply itself began is driven to its end by apply, rollback included:
// the process that made the swap is the build that was installed before.
func TestApplyTakesBackABuildItTriedAndReportsWhatTheStepRecorded(t *testing.T) {
	f := newStepFixture(t)
	f.setPolicy(func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk })
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "crash", releaseOptions{})
	f.stage(release)
	var said []string

	if err := ApplyStagedUpdate(bg(), f.stateDir, false, func(line string) { said = append(said, line) }); err != nil {
		t.Fatal(err)
	}

	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if !strings.Contains(strings.Join(said, "\n"), "Putting the previous build back") {
		t.Errorf("apply said %v", said)
	}
}

// A run of the step that someone starts by hand from the installed executable is the
// installed build, however it was started, and is told apart by its file.
func TestARunOfTheStepIsTheInstalledBuildWhenItsExecutableIsTheInstalledFile(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skip("this system can't say which file runs the test")
	}
	dir := t.TempDir()
	linked := filepath.Join(dir, "linked")
	if err := os.Symlink(self, linked); err != nil {
		t.Fatal(err)
	}
	copied := filepath.Join(dir, "copied")
	if err := os.WriteFile(copied, []byte("another file"), 0o755); err != nil {
		t.Fatal(err)
	}
	hard := filepath.Join(dir, "hard")
	hardLinked := os.Link(self, hard) == nil

	for name, c := range map[string]struct {
		mode      stepMode
		installed string
		want      bool
	}{
		"the timer's run of a file that isn't the installed one": {stepTimer, copied, false},
		"the timer's run when no service is registered":          {stepTimer, "", false},
		"the timer's run when the installed file is missing":     {stepTimer, filepath.Join(dir, "missing"), false},
		"the timer's run of the installed file, by a link":       {stepTimer, linked, true},
		"apply, whatever file is installed":                      {stepApply, copied, true},
		"apply with no service registered":                       {stepApply, "", true},
	} {
		t.Run(name, func(t *testing.T) {
			s := &updateStep{mode: c.mode, service: registeredService{Executable: c.installed}}
			if got := s.runsAsInstalledBuild(); got != c.want {
				t.Errorf("runsAsInstalledBuild is %v, want %v", got, c.want)
			}
		})
	}
	if hardLinked {
		s := &updateStep{mode: stepTimer, service: registeredService{Executable: hard}}
		if !s.runsAsInstalledBuild() {
			t.Error("a second name of the running file isn't taken for it")
		}
	}
}
