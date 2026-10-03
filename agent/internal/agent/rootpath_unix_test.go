//go:build !windows

package agent

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// A test can't build a tree owned by root unless it runs as root, so these
// tests build one under a temporary directory and trust their own account
// there (rootOwnedTrust). Everything else about the check is the code that
// ships. TestRootOwnedChecksOnRealRootOwnership, in rootpath_root_test.go, runs
// the check as it ships against trees that root really owns, when the test
// runs as root.

// ownTree is a temporary directory that the check starts below, and the test's
// own account is trusted under it.
func ownTree(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	trustTree(t, root)
	return root
}

// trustTree makes the check start below root and trust this account there, until
// the test ends.
func trustTree(t *testing.T, root string) {
	t.Helper()
	old := rootOwnedTrust
	rootOwnedTrust = ownerTrust{uid: uint32(os.Geteuid()), hasUID: true, anchor: root}
	t.Cleanup(func() { rootOwnedTrust = old })
}

func mkdirMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func writeMode(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

// refusedAs returns the refusal in err, and fails the test when err is not one.
func refusedAs(t *testing.T, err error) *UpdateRefusal {
	t.Helper()
	var refusal *UpdateRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("got %v, want an UpdateRefusal", err)
	}
	if refusal.Code != "UNTRUSTED_LOCATION" {
		t.Fatalf("the code is %q, want UNTRUSTED_LOCATION", refusal.Code)
	}
	return refusal
}

func mustOpen(t *testing.T, path string, kind rootOwnedKind) *rootOwned {
	t.Helper()
	r, err := openRootOwned(path, kind)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

// A tree of three directories and a file, as the update policy sits under its
// directories.
func policyTree(t *testing.T) (root, file string) {
	t.Helper()
	root = ownTree(t)
	for _, dir := range []string{"a", "a/b", "a/b/c"} {
		mkdirMode(t, filepath.Join(root, filepath.FromSlash(dir)), 0o755)
	}
	file = filepath.Join(root, "a", "b", "c", "file")
	writeMode(t, file, "good", 0o644)
	return root, file
}

func TestOpenRootOwnedHoldsTheTreeItChecked(t *testing.T) {
	root, file := policyTree(t)
	r := mustOpen(t, file, rootOwnedFile)
	data, err := r.ReadFile(16)
	if err != nil || string(data) != "good" {
		t.Fatalf("read %q, %v", data, err)
	}
	if r.Path() != file {
		t.Errorf("Path() is %q", r.Path())
	}
	writeMode(t, filepath.Join(root, "a", "b", "c", "other"), "beside it", 0o644)
	if data, err := r.ReadFileAt("other", 16); err != nil || string(data) != "beside it" {
		t.Fatalf("a file beside it: %q, %v", data, err)
	}
	if st, err := r.Fstat(); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG {
		t.Fatalf("fstat of the file: %+v, %v", st, err)
	}
	if st, err := r.FstatDir(); err != nil || st.Mode&unix.S_IFMT != unix.S_IFDIR {
		t.Fatalf("fstat of the directory: %+v, %v", st, err)
	}
	if _, err := r.ReadFile(2); err == nil || !errors.Is(err, errRootOwnedTooLarge) {
		t.Fatalf("a read past its bound gave %v", err)
	}
	dir := mustOpen(t, filepath.Dir(file), rootOwnedDirectory)
	if dir.File() != nil {
		t.Error("a directory path holds a file")
	}
	if _, err := dir.ReadFile(16); err == nil {
		t.Error("ReadFile on a directory succeeded")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("a second Close: %v", err)
	}
}

func TestOpenRootOwnedRefusesADirectoryTheGroupOrEveryoneCanWriteAtEachDepth(t *testing.T) {
	root, file := policyTree(t)
	for _, depth := range []string{"a", "a/b", "a/b/c"} {
		dir := filepath.Join(root, filepath.FromSlash(depth))
		for _, tc := range []struct {
			mode os.FileMode
			text string
		}{
			{0o775, "is writable by its group (mode 0775)"},
			{0o757, "is writable by everyone (mode 0757)"},
			{0o777, "is writable by its group and by everyone (mode 0777)"},
			{os.ModeSticky | 0o777, "is writable by its group and by everyone (mode 1777)"},
		} {
			if err := os.Chmod(dir, tc.mode); err != nil {
				t.Fatal(err)
			}
			for _, kind := range []struct {
				path string
				kind rootOwnedKind
			}{{file, rootOwnedFile}, {dir, rootOwnedDirectory}} {
				_, err := openRootOwned(kind.path, kind.kind)
				refusal := refusedAs(t, err)
				if want := dir + " " + tc.text; refusal.Detail != want {
					t.Errorf("%s at %s: detail %q, want %q", tc.text, depth, refusal.Detail, want)
				}
			}
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	mustOpen(t, file, rootOwnedFile)
}

func TestOpenRootOwnedAcceptsDirectoriesOnlyRootCanWrite(t *testing.T) {
	root, file := policyTree(t)
	for _, mode := range []os.FileMode{0o755, 0o750, 0o700, 0o555, 0o711} {
		if err := os.Chmod(filepath.Join(root, "a", "b"), mode); err != nil {
			t.Fatal(err)
		}
		r, err := openRootOwned(file, rootOwnedFile)
		if err != nil {
			t.Errorf("a directory with mode %04o: %v", mode, err)
			continue
		}
		r.Close()
	}
}

func TestOpenRootOwnedRefusesAFileTheGroupOrEveryoneCanWrite(t *testing.T) {
	_, file := policyTree(t)
	for _, mode := range []os.FileMode{0o664, 0o646, 0o666, 0o620, 0o602} {
		if err := os.Chmod(file, mode); err != nil {
			t.Fatal(err)
		}
		_, err := openRootOwned(file, rootOwnedFile)
		refusal := refusedAs(t, err)
		if !strings.HasPrefix(refusal.Detail, file+" is writable by ") {
			t.Errorf("a file with mode %04o: %q", mode, refusal.Detail)
		}
	}
	for _, mode := range []os.FileMode{0o644, 0o600, 0o444, 0o755} {
		if err := os.Chmod(file, mode); err != nil {
			t.Fatal(err)
		}
		mustOpen(t, file, rootOwnedFile)
	}
}

// What the path names must be the kind of thing the caller asked for, and a link
// is never followed, at any depth.
func TestOpenRootOwnedRefusesALinkAtEachDepth(t *testing.T) {
	root, file := policyTree(t)
	for _, depth := range []string{"a", "a/b", "a/b/c", "a/b/c/file"} {
		link := filepath.Join(root, filepath.FromSlash(depth))
		real := link + "-real"
		if err := os.Rename(link, real); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Base(real), link); err != nil {
			t.Fatal(err)
		}
		_, err := openRootOwned(file, rootOwnedFile)
		if refusal := refusedAs(t, err); refusal.Detail != link+" is a symbolic link" {
			t.Errorf("a link at %s: %q", depth, refusal.Detail)
		}
		if depth != "a/b/c/file" {
			_, err = openRootOwned(filepath.Join(root, "a", "b", "c"), rootOwnedDirectory)
			if refusal := refusedAs(t, err); !strings.HasSuffix(refusal.Detail, "is a symbolic link") {
				t.Errorf("a link at %s, as a directory path: %q", depth, refusal.Detail)
			}
		}
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(real, link); err != nil {
			t.Fatal(err)
		}
	}
	mustOpen(t, file, rootOwnedFile)

	// A link that points somewhere root owns is still a link.
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", file); err != nil {
		t.Fatal(err)
	}
	_, err := openRootOwned(file, rootOwnedFile)
	if refusal := refusedAs(t, err); refusal.Detail != file+" is a symbolic link" {
		t.Errorf("a link to a file of root's: %q", refusal.Detail)
	}
}

func TestOpenRootOwnedRefusesTheWrongKindOfFile(t *testing.T) {
	_, file := policyTree(t)
	dir := filepath.Dir(file)

	_, err := openRootOwned(dir, rootOwnedFile)
	if refusal := refusedAs(t, err); refusal.Detail != dir+" isn't a regular file (it is a directory)" {
		t.Errorf("a directory where a file is needed: %q", refusal.Detail)
	}
	_, err = openRootOwned(file, rootOwnedDirectory)
	if refusal := refusedAs(t, err); refusal.Detail != file+" isn't a directory (it is a regular file)" {
		t.Errorf("a file where a directory is needed: %q", refusal.Detail)
	}
	// A regular file in the middle of the path.
	_, err = openRootOwned(filepath.Join(file, "deeper"), rootOwnedFile)
	if refusal := refusedAs(t, err); refusal.Detail != file+" isn't a directory (it is a regular file)" {
		t.Errorf("a file in the middle of a path: %q", refusal.Detail)
	}
}

// A named pipe where the policy should be must not make the reader wait for a
// writer that will never come.
func TestOpenRootOwnedRefusesANamedPipeWithoutWaiting(t *testing.T) {
	root := ownTree(t)
	pipe := filepath.Join(root, "pipe")
	if err := unix.Mkfifo(pipe, 0o644); err != nil {
		t.Fatal(err)
	}
	for name, open := range map[string]func() error{
		"openRootOwned": func() error { _, err := openRootOwned(pipe, rootOwnedFile); return err },
		"openPlainFile": func() error { _, err := openPlainFile(pipe); return err },
		"OpenAt": func() error {
			r := mustOpen(t, root, rootOwnedDirectory)
			_, err := r.OpenAt("pipe")
			return err
		},
	} {
		done := make(chan error, 1)
		go func() { done <- open() }()
		select {
		case err := <-done:
			if refusal := refusedAs(t, err); !strings.Contains(refusal.Detail, "isn't a regular file (it is a named pipe)") {
				t.Errorf("%s: %q", name, refusal.Detail)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s waited for a writer to a named pipe", name)
		}
	}
}

func TestOpenRootOwnedSaysWhenSomethingIsMissing(t *testing.T) {
	root, file := policyTree(t)
	for _, path := range []string{
		filepath.Join(root, "missing"),
		filepath.Join(root, "a", "missing", "file"),
		filepath.Join(file[:len(file)-len("file")], "missing"),
	} {
		_, err := openRootOwned(path, rootOwnedFile)
		var refusal *UpdateRefusal
		if err == nil || errors.As(err, &refusal) || !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s: %v, want the not-exist error", path, err)
		}
	}
}

func TestOpenRootOwnedRefusesAPathThatIsNotAbsoluteAndClean(t *testing.T) {
	root, file := policyTree(t)
	for _, path := range []string{
		"", "relative/path", "a/b",
		file + "/", root + "/a//b/c/file",
		root + "/a/../a/b/c/file",
		root + "/./a/b/c/file",
		file + "\x00",
	} {
		if _, err := openRootOwned(path, rootOwnedFile); err == nil {
			t.Errorf("%q was opened", path)
		}
	}
	if _, err := openRootOwned("/", rootOwnedFile); err == nil {
		t.Error("the root of the file system was opened as a file")
	}
}

// The point of the handles: what the check saw is what the swap and the readers
// use, whatever happens to the names afterwards.
func TestOpenRootOwnedHandlesStillReferToWhatWasChecked(t *testing.T) {
	root, file := policyTree(t)
	dirPath := filepath.Dir(file)
	r := mustOpen(t, dirPath, rootOwnedDirectory)
	f := mustOpen(t, file, rootOwnedFile)

	// The checked directory moves away, and another takes its name.
	if err := os.Rename(dirPath, dirPath+"-moved"); err != nil {
		t.Fatal(err)
	}
	mkdirMode(t, dirPath, 0o755)
	writeMode(t, file, "evil", 0o644)
	if data, err := os.ReadFile(file); err != nil || string(data) != "evil" {
		t.Fatalf("the name now leads to %q, %v", data, err)
	}
	if data, err := r.ReadFileAt("file", 16); err != nil || string(data) != "good" {
		t.Errorf("through the held directory: %q, %v", data, err)
	}
	if data, err := f.ReadFile(16); err != nil || string(data) != "good" {
		t.Errorf("through the held file: %q, %v", data, err)
	}

	// A directory above it moves away, and another takes its name.
	if err := os.Rename(filepath.Join(root, "a"), filepath.Join(root, "a-moved")); err != nil {
		t.Fatal(err)
	}
	mkdirMode(t, filepath.Join(root, "a", "b", "c"), 0o755)
	writeMode(t, file, "evil again", 0o644)
	if data, err := r.ReadFileAt("file", 16); err != nil || string(data) != "good" {
		t.Errorf("after a directory above it moved: %q, %v", data, err)
	}
	// Writes go to the checked directory too.
	if err := r.WriteFile("written", []byte("here"), rootReadable); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "a-moved", "b", "c-moved", "written")); err != nil || string(data) != "here" {
		t.Errorf("a file written through the held directory went to %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b", "c", "written")); err == nil {
		t.Error("a file written through the held directory appeared at the name that was replaced")
	}

	// The checked file is replaced by another file at the same name.
	root2, file2 := policyTree(t)
	_ = root2
	held := mustOpen(t, file2, rootOwnedFile)
	writeMode(t, file2+".new", "replacement", 0o644)
	if err := os.Rename(file2+".new", file2); err != nil {
		t.Fatal(err)
	}
	if data, err := held.ReadFile(16); err != nil || string(data) != "good" {
		t.Errorf("a replaced file read through its handle: %q, %v", data, err)
	}
}

func TestRootOwnedEntriesAreChecked(t *testing.T) {
	root, _ := policyTree(t)
	dir := filepath.Join(root, "a")
	r := mustOpen(t, dir, rootOwnedDirectory)

	writeMode(t, filepath.Join(dir, "open"), "x", 0o644)
	if f, err := r.OpenAt("open"); err != nil {
		t.Errorf("OpenAt: %v", err)
	} else {
		f.Close()
	}
	writeMode(t, filepath.Join(dir, "loose"), "x", 0o666)
	_, err := r.OpenAt("loose")
	if refusal := refusedAs(t, err); refusal.Detail != filepath.Join(dir, "loose")+" is writable by its group and by everyone (mode 0666)" {
		t.Errorf("a loose file: %q", refusal.Detail)
	}
	if err := os.Symlink("open", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	_, err = r.OpenAt("link")
	if refusal := refusedAs(t, err); refusal.Detail != filepath.Join(dir, "link")+" is a symbolic link" {
		t.Errorf("a link: %q", refusal.Detail)
	}
	if _, err := r.OpenAt("b"); err == nil {
		t.Error("a directory opened as a file")
	}
	if _, err := r.OpenAt("missing"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a missing file: %v", err)
	}
	for _, name := range []string{"", ".", "..", "../open", "b/c", "a\x00b", strings.Repeat("n", 256)} {
		if _, err := r.OpenAt(name); err == nil {
			t.Errorf("OpenAt(%q) succeeded", name)
		}
		if _, err := r.CreateAt(name, 0o644); err == nil {
			t.Errorf("CreateAt(%q) succeeded", name)
		}
		if err := r.RenameAt(name, "x"); err == nil {
			t.Errorf("RenameAt(%q) succeeded", name)
		}
		if err := r.LinkAt("open", name); err == nil {
			t.Errorf("LinkAt(%q) succeeded", name)
		}
		if err := r.UnlinkAt(name); err == nil {
			t.Errorf("UnlinkAt(%q) succeeded", name)
		}
	}
}

func TestRootOwnedCreateLinkRenameAndUnlinkWorkOnTheHeldDirectory(t *testing.T) {
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	root, _ := policyTree(t)
	dir := filepath.Join(root, "a")
	r := mustOpen(t, dir, rootOwnedDirectory)

	f, err := r.CreateAt(".vectory-update-7", 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("new build"); err != nil {
		t.Fatal(err)
	}
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if info, err := os.Stat(filepath.Join(dir, ".vectory-update-7")); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("the new file: %v, %v (a umask must not narrow the mode)", info, err)
	}
	if _, err := r.CreateAt(".vectory-update-7", 0o755); !errors.Is(err, fs.ErrExist) {
		t.Errorf("a second create of the same name: %v", err)
	}
	// A link planted at the name is not followed.
	target := filepath.Join(root, "target")
	if err := os.Symlink(target, filepath.Join(dir, "planted")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.CreateAt("planted", 0o644); !errors.Is(err, fs.ErrExist) {
		t.Errorf("a create over a planted link: %v", err)
	}
	if _, err := os.Lstat(target); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the planted link was followed and made %s: %v", target, err)
	}

	// The executable's previous build stays as another name of the same file.
	writeMode(t, filepath.Join(dir, "vectory"), "old build", 0o755)
	if err := r.LinkAt("vectory", ".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if err := r.RenameAt(".vectory-update-7", "vectory"); err != nil {
		t.Fatal(err)
	}
	if err := r.Sync(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"vectory": "new build", ".vectory-previous": "old build"} {
		if data, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(data) != want {
			t.Errorf("%s holds %q, %v; want %q", name, data, err, want)
		}
	}
	if err := r.LinkAt("vectory", ".vectory-previous"); !errors.Is(err, fs.ErrExist) {
		t.Errorf("a link over an existing name: %v", err)
	}
	if err := r.UnlinkAt(".vectory-previous"); err != nil {
		t.Fatal(err)
	}
	if err := r.UnlinkAt(".vectory-previous"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a second unlink: %v", err)
	}
	// An executable with two names, as the swap leaves it, is still accepted.
	if err := r.LinkAt("vectory", "second-name"); err != nil {
		t.Fatal(err)
	}
	if f, err := r.OpenAt("vectory"); err != nil {
		t.Errorf("a file with two names: %v", err)
	} else {
		f.Close()
	}
}

func TestRootOwnedWriteFileReplacesAtomically(t *testing.T) {
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	root, _ := policyTree(t)
	dir := filepath.Join(root, "a")
	r := mustOpen(t, dir, rootOwnedDirectory)

	for perm, want := range map[rootFilePerm]os.FileMode{rootReadable: 0o644, rootPrivate: 0o600, rootExecutable: 0o755} {
		name := map[rootFilePerm]string{rootReadable: "readable", rootPrivate: "private", rootExecutable: "executable"}[perm]
		if err := r.WriteFile(name, []byte("first"), perm); err != nil {
			t.Fatal(err)
		}
		if err := r.WriteFile(name, []byte("second"), perm); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(dir, name))
		data, _ := os.ReadFile(filepath.Join(dir, name))
		if err != nil || info.Mode().Perm() != want || string(data) != "second" {
			t.Errorf("%s: mode %v, %q, %v; want %v and the second write", name, info.Mode().Perm(), data, err, want)
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Errorf("a temporary file was left: %s", entry.Name())
		}
	}

	// A write that can't take the name leaves what was there, and no temporary file.
	if err := os.Mkdir(filepath.Join(dir, "occupied"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := r.WriteFile("occupied", []byte("x"), rootReadable); err == nil {
		t.Fatal("a file replaced a directory")
	}
	entries, _ = os.ReadDir(dir)
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Errorf("a failed write left %s", entry.Name())
		}
	}
	// A planted link at the name is replaced, not followed.
	target := filepath.Join(root, "link-target")
	writeMode(t, target, "keep", 0o644)
	if err := os.Symlink(target, filepath.Join(dir, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := r.WriteFile("linked", []byte("through"), rootReadable); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(target); string(data) != "keep" {
		t.Errorf("the write followed a link into %q", data)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "linked")); string(data) != "through" {
		t.Errorf("the name holds %q", data)
	}
}

func TestEnsureRootOwnedDirMakesTheDirectoriesItNeeds(t *testing.T) {
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	root := ownTree(t)
	mkdirMode(t, filepath.Join(root, "existing"), 0o750)

	made := filepath.Join(root, "existing", "x", "y", "z")
	r, err := ensureRootOwnedDir(made)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for _, dir := range []string{"existing/x", "existing/x/y", "existing/x/y/z"} {
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(dir))); err != nil || info.Mode().Perm() != 0o755 {
			t.Errorf("%s: %v, %v; a made directory is 0755 whatever the umask says", dir, info, err)
		}
	}
	if info, _ := os.Stat(filepath.Join(root, "existing")); info.Mode().Perm() != 0o750 {
		t.Errorf("a directory that existed was changed to %v", info.Mode().Perm())
	}
	if err := r.WriteFile("f", []byte("x"), rootReadable); err != nil {
		t.Fatal(err)
	}

	// Nothing is made below a directory that isn't root's alone.
	mkdirMode(t, filepath.Join(root, "loose"), 0o775)
	_, err = ensureRootOwnedDir(filepath.Join(root, "loose", "new", "dir"))
	if refusal := refusedAs(t, err); refusal.Detail != filepath.Join(root, "loose")+" is writable by its group (mode 0775)" {
		t.Errorf("below a loose directory: %q", refusal.Detail)
	}
	if _, err := os.Stat(filepath.Join(root, "loose", "new")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a directory was made below a loose one: %v", err)
	}
	// An existing directory is found again, not made again.
	again, err := ensureRootOwnedDir(made)
	if err != nil {
		t.Fatal(err)
	}
	again.Close()
	// A file in the way is refused.
	writeMode(t, filepath.Join(root, "afile"), "x", 0o644)
	_, err = ensureRootOwnedDir(filepath.Join(root, "afile", "dir"))
	if refusal := refusedAs(t, err); !strings.Contains(refusal.Detail, "isn't a directory") {
		t.Errorf("below a file: %q", refusal.Detail)
	}
}

func TestOpenPlainFileFollowsNoLinkAndJudgesNothingElse(t *testing.T) {
	root := ownTree(t)
	mkdirMode(t, filepath.Join(root, "state", "updates"), 0o777)
	file := filepath.Join(root, "state", "updates", "request.json")
	writeMode(t, file, "{}", 0o666)
	f, err := openPlainFile(file)
	if err != nil {
		t.Fatalf("a file anyone can write: %v", err)
	}
	f.Close()

	// A link in any component, whoever made it.
	if err := os.Rename(filepath.Join(root, "state", "updates"), filepath.Join(root, "state", "real")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real", filepath.Join(root, "state", "updates")); err != nil {
		t.Fatal(err)
	}
	if _, err := openPlainFile(file); err == nil {
		t.Fatal("a file reached through a linked directory was opened")
	}
	if _, err := openPlainFile(filepath.Join(root, "missing")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a missing file: %v", err)
	}
	if _, err := openPlainFile(filepath.Join(root, "state")); err == nil {
		t.Error("a directory was opened as a file")
	}
}

func TestTheTrustAnchorJudgesOnlyBelowIt(t *testing.T) {
	trust := ownerTrust{anchor: "/tmp/x/y"}
	for path, want := range map[string]bool{
		"/": false, "/tmp": false, "/tmp/x": false, "/tmp/x/y": false,
		"/tmp/x/y/z": true, "/tmp/xy": true, "/tmp/x/yy": true, "/tmp/other": true, "/var": true,
	} {
		if got := trust.judged(path); got != want {
			t.Errorf("judged(%q) = %v, want %v", path, got, want)
		}
	}
	if !(ownerTrust{}).judged("/") || !(ownerTrust{}).judged("/etc") {
		t.Error("with no anchor every directory is judged, the root of the file system included")
	}
	if (ownerTrust{unjudged: true}).judged("/etc") {
		t.Error("an unjudged walk judged a directory")
	}
}

func TestTheDecisionAboutOwnerAndMode(t *testing.T) {
	root := ownerTrust{}
	friend := ownerTrust{uid: 4242, hasUID: true}
	for _, tc := range []struct {
		name  string
		trust ownerTrust
		facts pathFacts
		want  string
	}{
		{"root, 0755", root, pathFacts{unix.S_IFDIR | 0o755, 0}, ""},
		{"root, 0700", root, pathFacts{unix.S_IFDIR | 0o700, 0}, ""},
		{"root, 0555", root, pathFacts{unix.S_IFDIR | 0o555, 0}, ""},
		{"root, 0644 file", root, pathFacts{unix.S_IFREG | 0o644, 0}, ""},
		{"root, sticky and writable", root, pathFacts{unix.S_IFDIR | 0o1777, 0}, "is writable by its group and by everyone (mode 1777)"},
		{"root, group writable", root, pathFacts{unix.S_IFDIR | 0o775, 0}, "is writable by its group (mode 0775)"},
		{"root, others writable", root, pathFacts{unix.S_IFDIR | 0o757, 0}, "is writable by everyone (mode 0757)"},
		{"root, setgid and group writable", root, pathFacts{unix.S_IFDIR | 0o2775, 0}, "is writable by its group (mode 2775)"},
		{"another account, 0755", root, pathFacts{unix.S_IFDIR | 0o755, 1000}, "belongs to uid 1000, not to root"},
		{"another account, loose", root, pathFacts{unix.S_IFDIR | 0o777, 1000}, "belongs to uid 1000, not to root"},
		{"the account that was trusted", friend, pathFacts{unix.S_IFDIR | 0o755, 4242}, ""},
		{"root, with an account trusted", friend, pathFacts{unix.S_IFDIR | 0o755, 0}, ""},
		{"a third account", friend, pathFacts{unix.S_IFDIR | 0o755, 7}, "belongs to uid 7, not to root"},
		{"the trusted account's loose directory", friend, pathFacts{unix.S_IFDIR | 0o775, 4242}, "is writable by its group (mode 0775)"},
	} {
		if got := tc.trust.ownerProblem(tc.facts); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
	for _, tc := range []struct {
		mode uint32
		want rootOwnedKind
		text string
	}{
		{unix.S_IFDIR, rootOwnedDirectory, ""},
		{unix.S_IFREG, rootOwnedFile, ""},
		{unix.S_IFLNK, rootOwnedDirectory, "is a symbolic link"},
		{unix.S_IFLNK, rootOwnedFile, "is a symbolic link"},
		{unix.S_IFREG, rootOwnedDirectory, "isn't a directory (it is a regular file)"},
		{unix.S_IFDIR, rootOwnedFile, "isn't a regular file (it is a directory)"},
		{unix.S_IFIFO, rootOwnedFile, "isn't a regular file (it is a named pipe)"},
		{unix.S_IFSOCK, rootOwnedFile, "isn't a regular file (it is a socket)"},
		{unix.S_IFCHR, rootOwnedFile, "isn't a regular file (it is a character device)"},
		{unix.S_IFBLK, rootOwnedFile, "isn't a regular file (it is a block device)"},
	} {
		if got := typeProblem(tc.mode, tc.want); got != tc.text {
			t.Errorf("mode %#o as %v: %q, want %q", tc.mode, tc.want, got, tc.text)
		}
	}
}
