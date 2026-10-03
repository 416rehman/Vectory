//go:build !windows

package agent

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"testing/iotest"

	"golang.org/x/sys/unix"
)

// A small install directory the test owns, with an executable in it, opened the way
// the step opens it.
type swapRig struct {
	t       *testing.T
	root    string
	dir     string
	exe     string
	install *unixInstall
}

func newSwapRig(t *testing.T) *swapRig {
	t.Helper()
	root := ownTree(t)
	dir := filepath.Join(root, "usr", "local", "bin")
	mkdirMode(t, dir, 0o755)
	r := &swapRig{t: t, root: root, dir: dir, exe: filepath.Join(dir, "vectory")}
	if err := os.WriteFile(r.exe, []byte("the old build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(r.exe, 0o755); err != nil {
		t.Fatal(err)
	}
	install, err := openUnixInstall(r.exe)
	if err != nil {
		t.Fatal(err)
	}
	r.install = install
	t.Cleanup(func() { install.Close() })
	return r
}

func (r *swapRig) read(name string) string {
	r.t.Helper()
	data, err := os.ReadFile(filepath.Join(r.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return "<absent>"
	}
	if err != nil {
		r.t.Fatal(err)
	}
	return string(data)
}

func (r *swapRig) names() []string {
	r.t.Helper()
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		r.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func (r *swapRig) stage(name, content string) string {
	r.t.Helper()
	digest, err := r.install.Stage(name, strings.NewReader(content), int64(len(content)))
	if err != nil {
		r.t.Fatal(err)
	}
	return digest
}

func TestAStagedFileIsNewIsMode0755WhateverTheUmaskAndIsHashedAsItIsOnDisk(t *testing.T) {
	r := newSwapRig(t)
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	digest := r.stage(".vectory-update-7", "the new build")
	if digest != digestOf([]byte("the new build")) {
		t.Errorf("the digest of the staged file is %s", digest)
	}
	info, err := os.Stat(filepath.Join(r.dir, ".vectory-update-7"))
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Errorf("the staged file: %v, %v", info, err)
	}
}

func TestStagingNeverWritesThroughAnExistingNameOrALinkPlantedAtIt(t *testing.T) {
	r := newSwapRig(t)
	target := filepath.Join(r.root, "elsewhere")
	if err := os.WriteFile(target, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(r.dir, ".vectory-update-7")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.install.Stage(".vectory-update-7", strings.NewReader("x"), 1); err == nil {
		t.Fatal("a staged file was written over a link")
	}
	if got, _ := os.ReadFile(target); string(got) != "precious" {
		t.Errorf("the link was followed: %q", got)
	}
	if err := os.Remove(filepath.Join(r.dir, ".vectory-update-7")); err != nil {
		t.Fatal(err)
	}
	r.stage(".vectory-update-7", "first")
	if _, err := r.install.Stage(".vectory-update-7", strings.NewReader("second"), 6); err == nil {
		t.Fatal("a staged file replaced one that was there")
	}
	if got := r.read(".vectory-update-7"); got != "first" {
		t.Errorf("the file that was there: %q", got)
	}
}

func TestStagingRefusesTheExecutablesNameAndAnythingThatIsNotAName(t *testing.T) {
	r := newSwapRig(t)
	for _, name := range []string{"vectory", "", ".", "..", "a/b", "../x", "x\x00y", strings.Repeat("a", 256)} {
		if _, err := r.install.Stage(name, strings.NewReader("x"), 1); err == nil {
			t.Errorf("staged %q", name)
		}
		if err := r.install.Swap(name, ".vectory-previous"); err == nil {
			t.Errorf("swapped %q in", name)
		}
		if err := r.install.Swap(".vectory-update-7", name); err == nil {
			t.Errorf("kept the previous build as %q", name)
		}
		if err := r.install.Restore(name); err == nil {
			t.Errorf("restored %q", name)
		}
		if err := r.install.Remove(name); err == nil {
			t.Errorf("removed %q", name)
		}
	}
	if err := r.install.Swap(".same", ".same"); err == nil {
		t.Error("the staged file and the previous build were one name")
	}
	if got := r.read("vectory"); got != "the old build" {
		t.Errorf("the executable: %q", got)
	}
}

func TestStagingFromASourceThatFailsOrIsTheWrongSizeLeavesNothingBesideTheExecutable(t *testing.T) {
	r := newSwapRig(t)
	failing := io.MultiReader(strings.NewReader("part of the new build"), iotest.ErrReader(errors.New("the disk is full")))
	if _, err := r.install.Stage(".vectory-update-7", failing, 100); err == nil {
		t.Fatal("a source that failed was staged")
	}
	for _, c := range []struct {
		content string
		size    int64
	}{{"short", 10}, {"much too long", 5}} {
		if _, err := r.install.Stage(".vectory-update-7", strings.NewReader(c.content), c.size); err == nil {
			t.Errorf("%q was staged as %d bytes", c.content, c.size)
		}
	}
	if names := r.names(); len(names) != 1 || names[0] != "vectory" {
		t.Errorf("the directory holds %v", names)
	}
}

func TestSwapMakesTheStagedFileTheExecutableAndKeepsTheOldBuildAsAnotherNameOfTheSameFile(t *testing.T) {
	r := newSwapRig(t)
	before, err := os.Stat(r.exe)
	if err != nil {
		t.Fatal(err)
	}
	r.stage(".vectory-update-7", "the new build")
	if err := r.install.Swap(".vectory-update-7", ".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if r.read("vectory") != "the new build" || r.read(".vectory-previous") != "the old build" {
		t.Errorf("after the swap: executable %q, previous %q", r.read("vectory"), r.read(".vectory-previous"))
	}
	if names := r.names(); len(names) != 2 {
		t.Errorf("the directory holds %v: the staged file and the link must be gone", names)
	}
	kept, err := os.Stat(filepath.Join(r.dir, ".vectory-previous"))
	if err != nil || !os.SameFile(before, kept) {
		t.Errorf("the previous build isn't the file the executable was (a copy needs room): %v", err)
	}
	// A second update replaces the build kept before.
	r.stage(".vectory-update-8", "the third build")
	if err := r.install.Swap(".vectory-update-8", ".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if r.read("vectory") != "the third build" || r.read(".vectory-previous") != "the new build" || len(r.names()) != 2 {
		t.Errorf("after the second swap: %q %q %v", r.read("vectory"), r.read(".vectory-previous"), r.names())
	}
}

// A power cut or a kill at any point of the swap leaves one complete executable:
// the old build or the new, never a missing or a partial file, and the old build is
// kept under its second name from the moment the new one can be installed.
func TestTheDirectoryHoldsOneCompleteExecutableAtEveryPointOfTheSwapAndTheRestore(t *testing.T) {
	r := newSwapRig(t)
	r.stage(".vectory-update-7", "the new build")
	var points []string
	updateFault = func(point string) {
		if !strings.HasPrefix(point, "swap:") {
			return
		}
		points = append(points, point)
		executable := r.read("vectory")
		if executable != "the old build" && executable != "the new build" {
			t.Errorf("at %s the executable is %q", point, executable)
		}
		switch point {
		case "swap:linked", "swap:previous_kept":
			if executable != "the old build" {
				t.Errorf("at %s the new build is installed already", point)
			}
		case "swap:renamed", "swap:synced":
			if executable != "the new build" {
				t.Errorf("at %s the executable is %q", point, executable)
			}
		}
		if point != "swap:linked" && r.read(".vectory-previous") != "the old build" {
			t.Errorf("at %s the previous build is %q", point, r.read(".vectory-previous"))
		}
	}
	defer func() { updateFault = nil }()
	if err := r.install.Swap(".vectory-update-7", ".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if want := "swap:linked swap:previous_kept swap:renamed swap:synced"; strings.Join(points, " ") != want {
		t.Errorf("the points were %v, want %s", points, want)
	}

	updateFault = func(point string) {
		if point == "restore:renamed" {
			if got := r.read("vectory"); got != "the old build" {
				t.Errorf("after the restore's rename the executable is %q", got)
			}
		}
	}
	if err := r.install.Restore(".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if r.read("vectory") != "the old build" || r.read(".vectory-previous") != "<absent>" {
		t.Errorf("after the restore: %q, previous %q", r.read("vectory"), r.read(".vectory-previous"))
	}
}

func TestSwapRestoreAndRemoveActOnTheDirectoryTheStepHoldsWhateverHappensToItsPath(t *testing.T) {
	r := newSwapRig(t)
	r.stage(".vectory-update-7", "the new build")

	// Someone who could rename directories (the check says nobody can) moves the
	// install directory and puts a link, then a directory of their own, in its place.
	moved := r.dir + ".moved"
	if err := os.Rename(r.dir, moved); err != nil {
		t.Fatal(err)
	}
	attacker := filepath.Join(r.root, "attacker")
	mkdirMode(t, attacker, 0o755)
	if err := os.WriteFile(filepath.Join(attacker, "vectory"), []byte("not the agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(attacker, r.dir); err != nil {
		t.Fatal(err)
	}

	if err := r.install.Swap(".vectory-update-7", ".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(moved, "vectory")); string(got) != "the new build" {
		t.Errorf("the swap didn't happen in the directory the step held: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(moved, ".vectory-previous")); string(got) != "the old build" {
		t.Errorf("the previous build: %q", got)
	}
	entries, _ := os.ReadDir(attacker)
	if len(entries) != 1 {
		t.Errorf("the swap touched the directory at the path: %v", entries)
	}
	if got, _ := os.ReadFile(filepath.Join(attacker, "vectory")); string(got) != "not the agent" {
		t.Errorf("the other directory's file: %q", got)
	}
	if err := r.install.Restore(".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(moved, "vectory")); string(got) != "the old build" {
		t.Errorf("the restore: %q", got)
	}
	digest, present, err := r.install.Digest("vectory")
	if err != nil || !present || digest != digestOf([]byte("the old build")) {
		t.Errorf("the digest through the handle: %s %v %v", digest, present, err)
	}
	if got := r.install.Path(); got != r.exe {
		t.Errorf("the path for messages: %s", got)
	}
}

func TestADigestThroughTheHandleSaysWhatIsThereNowAndRefusesWhatIsNotRoots(t *testing.T) {
	r := newSwapRig(t)
	digest, present, err := r.install.Digest("vectory")
	if err != nil || !present || digest != digestOf([]byte("the old build")) {
		t.Fatalf("the executable: %s %v %v", digest, present, err)
	}
	if _, present, err := r.install.Digest("absent"); err != nil || present {
		t.Errorf("a name that isn't there: %v %v", present, err)
	}
	// A link in place of the file is never followed.
	if err := os.Symlink(r.exe, filepath.Join(r.dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, present, err := r.install.Digest("link"); err == nil && present {
		t.Error("a link was hashed")
	}
	// A file that anyone can write is not what the step installs from.
	writable := filepath.Join(r.dir, "writable")
	if err := os.WriteFile(writable, []byte("x"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(writable, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, present, err := r.install.Digest("writable"); err == nil && present {
		t.Error("a file anyone could write was hashed")
	}
}

func TestRemoveTakesAwayOneNameAndNeverTheExecutable(t *testing.T) {
	r := newSwapRig(t)
	r.stage(".vectory-update-7", "the new build")
	if err := r.install.Remove(".vectory-update-7"); err != nil {
		t.Fatal(err)
	}
	if err := r.install.Remove(".vectory-update-7"); err != nil {
		t.Errorf("removing a name that is gone is not an error: %v", err)
	}
	if err := r.install.Remove("vectory"); err == nil {
		t.Error("the executable was removed")
	}
	if names := r.names(); len(names) != 1 {
		t.Errorf("the directory holds %v", names)
	}
}

func TestAWriteThatTheFileSystemRefusesAsReadOnlyIsTold(t *testing.T) {
	for name, err := range map[string]error{"EROFS": unix.EROFS, "wrapped": &os.PathError{Op: "create", Path: "/x", Err: unix.EROFS}} {
		if got := readOnly(err); !errors.Is(got, errUpdateReadOnly) {
			t.Errorf("%s: %v", name, got)
		}
	}
	for name, err := range map[string]error{"ENOSPC": unix.ENOSPC, "EACCES": unix.EACCES, "nil": nil} {
		if got := readOnly(err); errors.Is(got, errUpdateReadOnly) {
			t.Errorf("%s was taken for a read-only file system", name)
		}
	}
	if !statfsReadOnly(unix.Statfs_t{Flags: 1}) || statfsReadOnly(unix.Statfs_t{Flags: 4}) {
		t.Error("the read-only bit of a file system's flags")
	}
}

func TestACopyIntoADirectoryKeepsTheBytesAndTheOwnerOnlyModeItWasAskedFor(t *testing.T) {
	root := ownTree(t)
	mkdirMode(t, filepath.Join(root, "private"), 0o700)
	dir, err := ensureRootOwnedDir(filepath.Join(root, "private"), rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	content := bytes.Repeat([]byte("0123456789abcdef"), 4096)
	digest, err := unixUpdateHost{}.CopyInto(dir, "copy", rootPrivate, bytes.NewReader(content), int64(len(content)))
	if err != nil || digest != digestOf(content) {
		t.Fatalf("copy: %s, %v", digest, err)
	}
	info, err := os.Stat(filepath.Join(dir.Path(), "copy"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("the copy's mode: %v, %v", info, err)
	}
	// A size of -1 reads until the end, up to what an agent build can be.
	digest, err = unixUpdateHost{}.CopyInto(dir, "copy2", rootExecutable, bytes.NewReader(content), -1)
	if err != nil || digest != digestOf(content) {
		t.Fatalf("copy of unknown size: %s, %v", digest, err)
	}
	info, err = os.Stat(filepath.Join(dir.Path(), "copy2"))
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Errorf("the executable copy's mode: %v, %v", info, err)
	}
}
