//go:build windows

package agent

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The step's service writes its log in its private directory, which it reaches the way
// the step reaches its other files: through the path check, by handle, never by a path
// that something could have changed. These tests build the directories as the step
// makes them, in a tree the test owns, and look at what the log does with a file in the
// way.

// stepLocationsInATreeOfItsOwn moves the step's paths into a tree the test owns, with
// the directories made as the step makes them (closed to everyone but root), and trusts
// the account that runs the test in it.
func stepLocationsInATreeOfItsOwn(t *testing.T) UpdatePaths {
	t.Helper()
	requireRootOwnedWriter(t)
	tree := ownTree(t)
	paths := newUpdatePaths(filepath.Join(tree, "policy"), filepath.Join(tree, "step"), true)
	private, err := ensureRootOwnedDir(paths.Private, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	private.Close()
	useStepLocations(t, paths)
	return paths
}

// useStepLocations points the step at a set of paths until the test ends.
func useStepLocations(t *testing.T, paths UpdatePaths) {
	t.Helper()
	old := updateLocationsOverride
	updateLocationsOverride = &paths
	t.Cleanup(func() { updateLocationsOverride = old })
}

// captureStderr sends what the step says on its standard error to a file the test
// reads, until the test ends.
func captureStderr(t *testing.T) func() string {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stderr-*")
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stderr
	os.Stderr = file
	t.Cleanup(func() {
		os.Stderr = old
		file.Close()
	})
	return func() string {
		data, err := os.ReadFile(file.Name())
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
}

// The log has the access list of a private file of the step's when the step makes it,
// and what is said is added at its end, run after run.
func TestTheStepsLogIsMadeWithTheListOfAPrivateFileAndAddedToAtItsEnd(t *testing.T) {
	paths := stepLocationsInATreeOfItsOwn(t)
	log := filepath.Join(paths.Private, updateStepLogFile)
	undo := redirectStepLog()
	fmt.Fprintln(os.Stderr, "update step: first")
	undo()
	requireOnlyRootAndThese(t, log, privateAccess())
	undo = redirectStepLog()
	fmt.Fprintln(os.Stderr, "update step: second")
	undo()
	if data, err := os.ReadFile(log); err != nil || string(data) != "update step: first\nupdate step: second\n" {
		t.Errorf("the log is %q, %v", data, err)
	}
	requireOnlyRootAndThese(t, log, privateAccess())
}

// A log longer than its limit starts again, through the handle that was judged, and a
// log at its limit is kept: a handle that can only append can't be made shorter, so this
// is what the open asks the system for.
func TestTheStepsLogStartsAgainWhenItIsOpenedLongerThanItsLimitAndNotBefore(t *testing.T) {
	paths := stepLocationsInATreeOfItsOwn(t)
	log := filepath.Join(paths.Private, updateStepLogFile)
	for _, tc := range []struct {
		name string
		size int
		kept bool
	}{
		{"empty", 0, true},
		{"short", 100, true},
		{"at its limit", maxUpdateStepLog, true},
		{"one byte past its limit", maxUpdateStepLog + 1, false},
		{"far past its limit", 3 * maxUpdateStepLog, false},
	} {
		old := bytes.Repeat([]byte("x"), tc.size)
		if err := os.WriteFile(log, old, 0o600); err != nil {
			t.Fatal(err)
		}
		undo := redirectStepLog()
		fmt.Fprintln(os.Stderr, "update step: next")
		undo()
		want := "update step: next\n"
		if tc.kept {
			want = string(old) + want
		}
		if data, err := os.ReadFile(log); err != nil || string(data) != want {
			t.Errorf("%s: the log is %d bytes after the step said one line (%v), want %d", tc.name, len(data), err, len(want))
		}
	}
}

// A link in the log's place is opened as the link and refused: the file it leads to is
// not written to or shortened, the log isn't redirected, and the step goes on and says so
// on the standard error it still has.
func TestAStepsLogThatIsALinkIsNotFollowedShortenedOrWrittenTo(t *testing.T) {
	paths := stepLocationsInATreeOfItsOwn(t)
	target := filepath.Join(filepath.Dir(paths.Private), "elsewhere.txt")
	long := strings.Repeat("y", maxUpdateStepLog+10)
	writeText(t, target, long)
	log := filepath.Join(paths.Private, updateStepLogFile)
	if err := os.Symlink(target, log); err != nil {
		t.Skipf("can't make a symbolic link here: %v", err)
	}
	said := captureStderr(t)
	undo := redirectStepLog()
	fmt.Fprintln(os.Stderr, "update step: the step goes on")
	undo()
	if data, err := os.ReadFile(target); err != nil || string(data) != long {
		t.Errorf("the file the link leads to was changed: %d bytes, %v", len(data), err)
	}
	if info, err := os.Lstat(log); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link was replaced: %v, %v", info, err)
	}
	got := said()
	for _, want := range []string{"update step: its log " + log + " isn't used: ", "is a symbolic link or a junction", "update step: the step goes on"} {
		if !strings.Contains(got, want) {
			t.Errorf("the standard error lacks %q:\n%s", want, got)
		}
	}
	if os.Stderr == nil {
		t.Error("the step's standard error is gone")
	}
}

// A name that isn't a plain file is refused too, and left as it was.
func TestAStepsLogThatIsADirectoryIsNotUsedAndIsLeftAlone(t *testing.T) {
	paths := stepLocationsInATreeOfItsOwn(t)
	log := filepath.Join(paths.Private, updateStepLogFile)
	if err := os.Mkdir(log, 0o755); err != nil {
		t.Fatal(err)
	}
	said := captureStderr(t)
	undo := redirectStepLog()
	undo()
	if got := said(); !strings.Contains(got, "update step: its log "+log+" isn't used: ") {
		t.Errorf("the standard error says %q", got)
	}
	if info, err := os.Stat(log); err != nil || !info.IsDir() {
		t.Errorf("what was in the log's place was changed: %v, %v", info, err)
	}
}

// The private directory is reached by handle, so a link where it should be is refused and
// nothing is made where it leads. A path opened by name would have made the log there.
func TestAStepsLogIsNotMadeThroughAPrivateDirectoryThatIsAJunction(t *testing.T) {
	requireRootOwnedWriter(t)
	tree := ownTree(t)
	paths := newUpdatePaths(filepath.Join(tree, "policy"), filepath.Join(tree, "step"), true)
	mkdirAll(t, paths.StepDir)
	setDACL(t, paths.StepDir, ownDACL(t, true))
	elsewhere := filepath.Join(tree, "elsewhere")
	mkdirAll(t, elsewhere)
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", paths.Private, elsewhere).CombinedOutput(); err != nil {
		t.Skipf("can't make a junction here: %v: %s", err, out)
	}
	useStepLocations(t, paths)
	said := captureStderr(t)
	undo := redirectStepLog()
	undo()
	if got := said(); !strings.Contains(got, "is a symbolic link or a junction") {
		t.Errorf("the standard error says %q", got)
	}
	if entries, err := os.ReadDir(elsewhere); err != nil || len(entries) != 0 {
		t.Errorf("something was made where the junction leads: %v, %v", entries, err)
	}
}
