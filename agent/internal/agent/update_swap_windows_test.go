//go:build windows

package agent

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The install directory of the Windows step, on a real file system: the checks the
// directory and the executable pass, the staged file's own access list, the two
// renames and what a program that holds a file does to them. The tests that make
// files only root may change run elevated, as the Windows job does (they skip
// otherwise, the way rootpath_windows_test.go's do); the rest run anywhere.

const (
	installedText = "the installed build"
	stagedName    = ".vectory-update-7"
)

// installFixture is an install directory in a tree the test owns, with the
// executable in it.
type installFixture struct {
	dir, exe string
	previous string
}

func newInstallFixture(t *testing.T) installFixture {
	t.Helper()
	tree := ownTree(t)
	dir := filepath.Join(tree, "Vectory")
	mkdirAll(t, dir)
	exe := filepath.Join(dir, "vectory.exe")
	writeText(t, exe, installedText)
	return installFixture{dir: dir, exe: exe, previous: updatePreviousFor("windows")}
}

func (f installFixture) path(name string) string { return filepath.Join(f.dir, name) }

// open opens the install as the step does, and lets go of it when the test ends.
func (f installFixture) open(t *testing.T) *windowsInstall {
	t.Helper()
	install, err := openWindowsInstall(f.exe)
	if err != nil {
		t.Fatalf("opening the install: %v", err)
	}
	t.Cleanup(func() { _ = install.Close() })
	return install
}

func contentOf(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestTheInstallIsTheExecutableAndTheDirectoryThatHoldsIt(t *testing.T) {
	f := newInstallFixture(t)
	install := f.open(t)
	if install.Path() != f.exe || install.Name() != "vectory.exe" || install.Style() != updateSwapTwoRenames {
		t.Errorf("path %q, name %q, style %q", install.Path(), install.Name(), install.Style())
	}
	digest, present, err := install.Digest("vectory.exe")
	if err != nil || !present || digest != sha256OfText(installedText) {
		t.Errorf("the executable's digest: %q, %v, %v", digest, present, err)
	}
	if _, present, err := install.Digest("nothing.exe"); err != nil || present {
		t.Errorf("a file that isn't there: present %v, %v", present, err)
	}
	reader, err := install.Open("vectory.exe")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(data) != installedText {
		t.Errorf("read back %q, %v", data, err)
	}
	if install.ReadOnly() {
		t.Error("a temporary directory is on a read-only volume")
	}
	if free, err := install.FreeSpace(); err != nil || free == 0 {
		t.Errorf("free space %d, %v", free, err)
	}
	if err := install.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	if err := install.Close(); err != nil {
		t.Errorf("a second Close: %v", err)
	}
}

// The install is refused when another account can change the directory or the
// executable, before anything is done in it, and a refusal leaves no half-open
// install behind: the interface the host returns is nil.
func TestAnInstallThatAnotherAccountCanChangeIsRefused(t *testing.T) {
	f := newInstallFixture(t)
	for name, change := range map[string]func(){
		"the directory is writable by Users": func() { setDACL(t, f.dir, ownDACL(t, true, "(A;;FW;;;BU)")) },
		"the executable is writable by Users": func() {
			setDACL(t, f.exe, ownDACL(t, false, "(A;;FW;;;BU)"))
		},
	} {
		change()
		install, err := newWindowsUpdateHost().OpenInstall(f.exe)
		if install != nil {
			install.Close()
			t.Errorf("%s: an install was returned", name)
		}
		refusedAs(t, err)
		setDACL(t, f.dir, ownDACL(t, true))
		setDACL(t, f.exe, ownDACL(t, false))
	}
	f.open(t)
}

// An executable that is not there is the one state a swap that was cut short leaves:
// the directory is opened alone and the not-exist error is returned beside it, so
// that the step can still settle the update there by putting the previous build back.
func TestAnInstallWhoseExecutableIsMissingStillOpensItsDirectory(t *testing.T) {
	f := newInstallFixture(t)
	if err := os.Rename(f.exe, f.path(f.previous)); err != nil {
		t.Fatal(err)
	}
	host := newWindowsUpdateHost()
	opened, err := host.OpenInstall(f.exe)
	if opened == nil || !notExist(err) {
		t.Fatalf("OpenInstall of a missing executable: %v, %v", opened, err)
	}
	defer opened.Close()
	if _, present, err := opened.Digest("vectory.exe"); err != nil || present {
		t.Errorf("the missing executable: present %v, %v", present, err)
	}
	if digest, present, err := opened.Digest(f.previous); err != nil || !present || digest != sha256OfText(installedText) {
		t.Errorf("the previous build: %q, %v, %v", digest, present, err)
	}
	if err := opened.Restore(f.previous); err != nil {
		t.Fatal(err)
	}
	if got := contentOf(t, f.exe); got != installedText {
		t.Errorf("the executable after the restore: %q", got)
	}
	if exists(t, f.path(f.previous)) || exists(t, f.path(f.previous+".new")) {
		t.Error("the restore from the gap left a file behind")
	}

	// What can't be opened at all is refused, and is not a gap.
	setDACL(t, f.dir, ownDACL(t, true, "(A;;FW;;;BU)"))
	if err := os.Remove(f.exe); err != nil {
		t.Fatal(err)
	}
	opened, err = host.OpenInstall(f.exe)
	if opened != nil {
		opened.Close()
		t.Error("an install in a directory others can change was opened")
	}
	refusedAs(t, err)
}

func TestStageMakesTheFileWithAnAccessListOfItsOwn(t *testing.T) {
	requireRootOwnedWriter(t)
	f := newInstallFixture(t)
	install := f.open(t)
	digest, err := install.Stage(stagedName, strings.NewReader("the staged build"), int64(len("the staged build")))
	if err != nil {
		t.Fatal(err)
	}
	if digest != sha256OfText("the staged build") {
		t.Errorf("the digest read back is %s", digest)
	}
	if got := contentOf(t, f.path(stagedName)); got != "the staged build" {
		t.Errorf("the staged file holds %q", got)
	}
	requireOnlyRootAndThese(t, f.path(stagedName), executableAccess())
	// What the file system hands back is what the path check accepts.
	held := mustOpen(t, f.path(stagedName), rootOwnedFile)
	if data, err := held.ReadFile(64); err != nil || string(data) != "the staged build" {
		t.Errorf("the check read %q, %v", data, err)
	}
}

// A directory can give the accounts that make files in it their rights over what
// they make: Users who may modify what is created in it, say. The check judges the
// entries that apply to the directory itself, so a directory like that is accepted
// (an entry that is for what is made in it only doesn't apply to it), and a file
// that took what its directory gave would be one anyone could change. What the step
// makes has an access list of its own, and nothing of the directory's.
func TestAFileTheStepStagesTakesNothingItsDirectoryWouldGive(t *testing.T) {
	requireRootOwnedWriter(t)
	f := newInstallFixture(t)
	setDACL(t, f.dir, ownDACL(t, true, "(A;OICIIO;0x1301bf;;;BU)"))
	// The executable, made after the directory was given that entry, is protected
	// from it: it is the one thing in the directory that the check reads.
	setDACL(t, f.exe, ownDACL(t, false))
	install := f.open(t)
	if _, err := install.Stage(stagedName, strings.NewReader("the staged build"), -1); err != nil {
		t.Fatal(err)
	}
	// What an ordinary file made there inherits, to show that the directory does give it.
	writeText(t, f.path("ordinary.txt"), "x")
	var users uint32
	for _, entry := range readDescriptor(t, f.path("ordinary.txt")).entries {
		if entry.SID == sidUsers {
			users |= entry.Mask
		}
	}
	if users&0x1301bf != 0x1301bf {
		t.Fatalf("the directory doesn't hand the Users the right to modify what is made in it (they have %#x), so this test shows nothing", users)
	}
	requireOnlyRootAndThese(t, f.path(stagedName), executableAccess())
}

func TestStageRefusesWhatItMustNotWrite(t *testing.T) {
	requireRootOwnedWriter(t)
	f := newInstallFixture(t)
	install := f.open(t)
	for _, name := range []string{"vectory.exe", "VECTORY.EXE", "", ".", "..", `..\vectory.exe`, "a/b", "a:stream", "nul", "con.txt"} {
		if _, err := install.Stage(name, strings.NewReader("x"), 1); err == nil {
			t.Errorf("Stage(%q) succeeded", name)
		}
	}
	if got := contentOf(t, f.exe); got != installedText {
		t.Errorf("the executable was changed: %q", got)
	}

	// A name that is taken is not replaced.
	writeText(t, f.path(stagedName), "somebody's file")
	if _, err := install.Stage(stagedName, strings.NewReader("x"), 1); err == nil {
		t.Error("a name that exists was staged over")
	}
	if got := contentOf(t, f.path(stagedName)); got != "somebody's file" {
		t.Errorf("the file that was there is now %q", got)
	}
	if err := os.Remove(f.path(stagedName)); err != nil {
		t.Fatal(err)
	}

	// A link planted at the name is not followed.
	target := f.path("target.txt")
	if err := os.Symlink(target, f.path(stagedName)); err == nil {
		if _, err := install.Stage(stagedName, strings.NewReader("x"), 1); err == nil {
			t.Error("a link at the name was staged through")
		}
		if exists(t, target) {
			t.Error("the file the link pointed at was made")
		}
		if err := os.Remove(f.path(stagedName)); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Logf("can't make a symbolic link here, so a link at the staged name isn't tried: %v", err)
	}

	// A source of another size than it was said to be leaves nothing behind.
	for name, tc := range map[string]struct {
		content string
		size    int64
	}{"shorter": {"abc", 5}, "longer": {"abcdef", 3}} {
		if _, err := install.Stage(stagedName, strings.NewReader(tc.content), tc.size); err == nil {
			t.Errorf("a source that is %s than its size was staged", name)
		}
		if exists(t, f.path(stagedName)) {
			t.Errorf("a source that is %s than its size left the staged file", name)
		}
	}

	// A source of unknown size is read to its end.
	if _, err := install.Stage(stagedName, strings.NewReader("anything"), -1); err != nil {
		t.Errorf("an unknown size: %v", err)
	}
}

func TestSwapKeepsThePreviousBuildBesideTheExecutableAndRestoreTakesItBack(t *testing.T) {
	f := newInstallFixture(t)
	writeText(t, f.path(stagedName), "the first update")
	install := f.open(t)
	if err := install.Swap(stagedName, f.previous); err != nil {
		t.Fatal(err)
	}
	if contentOf(t, f.exe) != "the first update" || contentOf(t, f.path(f.previous)) != installedText || exists(t, f.path(stagedName)) {
		t.Fatalf("after the swap: the executable %q, the previous build %q, the staged file there: %v",
			contentOf(t, f.exe), contentOf(t, f.path(f.previous)), exists(t, f.path(stagedName)))
	}
	install.Close()

	// A second update replaces the build the first kept.
	writeText(t, f.path(stagedName), "the second update")
	install = f.open(t)
	if err := install.Swap(stagedName, f.previous); err != nil {
		t.Fatal(err)
	}
	if contentOf(t, f.exe) != "the second update" || contentOf(t, f.path(f.previous)) != "the first update" {
		t.Fatalf("after the second swap: the executable %q, the previous build %q", contentOf(t, f.exe), contentOf(t, f.path(f.previous)))
	}
	install.Close()

	// The restore puts the previous build back, and the build that was under trial
	// steps aside under the name the step removes.
	install = f.open(t)
	if err := install.Restore(f.previous); err != nil {
		t.Fatal(err)
	}
	if contentOf(t, f.exe) != "the first update" || exists(t, f.path(f.previous)) || contentOf(t, f.path(f.previous+".new")) != "the second update" {
		t.Fatalf("after the restore: the executable %q, the previous build there: %v, the build that stepped aside %q",
			contentOf(t, f.exe), exists(t, f.path(f.previous)), contentOf(t, f.path(f.previous+".new")))
	}
	if err := install.Remove(f.previous + ".new"); err != nil {
		t.Fatal(err)
	}
	// The install holds the build that stepped aside (it is the executable it opened),
	// so that file is gone when the install lets go of it.
	install.Close()
	if exists(t, f.path(f.previous+".new")) {
		t.Error("Remove left the file")
	}
	install = f.open(t)
	if err := install.Remove(f.previous + ".new"); err != nil {
		t.Errorf("removing a file that isn't there: %v", err)
	}
}

func TestSwapAndRestoreRefuseWhatIsNotAnotherFileOfTheDirectory(t *testing.T) {
	f := newInstallFixture(t)
	writeText(t, f.path(stagedName), "the update")
	install := f.open(t)
	for _, tc := range []struct{ staged, previous string }{
		{"vectory.exe", f.previous}, {stagedName, "vectory.exe"}, {stagedName, stagedName},
		{`..\x`, f.previous}, {stagedName, "a/b"}, {"", f.previous}, {stagedName, ""},
		// previous.new is the name restore uses, and must be a name too.
		{stagedName, strings.Repeat("p", 252)},
	} {
		if err := install.Swap(tc.staged, tc.previous); err == nil {
			t.Errorf("Swap(%q, %q) succeeded", tc.staged, tc.previous)
		}
	}
	if err := install.Restore("vectory.exe"); err == nil {
		t.Error("Restore of the executable itself succeeded")
	}
	if err := install.Restore("a/b"); err == nil {
		t.Error("Restore of a path succeeded")
	}
	if err := install.Remove("vectory.exe"); err == nil {
		t.Error("Remove of the executable succeeded")
	}
	if contentOf(t, f.exe) != installedText || contentOf(t, f.path(stagedName)) != "the update" {
		t.Error("a refused call changed the directory")
	}
	// With no previous build to put back, a restore changes nothing.
	if err := install.Restore(f.previous); err == nil {
		t.Error("a restore with nothing to restore succeeded")
	}
	if contentOf(t, f.exe) != installedText || exists(t, f.path(f.previous+".new")) {
		t.Error("a restore with nothing to restore moved the executable")
	}
}

// A file another program holds is waited for: a virus scanner reads what was written
// a second ago, and the renames ask for the file with delete access, which a holder
// that doesn't share deletion refuses until it lets go.
func TestASwapWaitsForAProgramThatHoldsAFileItNeeds(t *testing.T) {
	for name, held := range map[string]func(f installFixture) string{
		// the staged file, which the second rename takes
		"the staged file": func(f installFixture) string { return f.path(stagedName) },
		// the build kept from the earlier update, which the first rename replaces
		"the previous build": func(f installFixture) string { return f.path(f.previous) },
	} {
		t.Run(name, func(t *testing.T) {
			f := newInstallFixture(t)
			writeText(t, f.path(stagedName), "the update")
			writeText(t, f.path(f.previous), "an older build")
			install := f.open(t)
			release := holdFile(t, held(f))
			time.AfterFunc(1200*time.Millisecond, release)
			start := time.Now()
			if err := install.Swap(stagedName, f.previous); err != nil {
				t.Fatalf("the swap after a hold of 1.2 s: %v", err)
			}
			if took := time.Since(start); took < time.Second {
				t.Errorf("the swap took %s, so it didn't wait for the hold", took)
			}
			if contentOf(t, f.exe) != "the update" || contentOf(t, f.path(f.previous)) != installedText {
				t.Errorf("after the swap: the executable %q, the previous build %q", contentOf(t, f.exe), contentOf(t, f.path(f.previous)))
			}
		})
	}
}

// A file that is held for good ends the swap, and what it ends with is the
// executable that was there: the first rename is undone, so that the directory holds
// the build it held and the step has an update that didn't happen, not a gap.
func TestASwapThatCannotGoOnPutsTheExecutableBack(t *testing.T) {
	f := newInstallFixture(t)
	writeText(t, f.path(stagedName), "the update")
	install := f.open(t)
	release := holdFile(t, f.path(stagedName))
	time.AfterFunc(12*time.Second, release)
	start := time.Now()
	err := install.Swap(stagedName, f.previous)
	if err == nil {
		t.Fatal("a swap whose staged file is held for good succeeded")
	}
	t.Logf("the swap gave up after %s: %v", time.Since(start).Round(100*time.Millisecond), err)
	if got := contentOf(t, f.exe); got != installedText {
		t.Errorf("the executable is %q, not the build that was installed", got)
	}
	if exists(t, f.path(f.previous)) {
		t.Error("the previous build was left beside the executable that was put back")
	}
	if !exists(t, f.path(stagedName)) {
		t.Error("the staged file is gone")
	}
	var linkErr *os.LinkError
	if !errors.As(err, &linkErr) {
		t.Errorf("the error isn't the failed rename: %v", err)
	}
	if _, present, err := install.Digest("vectory.exe"); err != nil || !present {
		t.Errorf("the executable can't be read after the failed swap: present %v, %v", present, err)
	}
}

// The image of a running program can be renamed: this is what the swap rests on,
// because the agent's service has just been stopped, and a process that has stopped
// may not have let go of its executable yet. The executable is the source of the
// first rename, never a file that one replaces.
func TestTheExecutableOfARunningProgramIsSteppedAsideAndThePreviousBuildStaysIntact(t *testing.T) {
	f := newInstallFixture(t)
	copyTestBinary(t, f.exe)
	running := startRunning(t, f.exe)
	installed := sha256OfFile(t, f.exe)
	writeText(t, f.path(stagedName), "the update")
	install := f.open(t)
	if err := install.Swap(stagedName, f.previous); err != nil {
		t.Fatalf("a running program's executable can't be stepped aside: %v", err)
	}
	if !stillRunning(running) {
		t.Error("the program stopped when its executable was renamed")
	}
	if contentOf(t, f.exe) != "the update" {
		t.Errorf("the executable is %q", contentOf(t, f.exe))
	}
	if got := sha256OfFile(t, f.path(f.previous)); got != installed {
		t.Errorf("the previous build is %s, want the running program's file, %s", got, installed)
	}

	// The file that is running can't be removed, and the removal that waits for it
	// succeeds when the program ends: the service stopped a moment ago, and its image
	// is still mapped.
	if err := deleteFile(f.path(f.previous), moveRetry{attempts: 1}); err == nil {
		t.Error("the file of a running program was removed")
	} else {
		t.Logf("removing the file of a running program: %v", err)
	}
	time.AfterFunc(1500*time.Millisecond, func() { stopRunning(running) })
	if err := install.Remove(f.previous); err != nil {
		t.Errorf("removing the previous build after its program ended: %v", err)
	}
	// The install holds that file too (it is the executable it opened).
	install.Close()
	if exists(t, f.path(f.previous)) {
		t.Error("the file of the program that ended is still there")
	}
}

// What Windows allows for the image of a program that runs, as the design assumes
// it, measured: the renames are what the step relies on, and the rest explains why
// the step doesn't try anything else. Only a rename is required; the others are
// logged, so that a run of this test on a new release of Windows says what changed.
func TestMeasureWhatWindowsAllowsForTheImageOfAProgramThatRuns(t *testing.T) {
	dir := ownTree(t)
	image := filepath.Join(dir, "vectory.exe")
	copyTestBinary(t, image)
	running := startRunning(t, image)
	once := moveRetry{attempts: 1}
	note := func(what string, err error) {
		t.Helper()
		if err == nil {
			t.Logf("%-60s allowed", what)
			return
		}
		t.Logf("%-60s refused: %v", what, err)
	}
	another := func(name string) string {
		path := filepath.Join(dir, name)
		writeText(t, path, "another file")
		return path
	}

	note("overwriting the image", os.WriteFile(image, []byte("x"), 0o644))
	note("removing the image", deleteFile(image, once))
	note("renaming another file over the image (a replace)", moveFile(another("a.exe"), image, once))

	// What the swap does: the image steps aside under another name.
	aside := filepath.Join(dir, "vectory.exe.previous")
	start := time.Now()
	if err := moveFile(image, aside, once); err != nil {
		t.Fatalf("renaming the image of a running program: %v", err)
	}
	t.Logf("%-60s allowed, in %s", "renaming the image (the step's first rename, written through)", time.Since(start).Round(time.Microsecond))
	if !stillRunning(running) {
		t.Error("the program stopped when its image was renamed")
	}
	note("removing the image under its new name", deleteFile(aside, once))
	note("renaming another file to the name the image had", moveFile(another("b.exe"), image, once))

	// What a program that holds a file open (no delete sharing) does to a rename.
	held := another("held.exe")
	release := holdFile(t, held)
	note("renaming another file over a file that is open elsewhere", moveFile(another("c.exe"), held, once))
	note("renaming a file that is open elsewhere", moveFile(held, filepath.Join(dir, "moved.exe"), once))
	release()

	stopRunning(running)
	if !becomes(5*time.Second, func() bool { return deleteFile(aside, once) == nil }) {
		t.Error("the image of a program that ended can't be removed")
	}
}

// A directory the step holds can't be renamed while it is held, which is what keeps
// the swap's path from changing under it: held with the right to list it, and without
// delete sharing, a directory is subject to sharing, and a rename asks for delete.
func TestTheInstallDirectoryCannotBeRenamedWhileTheStepHoldsIt(t *testing.T) {
	f := newInstallFixture(t)
	install := f.open(t)
	moved := f.dir + "-moved"
	if err := os.Rename(f.dir, moved); err == nil {
		t.Error("the install directory was renamed while it was held")
		_ = os.Rename(moved, f.dir)
	} else {
		t.Logf("renaming the held install directory: %v", err)
	}
	above := filepath.Dir(f.dir)
	if err := os.Rename(above, above+"-moved"); err == nil {
		t.Error("a directory above the install directory was renamed while it was held")
		_ = os.Rename(above+"-moved", above)
	} else {
		t.Logf("renaming the directory above it: %v", err)
	}
	if err := install.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.dir, moved); err != nil {
		t.Errorf("the directory can't be renamed after the install is closed: %v", err)
	}
}

// A rename waits for a hold as long as it is told to and says what the system
// answered when it gave up; one that isn't a hold (the file isn't there) is not
// waited for.
func TestARenameWaitsForAHoldOnItsSourceAndThenGivesUp(t *testing.T) {
	dir := ownTree(t)
	from, to := filepath.Join(dir, "from"), filepath.Join(dir, "to")
	writeText(t, from, "x")
	hold := holdFile(t, from)
	start := time.Now()
	err := moveFile(from, to, moveRetry{attempts: 3, wait: 100 * time.Millisecond})
	if err == nil {
		t.Fatal("a file that is held was renamed")
	}
	if took := time.Since(start); took < 150*time.Millisecond {
		t.Errorf("the rename gave up after %s, before its attempts were used", took)
	}
	if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Errorf("a source that is held without delete sharing answered %v, not a sharing violation", err)
	}
	var linkErr *os.LinkError
	if !errors.As(err, &linkErr) || linkErr.Old != from || linkErr.New != to {
		t.Errorf("the error doesn't name the rename: %v", err)
	}
	hold()
	if err := moveFile(from, to, moveRetry{attempts: 1}); err != nil {
		t.Fatal(err)
	}
	if exists(t, from) || contentOf(t, to) != "x" {
		t.Error("the rename didn't move the file")
	}

	start = time.Now()
	if err := moveFile(from, to, moveRetry{attempts: 5, wait: time.Second}); err == nil {
		t.Error("a file that isn't there was renamed")
	}
	if took := time.Since(start); took > 900*time.Millisecond {
		t.Errorf("a rename of a file that isn't there waited %s", took)
	}
}

func TestRemoveOfAFileThatIsNotThereIsNotAnError(t *testing.T) {
	dir := ownTree(t)
	if err := deleteFile(filepath.Join(dir, "nothing"), holdRetry); err != nil {
		t.Errorf("%v", err)
	}
	if err := deleteFile(filepath.Join(dir, "no directory", "nothing"), holdRetry); err != nil {
		t.Errorf("%v", err)
	}
}
