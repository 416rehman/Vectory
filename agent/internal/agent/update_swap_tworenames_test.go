package agent

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"
)

// The two-rename swap is the same code on every platform, over two operations, so
// its sequence is tested here on a directory that is a map of names to contents; the
// step's tests then run it for real on Unix primitives (update_swap_tworenames_unix_test.go),
// and Windows runs it on MoveFileEx (update_swap_windows_test.go).

// renameDirectory is an install directory: names and what is in them. A rename
// replaces the name it moves onto, as MoveFileEx does with MOVEFILE_REPLACE_EXISTING.
type renameDirectory struct {
	files map[string]string
	// failOn names a rename, "from>to", that fails with this error. A name is
	// absent from files once it has been moved.
	failOn map[string]error
	log    []string
}

func (d *renameDirectory) rename(from, to string) error {
	step := from + ">" + to
	d.log = append(d.log, step)
	if err := d.failOn[step]; err != nil {
		return err
	}
	content, ok := d.files[from]
	if !ok {
		return fmt.Errorf("rename %s: the file isn't there", from)
	}
	delete(d.files, from)
	d.files[to] = content
	return nil
}

func (d *renameDirectory) present(name string) (bool, error) {
	_, ok := d.files[name]
	return ok, nil
}

// names lists what is in the directory as name=content, ordered by name.
func (d *renameDirectory) names() string {
	names := make([]string, 0, len(d.files))
	for name := range d.files {
		names = append(names, name)
	}
	sort.Strings(names)
	listed := make([]string, len(names))
	for i, name := range names {
		listed[i] = name + "=" + d.files[name]
	}
	return strings.Join(listed, " ")
}

func (d *renameDirectory) swapper() twoRenames {
	return twoRenames{executable: "vectory.exe", rename: d.rename, present: d.present}
}

func installDirectory(files map[string]string) *renameDirectory {
	return &renameDirectory{files: files, failOn: map[string]error{}}
}

func TestASwapStepsTheExecutableAsideAndTheStagedFileIntoItsPlace(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "old", ".vectory-update-7": "new", "vectory.exe.previous": "older"})
	if err := d.swapper().swap(".vectory-update-7", "vectory.exe.previous"); err != nil {
		t.Fatal(err)
	}
	// The build kept from an earlier update is replaced by the one that was installed.
	if got := d.names(); got != "vectory.exe=new vectory.exe.previous=old" {
		t.Errorf("the directory after a swap: %s", got)
	}
	if got := strings.Join(d.log, " "); got != "vectory.exe>vectory.exe.previous .vectory-update-7>vectory.exe" {
		t.Errorf("the renames were %s", got)
	}
}

func TestASwapThatCannotStepTheExecutableAsideChangesNothing(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "old", ".vectory-update-7": "new"})
	hold := errors.New("another program holds the previous build")
	d.failOn["vectory.exe>vectory.exe.previous"] = hold
	if err := d.swapper().swap(".vectory-update-7", "vectory.exe.previous"); !errors.Is(err, hold) {
		t.Fatalf("%v", err)
	}
	if got := d.names(); got != ".vectory-update-7=new vectory.exe=old" {
		t.Errorf("the directory after a swap that never began: %s", got)
	}
}

// The second rename failing leaves the directory with no executable until the first
// is undone, which is done at once, so a person is not left with a host that can't
// start its service while the step waits for its next run.
func TestASwapThatCannotMakeItsSecondRenamePutsTheOldBuildBackAtOnce(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "old", ".vectory-update-7": "new"})
	hold := errors.New("a virus scan holds the staged file")
	d.failOn[".vectory-update-7>vectory.exe"] = hold
	if err := d.swapper().swap(".vectory-update-7", "vectory.exe.previous"); !errors.Is(err, hold) {
		t.Fatalf("%v", err)
	}
	if got := d.names(); got != ".vectory-update-7=new vectory.exe=old" {
		t.Errorf("the directory after a swap that was undone: %s", got)
	}
}

func TestASwapWhoseUndoFailsTooSaysSoAndLeavesTheOldBuildBesideTheExecutable(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "old", ".vectory-update-7": "new"})
	hold := errors.New("a virus scan holds the staged file")
	d.failOn[".vectory-update-7>vectory.exe"] = hold
	d.failOn["vectory.exe.previous>vectory.exe"] = errors.New("the previous build is held too")
	err := d.swapper().swap(".vectory-update-7", "vectory.exe.previous")
	if !errors.Is(err, hold) || !strings.Contains(err.Error(), "putting the previous build back failed: the previous build is held too") {
		t.Fatalf("%v", err)
	}
	// No executable: the journal names where the old build is, and the next run
	// puts it back.
	if got := d.names(); got != ".vectory-update-7=new vectory.exe.previous=old" {
		t.Errorf("the directory after a swap that couldn't be undone: %s", got)
	}
}

func TestASwapNeedsTwoDifferentNames(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "old", "same": "new"})
	if err := d.swapper().swap("same", "same"); err == nil {
		t.Error("a swap between a file and itself was made")
	}
	if len(d.log) != 0 {
		t.Errorf("the directory was touched: %v", d.log)
	}
}

// Whenever the step is stopped, the directory is in one of the states the journal
// recovers: the executable is the old build or the new one, or it is absent and the
// old build is beside it.
func TestEveryStateASwapCanBeStoppedInHoldsTheOldBuildOrTheNewOne(t *testing.T) {
	oldFault := updateFault
	defer func() { updateFault = oldFault }()
	for _, point := range []string{"swap:previous_kept", "swap:renamed"} {
		d := installDirectory(map[string]string{"vectory.exe": "old", ".vectory-update-7": "new"})
		stopped := errors.New("stopped at " + point)
		updateFault = func(at string) {
			if at == point {
				panic(stopped)
			}
		}
		func() {
			defer func() {
				if recovered := recover(); recovered != stopped {
					t.Fatalf("%s: recovered %v", point, recovered)
				}
			}()
			_ = d.swapper().swap(".vectory-update-7", "vectory.exe.previous")
		}()
		got := d.names()
		switch point {
		case "swap:previous_kept":
			if got != ".vectory-update-7=new vectory.exe.previous=old" {
				t.Errorf("%s: %s", point, got)
			}
		case "swap:renamed":
			if got != "vectory.exe=new vectory.exe.previous=old" {
				t.Errorf("%s: %s", point, got)
			}
		}
	}
}

func TestARestorePutsThePreviousBuildBackAndStepsTheBuildUnderTrialAside(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "new", "vectory.exe.previous": "old"})
	if err := d.swapper().restore("vectory.exe.previous"); err != nil {
		t.Fatal(err)
	}
	if got := d.names(); got != "vectory.exe=old vectory.exe.previous.new=new" {
		t.Errorf("the directory after a restore: %s", got)
	}
}

// A restore that was cut short between its two renames is done again by the next
// run, whichever rename it stopped after, and a second restore after a finished one
// would have nothing to move and says so.
func TestARestoreCutShortIsFinishedByTheNextOne(t *testing.T) {
	oldFault := updateFault
	defer func() { updateFault = oldFault }()
	d := installDirectory(map[string]string{"vectory.exe": "new", "vectory.exe.previous": "old"})
	stopped := errors.New("stopped")
	updateFault = func(at string) {
		if at == "restore:aside" {
			panic(stopped)
		}
	}
	func() {
		defer func() {
			if recovered := recover(); recovered != stopped {
				t.Fatalf("recovered %v", recovered)
			}
		}()
		_ = d.swapper().restore("vectory.exe.previous")
	}()
	if got := d.names(); got != "vectory.exe.previous=old vectory.exe.previous.new=new" {
		t.Fatalf("between the renames: %s", got)
	}
	updateFault = nil
	if err := d.swapper().restore("vectory.exe.previous"); err != nil {
		t.Fatal(err)
	}
	if got := d.names(); got != "vectory.exe=old vectory.exe.previous.new=new" {
		t.Errorf("after the next run: %s", got)
	}
	// With no previous build to put back it says so, and moves nothing: the executable
	// that is there is not stepped aside for a file that isn't.
	if err := d.swapper().restore("vectory.exe.previous"); err == nil {
		t.Error("a restore with no previous build to restore said nothing")
	}
	if got := d.names(); got != "vectory.exe=old vectory.exe.previous.new=new" {
		t.Errorf("after a restore with nothing to restore: %s", got)
	}
}

func TestARestoreThatCannotStepTheBuildAsideChangesNothing(t *testing.T) {
	d := installDirectory(map[string]string{"vectory.exe": "new", "vectory.exe.previous": "old"})
	hold := errors.New("held")
	d.failOn["vectory.exe>vectory.exe.previous.new"] = hold
	if err := d.swapper().restore("vectory.exe.previous"); !errors.Is(err, hold) {
		t.Fatalf("%v", err)
	}
	if got := d.names(); got != "vectory.exe=new vectory.exe.previous=old" {
		t.Errorf("the directory: %s", got)
	}
}

// The previous build keeps the name the contract gives it on each platform, and a
// journal with that name is one the step reads and writes.
func TestThePreviousBuildIsKeptUnderTheNameItsPlatformGives(t *testing.T) {
	for goos, want := range map[string]string{"linux": ".vectory-previous", "darwin": ".vectory-previous", "windows": "vectory.exe.previous"} {
		if got := updatePreviousFor(goos); got != want {
			t.Errorf("%s: %q, want %q", goos, got, want)
		}
	}
	journal := updateJournal{
		Stage: UpdateStageSwapping, Release: strings.Repeat("a", 64), Signers: []string{strings.Repeat("b", 64)}, Counter: 7,
		From:      &updateBuild{Version: "0.1.0", SHA256: strings.Repeat("c", 64)},
		To:        &updateBuild{Version: "0.1.1", SHA256: strings.Repeat("d", 64)},
		StartedAt: time.Date(2026, 10, 5, 2, 14, 0, 0, time.UTC),
		Swap:      &updateSwap{Style: updateSwapTwoRenames, Staged: ".vectory-update-7", Previous: updatePreviousFor("windows")},
	}
	data, err := marshalUpdateJournal(journal)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"swap":{"style":"two_renames","staged":".vectory-update-7","previous":"vectory.exe.previous"}`) {
		t.Errorf("the journal: %s", data)
	}
	if back, err := parseUpdateJournal(data); err != nil || *back.Swap != *journal.Swap {
		t.Errorf("the journal read back: %+v, %v", back.Swap, err)
	}
}
