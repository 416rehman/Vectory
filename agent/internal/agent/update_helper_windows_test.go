//go:build windows

package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The Windows host's files and processes, on a real file system: what the step makes
// (with an access list of its own for each file), the lock, the replacement of the
// helper copy that is running, the reading of what the service account wrote, and
// the probe. The tests that make what only root may use run elevated (as the Windows
// job does) and skip otherwise.

// privateTree makes the directories of the step as setup does, in a tree the test owns:
// the private directory, held open as the step holds it.
func privateTree(t *testing.T) (*rootOwned, string) {
	t.Helper()
	requireRootOwnedWriter(t)
	path := filepath.Join(ownTree(t), "private")
	dir, err := ensureRootOwnedDir(path, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dir.Close() })
	return dir, path
}

func heldDirectory(t *testing.T, path string, leaf rootFilePerm) *rootOwned {
	t.Helper()
	dir, err := ensureRootOwnedDir(path, leaf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dir.Close() })
	return dir
}

func TestCopyIntoMakesTheFileWithTheAccessListThePermissionNames(t *testing.T) {
	dir, path := privateTree(t)
	host := newWindowsUpdateHost()
	for name, tc := range map[string]struct {
		perm rootFilePerm
		want map[string]uint32
	}{
		"private.bin":    {rootPrivate, privateAccess()},
		"readable.bin":   {rootReadable, readableAccess()},
		"executable.bin": {rootExecutable, executableAccess()},
	} {
		digest, err := host.CopyInto(dir, name, tc.perm, strings.NewReader("some bytes"), int64(len("some bytes")))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if digest != sha256OfText("some bytes") {
			t.Errorf("%s: the digest read back is %s", name, digest)
		}
		if got := contentOf(t, filepath.Join(path, name)); got != "some bytes" {
			t.Errorf("%s holds %q", name, got)
		}
		requireOnlyRootAndThese(t, filepath.Join(path, name), tc.want)
	}
}

func TestCopyIntoRefusesAndCleansUpWhatItMustNot(t *testing.T) {
	dir, path := privateTree(t)
	host := newWindowsUpdateHost()
	named := func(name string) string { return filepath.Join(path, name) }

	// A name that is taken is not replaced.
	writeText(t, named("taken"), "what was there")
	if _, err := host.CopyInto(dir, "taken", rootPrivate, strings.NewReader("new"), 3); err == nil {
		t.Error("a name that exists was copied over")
	}
	if got := contentOf(t, named("taken")); got != "what was there" {
		t.Errorf("the file that was there is now %q", got)
	}

	// A source that isn't the size it was said to be, or that fails, leaves nothing.
	failing := io.MultiReader(strings.NewReader("abc"), errReader{errors.New("the source failed")})
	for what, tc := range map[string]struct {
		src  io.Reader
		size int64
	}{
		"a source shorter than its size": {strings.NewReader("abc"), 5},
		"a source longer than its size":  {strings.NewReader("abcdef"), 3},
		"a source that fails":            {failing, -1},
	} {
		if _, err := host.CopyInto(dir, "made", rootPrivate, tc.src, tc.size); err == nil {
			t.Errorf("%s was copied", what)
		}
		if exists(t, named("made")) {
			t.Errorf("%s left its file behind", what)
		}
	}
	// A size of -1 reads the source to its end.
	if digest, err := host.CopyInto(dir, "made", rootPrivate, strings.NewReader("to the end"), -1); err != nil || digest != sha256OfText("to the end") {
		t.Errorf("an unknown size: %q, %v", digest, err)
	}

	// Names that aren't names in the directory.
	for _, name := range []string{"", "..", `..\x`, "a/b", "a:b", "nul", "con.txt"} {
		if _, err := host.CopyInto(dir, name, rootPrivate, strings.NewReader("x"), 1); err == nil {
			t.Errorf("CopyInto(%q) succeeded", name)
		}
	}

	// A link planted at the name is not followed.
	target := named("linked-to")
	if err := os.Symlink(target, named("link")); err == nil {
		if _, err := host.CopyInto(dir, "link", rootPrivate, strings.NewReader("x"), 1); err == nil {
			t.Error("a link at the name was copied through")
		}
		if exists(t, target) {
			t.Error("the file the link pointed at was made")
		}
	} else {
		t.Logf("can't make a symbolic link here, so a link at the name isn't tried: %v", err)
	}
}

// errReader fails every read.
type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

func TestRemoveFromAndEmptyDirRemoveWhatTheStepMade(t *testing.T) {
	dir, path := privateTree(t)
	host := newWindowsUpdateHost()
	for _, name := range []string{"a", "b.json", "c.bin"} {
		writeText(t, filepath.Join(path, name), name)
	}
	mkdirAll(t, filepath.Join(path, "sub", "deeper"))
	writeText(t, filepath.Join(path, "sub", "deeper", "d"), "d")

	if err := host.RemoveFrom(dir, "a"); err != nil {
		t.Fatal(err)
	}
	if err := host.RemoveFrom(dir, "a"); err != nil {
		t.Errorf("removing a file that isn't there: %v", err)
	}
	for _, name := range []string{"..", `..\private`, "x/y", ""} {
		if err := host.RemoveFrom(dir, name); err == nil {
			t.Errorf("RemoveFrom(%q) succeeded", name)
		}
	}
	// A file another program holds for a moment is waited for.
	release := holdFile(t, filepath.Join(path, "b.json"))
	time.AfterFunc(1200*time.Millisecond, release)
	start := time.Now()
	if err := host.RemoveFrom(dir, "b.json"); err != nil {
		t.Fatalf("removing a file held for 1.2 s: %v", err)
	}
	if took := time.Since(start); took < time.Second {
		t.Errorf("the removal took %s, so it didn't wait for the hold", took)
	}
	if exists(t, filepath.Join(path, "b.json")) {
		t.Error("the file is still there")
	}

	if err := host.EmptyDir(dir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Errorf("the directory holds %v after it was emptied (%v)", entries, err)
	}
	// The directory is still the one the step holds.
	if _, err := host.CopyInto(dir, "again", rootPrivate, strings.NewReader("x"), 1); err != nil {
		t.Errorf("copying into the emptied directory: %v", err)
	}
}

func TestTheLockRefusesASecondRunUntilTheFirstLetsGo(t *testing.T) {
	private, path := privateTree(t)
	host := newWindowsUpdateHost()
	release, err := host.Lock(private)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.Lock(private); !errors.Is(err, errUpdateStepBusy) {
		t.Errorf("a second lock gave %v, want errUpdateStepBusy", err)
	}
	// The lock file is the step's: root's alone.
	requireOnlyRootAndThese(t, filepath.Join(path, updateLockFile), privateAccess())
	release()
	release, err = host.Lock(private)
	if err != nil {
		t.Fatalf("the lock after the first was let go of: %v", err)
	}
	release()
}

// A lock file that someone else made, or can change, is refused: the step's lock is
// in a directory only root can write, and a file there that isn't root's is not
// something the step put there.
func TestTheLockRefusesAFileOthersCanChangeAndALinkInItsPlace(t *testing.T) {
	private, path := privateTree(t)
	host := newWindowsUpdateHost()
	lock := filepath.Join(path, updateLockFile)
	writeText(t, lock, "")
	setDACL(t, lock, "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FW;;;BU)")
	_, err := host.Lock(private)
	refusedAs(t, err)
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(filepath.Join(path, "elsewhere"), lock); err != nil {
		t.Skipf("can't make a symbolic link here: %v", err)
	}
	_, err = host.Lock(private)
	refusedAs(t, err)
	if exists(t, filepath.Join(path, "elsewhere")) {
		t.Error("the lock followed a link and made the file it pointed at")
	}
}

// What an update leaves beside the helper copy when it replaced one that was
// running is removed by the next run, once the program that ran it has ended.
func TestTheLockRemovesTheOldHelperCopiesThatHaveEnded(t *testing.T) {
	private, path := privateTree(t)
	host := newWindowsUpdateHost()
	helper := filepath.Join(path, updateHelperDir)
	mkdirAll(t, helper)
	for _, name := range []string{"vectory.exe", "vectory.exe.old-00ff", "vectory.exe.old-aaaa", "vectory.exe.next", "other.exe.old-1"} {
		writeText(t, filepath.Join(helper, name), name)
	}
	// One of the old copies is still running, and can't be removed.
	copyTestBinary(t, filepath.Join(helper, "vectory.exe.old-aaaa"))
	running := startRunning(t, filepath.Join(helper, "vectory.exe.old-aaaa"))

	release, err := host.Lock(private)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if exists(t, filepath.Join(helper, "vectory.exe.old-00ff")) {
		t.Error("an old copy that isn't running was left")
	}
	for _, name := range []string{"vectory.exe", "vectory.exe.next", "other.exe.old-1"} {
		if !exists(t, filepath.Join(helper, name)) {
			t.Errorf("%s was removed", name)
		}
	}
	if !exists(t, filepath.Join(helper, "vectory.exe.old-aaaa")) {
		t.Fatal("the old copy that is running was removed")
	}

	// A run after the program has ended removes it (the image of a process that has
	// just ended can stay mapped for a moment, so the runs are repeated).
	stopRunning(running)
	if !becomes(5*time.Second, func() bool {
		release, err := host.Lock(private)
		if err != nil {
			return false
		}
		release()
		return !exists(t, filepath.Join(helper, "vectory.exe.old-aaaa"))
	}) {
		t.Error("the old copy of a program that ended was left")
	}
}

// The helper copy is the file the step runs from, and it is replaced by the step
// that runs from it: a running image can be renamed but not replaced, so the copy
// that is there steps aside under a name of its own and the new one takes its name.
func TestReplaceStepsAsideAHelperCopyThatIsRunningAndReplacesOneThatIsNot(t *testing.T) {
	_, path := privateTree(t)
	helperPath := filepath.Join(path, updateHelperDir)
	helper := heldDirectory(t, helperPath, rootPrivate)
	host := newWindowsUpdateHost()
	exe := filepath.Join(helperPath, "vectory.exe")
	copyTestBinary(t, exe)
	running := startRunning(t, exe)
	before := sha256OfFile(t, exe)

	if _, err := host.CopyInto(helper, "vectory.exe.next", rootExecutable, strings.NewReader("the next helper"), -1); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := host.Replace(helper, "vectory.exe.next", "vectory.exe"); err != nil {
		t.Fatalf("replacing a helper copy that is running: %v", err)
	}
	t.Logf("replacing the helper copy that is running took %s", time.Since(start).Round(time.Millisecond))
	if got := contentOf(t, exe); got != "the next helper" {
		t.Errorf("the helper copy holds %q", got)
	}
	if exists(t, filepath.Join(helperPath, "vectory.exe.next")) {
		t.Error("the new copy is still beside the helper")
	}
	var aside string
	entries, err := os.ReadDir(helperPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "vectory.exe"+helperAsideMarker) {
			aside = filepath.Join(helperPath, entry.Name())
		}
	}
	if aside == "" {
		t.Fatalf("no copy stepped aside: %v", entries)
	}
	if got := sha256OfFile(t, aside); got != before {
		t.Errorf("the copy that stepped aside is %s, want the one that was running, %s", got, before)
	}
	if !stillRunning(running) {
		t.Error("the helper copy stopped when it was replaced")
	}
	requireOnlyRootAndThese(t, exe, executableAccess())

	// A copy that is not running is replaced in place.
	stopRunning(running)
	if _, err := host.CopyInto(helper, "vectory.exe.next", rootExecutable, strings.NewReader("the helper after"), -1); err != nil {
		t.Fatal(err)
	}
	if !becomes(5*time.Second, func() bool { return host.Replace(helper, "vectory.exe.next", "vectory.exe") == nil }) {
		t.Fatal("a helper copy that isn't running can't be replaced")
	}
	if got := contentOf(t, exe); got != "the helper after" {
		t.Errorf("the helper copy holds %q", got)
	}
}

func TestReplaceRefusesWhatItCannotDoAndChangesNothing(t *testing.T) {
	_, path := privateTree(t)
	helper := heldDirectory(t, filepath.Join(path, updateHelperDir), rootPrivate)
	host := newWindowsUpdateHost()
	writeText(t, filepath.Join(path, updateHelperDir, "vectory.exe"), "the helper")
	if err := host.Replace(helper, "missing", "vectory.exe"); err == nil {
		t.Error("a replace from a file that isn't there succeeded")
	}
	for _, names := range [][2]string{{"..", "vectory.exe"}, {"vectory.exe.next", `..\x`}, {"a/b", "c"}} {
		if err := host.Replace(helper, names[0], names[1]); err == nil {
			t.Errorf("Replace(%q, %q) succeeded", names[0], names[1])
		}
	}
	entries, err := os.ReadDir(filepath.Join(path, updateHelperDir))
	if err != nil || len(entries) != 1 || contentOf(t, filepath.Join(path, updateHelperDir, "vectory.exe")) != "the helper" {
		t.Errorf("the helper directory changed: %v, %v", entries, err)
	}
}

func TestCheckPrivateRefusesADirectoryAnotherAccountCouldEnter(t *testing.T) {
	private, path := privateTree(t)
	host := newWindowsUpdateHost()
	if err := host.CheckPrivate(private); err != nil {
		t.Fatalf("the private directory setup makes: %v", err)
	}
	for name, entry := range map[string]string{
		"Users may read it":                        "(A;OICI;FR;;;BU)",
		"Users may read what is made in it, later": "(A;OICIIO;FR;;;BU)",
		"the agent's service may list it":          "(A;;FR;;;" + serviceSID(ServiceName) + ")",
	} {
		setDACL(t, path, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"+entry)
		err := host.CheckPrivate(private)
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != "UNTRUSTED_LOCATION" {
			t.Errorf("%s: %v, want UNTRUSTED_LOCATION", name, err)
		}
	}
	setDACL(t, path, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err := host.CheckPrivate(private); err != nil {
		t.Errorf("after the directory was closed again: %v", err)
	}
}

func TestFreeSpaceIsWhatTheVolumeHasLeft(t *testing.T) {
	private, _ := privateTree(t)
	free, err := newWindowsUpdateHost().FreeSpace(private)
	if err != nil || free == 0 {
		t.Errorf("free space %d, %v", free, err)
	}
}

// ---------------------------------------------------------------- the service account's files

func TestOpenServiceFileReadsWhatTheServiceAccountWrote(t *testing.T) {
	tree := ownTree(t)
	state := filepath.Join(tree, "state")
	mkdirAll(t, state)
	writeText(t, filepath.Join(state, "request.json"), `{"a":1}`)
	host := newWindowsUpdateHost()
	account := updateAccount{Name: `NT SERVICE\Vectory`, UID: windowsServiceIdentity, GID: windowsServiceIdentity}

	file, err := host.OpenServiceFile(state, "request.json", account, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer file.File.Close()
	if file.Size != 7 {
		t.Errorf("size %d", file.Size)
	}
	if age := time.Since(file.ModTime); age < 0 || age > 5*time.Minute {
		t.Errorf("the modification time is %s, %s ago", file.ModTime, age)
	}
	data, err := io.ReadAll(file.File)
	if err != nil || string(data) != `{"a":1}` {
		t.Errorf("read %q, %v", data, err)
	}

	// The agent that wrote the file replaces it while the step reads it: the step
	// shares everything and waits for nobody.
	writer, err := os.OpenFile(filepath.Join(state, "request.json"), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	again, err := host.OpenServiceFile(state, "request.json", account, 1024)
	if err != nil {
		t.Errorf("a file that is open for writing elsewhere: %v", err)
	} else {
		again.File.Close()
	}
}

func TestOpenServiceFileRefusesWhatIsNotAPlainFileOfTheAccount(t *testing.T) {
	tree := ownTree(t)
	state := filepath.Join(tree, "state")
	mkdirAll(t, state)
	host := newWindowsUpdateHost()
	account := updateAccount{Name: `NT SERVICE\Vectory`, UID: windowsServiceIdentity, GID: windowsServiceIdentity}
	writeText(t, filepath.Join(state, "big.json"), strings.Repeat("x", 100))

	if _, err := host.OpenServiceFile(state, "big.json", account, 10); !errors.Is(err, errServiceFileTooLarge) {
		t.Errorf("a file larger than the limit: %v", err)
	}
	if _, err := host.OpenServiceFile(state, "missing.json", account, 10); !notExist(err) {
		t.Errorf("a file that isn't there: %v", err)
	}
	mkdirAll(t, filepath.Join(state, "directory.json"))
	if _, err := host.OpenServiceFile(state, "directory.json", account, 10); err == nil {
		t.Error("a directory was opened as a file")
	}
	for _, name := range []string{"", "..", `..\big.json`, "a/b", "nul"} {
		if _, err := host.OpenServiceFile(state, name, account, 10); err == nil {
			t.Errorf("OpenServiceFile(%q) succeeded", name)
		}
	}

	// A link in place of the file is refused, not followed.
	if err := os.Symlink(filepath.Join(tree, "elsewhere.json"), filepath.Join(state, "link.json")); err == nil {
		_, err := host.OpenServiceFile(state, "link.json", account, 1024)
		refusedAs(t, err)
	} else {
		t.Logf("can't make a symbolic link here, so a link in place of the file isn't tried: %v", err)
	}

	// A file with a second name may be a link to a file that isn't the account's.
	if err := os.Link(filepath.Join(state, "big.json"), filepath.Join(state, "second-name.json")); err == nil {
		_, err := host.OpenServiceFile(state, "second-name.json", account, 1024)
		if refusal := refusedAs(t, err); !strings.Contains(refusal.Detail, "2 names") {
			t.Errorf("a file with two names: %q", refusal.Detail)
		}
	} else {
		t.Logf("can't make a hard link here: %v", err)
	}

	// A directory above the file that is a junction is refused, as everywhere.
	real := filepath.Join(tree, "real-state")
	mkdirAll(t, real)
	writeText(t, filepath.Join(real, "request.json"), "{}")
	junction := filepath.Join(tree, "junction-state")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, real).CombinedOutput(); err != nil {
		t.Logf("can't make a junction here: %v: %s", err, out)
	} else if _, err := host.OpenServiceFile(junction, "request.json", account, 1024); err == nil {
		t.Error("a file below a junction was opened")
	} else {
		refusedAs(t, err)
	}
}

// ---------------------------------------------------------------- the probe

func TestTheProbeRunsTheBuildAndReadsWhatItPrints(t *testing.T) {
	dir := ownTree(t)
	good := filepath.Join(dir, "vectory.exe")
	copyTestBinary(t, good)
	output, err := runProbe(context.Background(), good, 20*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if version, err := probeVersionOf(output); err != nil || version != "0.1.0" {
		t.Errorf("the probe read %q: %q, %v", output, version, err)
	}
	if refusal := checkProbeOutput(output, "0.1.0"); refusal != nil {
		t.Errorf("what the build prints doesn't pass the check: %v", refusal)
	}
	// Through the host, which says who the build runs as and doesn't need to.
	viaHost, err := newWindowsUpdateHost().RunProbe(context.Background(), good, updateAccount{})
	if err != nil || string(viaHost) != string(output) {
		t.Errorf("RunProbe: %q, %v", viaHost, err)
	}
}

func TestTheProbeEndsABuildThatDoesNotAnswerPrintsTooMuchOrFails(t *testing.T) {
	dir := ownTree(t)
	for name, tc := range map[string]struct {
		file  string
		check func(t *testing.T, output []byte, err error)
	}{
		"hangs": {"probe-hangs.exe", func(t *testing.T, output []byte, err error) {
			if err == nil || !strings.Contains(err.Error(), "didn't finish") {
				t.Errorf("a build that never answers: %q, %v", output, err)
			}
		}},
		"prints too much": {"probe-noisy.exe", func(t *testing.T, output []byte, err error) {
			if !errors.Is(err, errProbeOutputTooLong) {
				t.Errorf("a build that prints 8 KiB: %v", err)
			}
		}},
		"fails": {"probe-fails.exe", func(t *testing.T, output []byte, err error) {
			if err == nil || !strings.Contains(err.Error(), "failed") {
				t.Errorf("a build that exits with an error: %q, %v", output, err)
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, tc.file)
			copyTestBinary(t, path)
			start := time.Now()
			output, err := runProbe(context.Background(), path, 2*time.Second)
			tc.check(t, output, err)
			if took := time.Since(start); took > 8*time.Second {
				t.Errorf("the probe took %s", took)
			}
		})
	}

	// The probe of a build that isn't there, and a probe the step itself ends.
	if _, err := runProbe(context.Background(), filepath.Join(dir, "nothing.exe"), 2*time.Second); err == nil {
		t.Error("a build that isn't there was probed")
	}
	path := filepath.Join(dir, "probe-hangs.exe")
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(500*time.Millisecond, cancel)
	if _, err := runProbe(ctx, path, time.Minute); !errors.Is(err, context.Canceled) {
		t.Errorf("a probe the step ends: %v", err)
	}
}
