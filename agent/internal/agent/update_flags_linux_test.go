//go:build linux

package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// The inode flags of Linux, set the way chattr sets them and read back by the step the
// way it reads them: through the handles it holds. The tests skip, saying why, where the
// flag can't be set here: it takes CAP_LINUX_IMMUTABLE (root's) and a file system that
// keeps the flag.

// flagInode sets an inode flag on path through the file's own handle, and clears it when
// the test ends, before the test's directory is removed.
func flagInode(t *testing.T, path string, flag uint32) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	fd := int(file.Fd())
	current, err := unix.IoctlGetUint32(fd, unix.FS_IOC_GETFLAGS)
	if err != nil {
		t.Skipf("the file system of %s keeps no inode flags (FS_IOC_GETFLAGS: %v)", path, err)
	}
	if err := unix.IoctlSetPointerInt(fd, unix.FS_IOC_SETFLAGS, int(current|flag)); err != nil {
		t.Skipf("the flag %#x can't be set on %s: %v (it takes root with CAP_LINUX_IMMUTABLE, on a file system that supports it)", flag, path, err)
	}
	t.Cleanup(func() { unflagInode(t, path, flag) })
}

func unflagInode(t *testing.T, path string, flag uint32) {
	t.Helper()
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		// The step renamed or removed it, which a file with a flag can't be.
		return
	}
	if err != nil {
		t.Errorf("the flag on %s couldn't be cleared: %v", path, err)
		return
	}
	defer file.Close()
	fd := int(file.Fd())
	current, err := unix.IoctlGetUint32(fd, unix.FS_IOC_GETFLAGS)
	if err != nil {
		t.Errorf("the flag on %s couldn't be cleared: %v", path, err)
		return
	}
	if err := unix.IoctlSetPointerInt(fd, unix.FS_IOC_SETFLAGS, int(current&^flag)); err != nil {
		t.Errorf("the flag on %s couldn't be cleared: %v", path, err)
	}
}

func TestTheStepSeesAnImmutableOrAppendOnlyExecutableOrDirectoryThroughItsHandles(t *testing.T) {
	for name, c := range map[string]struct {
		flag   uint32
		onFile bool
		words  []string
	}{
		"an immutable executable":   {linuxImmutableFlag, true, []string{"the immutable attribute (chattr +i)", "so the update step can't replace it", "sudo chattr -i"}},
		"an append-only executable": {linuxAppendFlag, true, []string{"the append-only attribute (chattr +a)", "so the update step can't replace it", "sudo chattr -a"}},
		"an immutable directory":    {linuxImmutableFlag, false, []string{"the immutable attribute (chattr +i)", "so the update step can't add or remove files in it", "sudo chattr -i"}},
		"an append-only directory":  {linuxAppendFlag, false, []string{"the append-only attribute (chattr +a)", "so the update step can't add or remove files in it", "sudo chattr -a"}},
	} {
		t.Run(name, func(t *testing.T) {
			r := newSwapRig(t)
			if got := r.install.Immutable(); got != "" {
				t.Fatalf("an install with no flag: %q", got)
			}
			path := r.dir
			if c.onFile {
				path = r.exe
			}
			flagInode(t, path, c.flag)

			got := r.install.Immutable()

			for _, want := range append(c.words, path) {
				if !strings.Contains(got, want) {
					t.Errorf("the words for %s don't say %q:\n%s", name, want, got)
				}
			}
			other := r.exe
			if c.onFile {
				other = r.dir
			}
			if strings.Contains(got, other+" has") {
				t.Errorf("the words name %s, which has no flag:\n%s", other, got)
			}
		})
	}
}

// The executable and its directory are both asked, and a host with both flagged says so
// in one sentence for each, whichever is flagged.
func TestAnExecutableAndADirectoryThatAreBothFlaggedAreBothNamed(t *testing.T) {
	r := newSwapRig(t)
	flagInode(t, r.exe, linuxImmutableFlag)
	flagInode(t, r.dir, linuxAppendFlag)

	got := r.install.Immutable()

	for _, want := range []string{r.exe + " has the immutable attribute", r.dir + " has the append-only attribute"} {
		if !strings.Contains(got, want) {
			t.Errorf("the words don't say %q:\n%s", want, got)
		}
	}
}

// keepBesideTheExecutable makes a file in the install directory the way an earlier update
// left it, and returns its path.
func (f *stepFixture) keepBesideTheExecutable(name string) string {
	f.t.Helper()
	path := filepath.Join(f.installDir, name)
	if err := os.WriteFile(path, []byte("a build an earlier update kept"), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		f.t.Fatal(err)
	}
	return path
}

// The swap renames over the build an earlier update kept and over the link it makes first,
// and a flag on either stops it as it stops the replacing of the executable: the words name
// the file, and no other.
func TestTheStepSeesAFlagOnTheBuildsTheSwapRenamesOverAndNamesThatFile(t *testing.T) {
	for _, c := range []struct {
		name string
		flag uint32
		word string
	}{
		{updatePreviousName, linuxImmutableFlag, "the immutable attribute (chattr +i)"},
		{updatePreviousName, linuxAppendFlag, "the append-only attribute (chattr +a)"},
		{updatePreviousName + ".new", linuxImmutableFlag, "the immutable attribute (chattr +i)"},
		{updatePreviousName + ".new", linuxAppendFlag, "the append-only attribute (chattr +a)"},
	} {
		t.Run(c.name+" with "+c.word, func(t *testing.T) {
			r := newSwapRig(t)
			kept, other := filepath.Join(r.dir, updatePreviousName), filepath.Join(r.dir, updatePreviousName+".new")
			for _, path := range []string{kept, other} {
				if err := os.WriteFile(path, []byte("kept"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if got := r.install.Immutable(); got != "" {
				t.Fatalf("builds with no flag: %q", got)
			}
			path := filepath.Join(r.dir, c.name)
			flagInode(t, path, c.flag)

			got := r.install.Immutable()

			for _, want := range []string{path + " has " + c.word, "so the update step can't replace it", "sudo chattr -"} {
				if !strings.Contains(got, want) {
					t.Errorf("the words don't say %q:\n%s", want, got)
				}
			}
			notFlagged := kept
			if path == kept {
				notFlagged = other
			}
			if strings.Contains(got, notFlagged+" has") {
				t.Errorf("the words name %s, which has no flag:\n%s", notFlagged, got)
			}
		})
	}
}

// A build kept from an earlier update that can't be opened as a file the path check trusts,
// or isn't there, says nothing: the check is for what it can see.
func TestABuildKeptBesideTheExecutableThatIsNotThereOrNotTrustedHasNoFlagToFind(t *testing.T) {
	r := newSwapRig(t)
	if got := r.install.Immutable(); got != "" {
		t.Fatalf("with nothing kept: %q", got)
	}
	untrusted := filepath.Join(r.dir, updatePreviousName)
	if err := os.WriteFile(untrusted, []byte("kept"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(untrusted, 0o777); err != nil {
		t.Fatal(err)
	}
	flagInode(t, untrusted, linuxImmutableFlag)
	if got := r.install.Immutable(); got != "" {
		t.Errorf("a file everyone can write was read for its flags: %q", got)
	}
}

// An executable or a directory with a flag stops the swap after the service has stopped
// and the release's counter is spent, and so does a flag on the build an earlier update
// kept or on the link the swap makes first. The step finds it first: the host is READ_ONLY,
// the words name the flag and the command that clears it, nothing is raised, stopped or
// replaced, the request waits, and when the flag is cleared the next run applies it.
func TestAnImmutableExecutableOrDirectoryIsRefusedBeforeAnythingIsRaisedOrStopped(t *testing.T) {
	for name, c := range map[string]struct {
		flag uint32
		path func(f *stepFixture) string
	}{
		"an immutable executable":   {linuxImmutableFlag, func(f *stepFixture) string { return f.exe }},
		"an append-only executable": {linuxAppendFlag, func(f *stepFixture) string { return f.exe }},
		"an immutable directory":    {linuxImmutableFlag, func(f *stepFixture) string { return f.installDir }},
		"an append-only directory":  {linuxAppendFlag, func(f *stepFixture) string { return f.installDir }},
		"an immutable build an earlier update kept": {linuxImmutableFlag, func(f *stepFixture) string {
			return f.keepBesideTheExecutable(updatePreviousName)
		}},
		"an append-only build an earlier update kept": {linuxAppendFlag, func(f *stepFixture) string {
			return f.keepBesideTheExecutable(updatePreviousName)
		}},
		"an immutable link a swap left half made": {linuxImmutableFlag, func(f *stepFixture) string {
			return f.keepBesideTheExecutable(updatePreviousName + ".new")
		}},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			path := c.path(f)
			flagInode(t, path, c.flag)
			before := f.snapshot()

			f.mustRun()

			status := f.status()
			if status.Eligibility != "READ_ONLY" || status.Last != nil || status.Stage != UpdateStageIdle {
				t.Fatalf("the status of a host with a flag on %s: %+v", path, status)
			}
			f.requireUnchanged(before)
			if got := f.counters().HighestCounters[f.public.Fingerprint()]; got != 0 {
				t.Errorf("the floor is %d: a release was attempted on a host that can't take it", got)
			}
			if _, err := os.Stat(UpdateExchangeFor(f.stateDir).Request); err != nil {
				t.Errorf("the request was taken: %v", err)
			}
			// Everything that asks the question gets the same answer, with the words.
			facts := inspectHost(f.host, f.stateDir, f.exe)
			if facts.install != nil {
				facts.install.Close()
			}
			if facts.code != "READ_ONLY" || !strings.Contains(facts.detail, path+" has the ") {
				t.Errorf("the host's eligibility: %s (%s)", facts.code, facts.detail)
			}
			err := InstallUpdateHelper(f.stateDir, f.exe)
			var refusal *UpdateRefusal
			if !errors.As(err, &refusal) || refusal.Code != "READ_ONLY" || !strings.Contains(refusal.Detail, path+" has the ") || !strings.Contains(refusal.Detail, "Clear it first: sudo chattr -") {
				t.Errorf("installing the step: %v", err)
			}
			if err := ApplyStagedUpdate(bg(), f.stateDir, false, nil); err == nil || !strings.Contains(err.Error(), "READ_ONLY") {
				t.Errorf("apply: %v", err)
			}

			// A person clears the flag, and the next run applies what was waiting.
			unflagInode(t, path, c.flag)
			f.clock.advance(30 * time.Second)
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeCommitted, "")
			if got := f.executableDigest(); got != release.buildSHA() {
				t.Errorf("the executable is %s, want the new build", got)
			}
		})
	}
}
