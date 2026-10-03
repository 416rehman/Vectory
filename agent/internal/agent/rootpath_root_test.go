//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// These tests run the path check as it ships, against trees that root really
// owns, so they need root: CI runs them with `sudo -E go test -run
// RootOwnedChecksOnReal ./internal/agent` on Linux and macOS. Run as another
// account they skip. The unprivileged tests in rootpath_unix_test.go cover the
// same decisions on trees the test owns.

// systemBase makes a directory below a system directory that is root's alone,
// for a tree that root owns and that the check, as it ships, accepts.
func systemBase(t *testing.T) string {
	t.Helper()
	candidates := []string{"/var/lib", "/usr/local/share", "/opt", "/Library/Application Support", "/Library"}
	for _, candidate := range candidates {
		r, err := openRootOwned(candidate, rootOwnedDirectory)
		if err != nil {
			continue
		}
		r.Close()
		base, err := os.MkdirTemp(candidate, "vectory-rootpath-")
		if err != nil {
			continue
		}
		t.Cleanup(func() { os.RemoveAll(base) })
		if err := os.Chmod(base, 0o755); err != nil {
			t.Fatal(err)
		}
		return base
	}
	t.Fatalf("none of %v is owned by root and closed to everyone else on this host, so the check can't be run against a real tree", candidates)
	return ""
}

func TestRootOwnedChecksOnRealRootOwnership(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("this test builds trees that root owns, so it runs as root")
	}
	if rootOwnedTrust != (ownerTrust{}) {
		t.Fatal("a test left the path check's seam set: this test runs the check as it ships")
	}
	base := systemBase(t)
	for _, dir := range []string{"a", "a/b", "a/b/c"} {
		mkdirMode(t, filepath.Join(base, filepath.FromSlash(dir)), 0o755)
	}
	file := filepath.Join(base, "a", "b", "c", "file")
	writeMode(t, file, "good", 0o644)

	r := mustOpen(t, file, rootOwnedFile)
	st, err := r.Fstat()
	if err != nil || st.Uid != 0 {
		t.Fatalf("the file: %+v, %v", st, err)
	}
	mustOpen(t, filepath.Dir(file), rootOwnedDirectory)
	if !canWriteRootOwned() {
		t.Error("root can't write what the check trusts")
	}

	t.Run("an owner other than root at each depth, and on the file", func(t *testing.T) {
		for _, depth := range []string{"a", "a/b", "a/b/c", "a/b/c/file"} {
			path := filepath.Join(base, filepath.FromSlash(depth))
			if err := os.Chown(path, 65534, 65534); err != nil {
				t.Fatal(err)
			}
			_, err := openRootOwned(file, rootOwnedFile)
			if refusal := refusedAs(t, err); refusal.Detail != path+" belongs to uid 65534, not to root" {
				t.Errorf("%s: %q", depth, refusal.Detail)
			}
			if err := os.Chown(path, 0, 0); err != nil {
				t.Fatal(err)
			}
		}
	})

	t.Run("a group or everyone can write, at each depth, and on the file", func(t *testing.T) {
		for _, depth := range []string{"a", "a/b", "a/b/c", "a/b/c/file"} {
			path := filepath.Join(base, filepath.FromSlash(depth))
			original := os.FileMode(0o755)
			if depth == "a/b/c/file" {
				original = 0o644
			}
			for _, mode := range []os.FileMode{0o775, 0o757, 0o777, os.ModeSticky | 0o777} {
				if depth == "a/b/c/file" && mode&os.ModeSticky != 0 {
					continue
				}
				if err := os.Chmod(path, mode); err != nil {
					t.Fatal(err)
				}
				_, err := openRootOwned(file, rootOwnedFile)
				if refusal := refusedAs(t, err); !strings.HasPrefix(refusal.Detail, path+" is writable by ") {
					t.Errorf("%s with %v: %q", depth, mode, refusal.Detail)
				}
			}
			if err := os.Chmod(path, original); err != nil {
				t.Fatal(err)
			}
		}
	})

	t.Run("a link at each depth", func(t *testing.T) {
		for _, depth := range []string{"a", "a/b", "a/b/c", "a/b/c/file"} {
			link := filepath.Join(base, filepath.FromSlash(depth))
			if err := os.Rename(link, link+"-real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Base(link)+"-real", link); err != nil {
				t.Fatal(err)
			}
			_, err := openRootOwned(file, rootOwnedFile)
			if refusal := refusedAs(t, err); refusal.Detail != link+" is a symbolic link" {
				t.Errorf("%s: %q", depth, refusal.Detail)
			}
			if err := os.Remove(link); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(link+"-real", link); err != nil {
				t.Fatal(err)
			}
		}
	})

	t.Run("a named pipe in place of the file", func(t *testing.T) {
		pipe := filepath.Join(base, "a", "pipe")
		if err := unix.Mkfifo(pipe, 0o644); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { _, err := openRootOwned(pipe, rootOwnedFile); done <- err }()
		select {
		case err := <-done:
			if refusal := refusedAs(t, err); refusal.Detail != pipe+" isn't a regular file (it is a named pipe)" {
				t.Errorf("%q", refusal.Detail)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the check waited for a writer to a named pipe")
		}
	})

	t.Run("a directory renamed after the open", func(t *testing.T) {
		dir := filepath.Join(base, "a", "b", "c")
		held := mustOpen(t, dir, rootOwnedDirectory)
		if err := os.Rename(dir, dir+"-moved"); err != nil {
			t.Fatal(err)
		}
		mkdirMode(t, dir, 0o755)
		writeMode(t, filepath.Join(dir, "file"), "evil", 0o644)
		if data, err := held.ReadFileAt("file", 16); err != nil || string(data) != "good" {
			t.Errorf("through the held directory: %q, %v", data, err)
		}
		if err := held.WriteFile("later", []byte("x"), rootReadable); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(dir+"-moved", "later")); err != nil {
			t.Errorf("a file written through the held directory isn't in the directory that was checked: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "later")); err == nil {
			t.Error("a file written through the held directory appeared at the name that was replaced")
		}
	})

	t.Run("directories and files made through the handles are root's", func(t *testing.T) {
		made, err := ensureRootOwnedDir(filepath.Join(base, "made", "below"), rootReadable)
		if err != nil {
			t.Fatal(err)
		}
		defer made.Close()
		if err := made.WriteFile("policy.json", []byte("{}"), rootReadable); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"made", "made/below", "made/below/policy.json"} {
			var st unix.Stat_t
			if err := unix.Stat(filepath.Join(base, filepath.FromSlash(path)), &st); err != nil {
				t.Fatal(err)
			}
			want := uint32(0o755)
			if strings.HasSuffix(path, ".json") {
				want = 0o644
			}
			if st.Uid != 0 || uint32(st.Mode)&0o7777 != want {
				t.Errorf("%s: uid %d, mode %04o; want root and %04o", path, st.Uid, uint32(st.Mode)&0o7777, want)
			}
		}
		again, err := openRootOwned(filepath.Join(base, "made", "below", "policy.json"), rootOwnedFile)
		if err != nil {
			t.Fatalf("what the check made, it accepts: %v", err)
		}
		again.Close()
	})

	t.Run("the places that are open to everyone", func(t *testing.T) {
		for _, path := range []string{"/tmp", "/var/tmp"} {
			if _, err := os.Lstat(path); err != nil {
				continue
			}
			if _, err := openRootOwned(path, rootOwnedDirectory); err == nil {
				t.Errorf("%s was accepted as a directory that only root can write", path)
			} else {
				refusedAs(t, err)
			}
		}
	})
}
