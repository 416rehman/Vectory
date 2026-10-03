//go:build darwin

package agent

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// The macOS extension of the path check on real access lists: entries made with
// chmod +a on a directory and on a file, at each depth of a policy-shaped tree,
// each refused with UNTRUSTED_LOCATION and the name of the right, and a clean tree
// that passes. The same checks run twice. Unprivileged, on a tree the test owns
// (the seam that trusts the test's account), in the normal run of the agent job.
// As root, on a tree root owns and the check as it ships, in the run that
// the job repeats as root (TestRootOwnedChecksOnReal...).

// chmodACL runs chmod with an access list flag: +a with an entry, -N to clear.
func chmodACL(t *testing.T, flag, entry, path string) {
	t.Helper()
	args := []string{flag}
	if entry != "" {
		args = append(args, entry)
	}
	if out, err := exec.Command("/bin/chmod", append(args, path)...).CombinedOutput(); err != nil {
		t.Fatalf("chmod %s %q %s: %v\n%s", flag, entry, path, err, out)
	}
}

// aclTree builds the tree of a policy under base: three directories and a file.
func aclTree(t *testing.T, base string) (dirs []string, file string) {
	t.Helper()
	for _, dir := range []string{"a", "a/b", "a/b/c"} {
		path := filepath.Join(base, filepath.FromSlash(dir))
		mkdirMode(t, path, 0o755)
		dirs = append(dirs, path)
	}
	file = filepath.Join(dirs[2], "file")
	writeMode(t, file, "good", 0o644)
	return dirs, file
}

func runExtendedACLChecks(t *testing.T, base string) {
	dirs, file := aclTree(t, base)
	mustOpen(t, file, rootOwnedFile)
	clear := func(path string) { chmodACL(t, "-N", "", path) }

	// refused sets an entry on path, expects the check on file to refuse path for
	// those rights, and clears the list again.
	refused := func(t *testing.T, path, entry, rights string) {
		t.Helper()
		chmodACL(t, "+a", entry, path)
		defer clear(path)
		_, err := openRootOwned(file, rootOwnedFile)
		refusal := refusedAs(t, err)
		if want := path + " has an access list entry that allows " + rights + " to "; !strings.HasPrefix(refusal.Detail, want) {
			t.Errorf("%q: %q, want it to start %q", entry, refusal.Detail, want)
		}
	}
	passes := func(t *testing.T, path, entry string) {
		t.Helper()
		chmodACL(t, "+a", entry, path)
		defer clear(path)
		if r, err := openRootOwned(file, rootOwnedFile); err != nil {
			t.Errorf("%q on %s: %v", entry, path, err)
		} else {
			r.Close()
		}
	}

	t.Run("a clean tree passes, and each directory and the file open", func(t *testing.T) {
		for _, path := range dirs {
			mustOpen(t, path, rootOwnedDirectory)
		}
		mustOpen(t, file, rootOwnedFile)
	})

	t.Run("an entry for another account that lets it change a directory, at each depth", func(t *testing.T) {
		for _, dir := range dirs {
			for _, c := range []struct{ entry, rights string }{
				{"group:everyone allow add_file", "add_file"},
				{"group:everyone allow add_subdirectory", "add_subdirectory"},
				{"group:everyone allow delete_child", "delete_child"},
				{"group:everyone allow delete", "delete"},
				{"group:everyone allow writesecurity", "writesecurity"},
				{"group:everyone allow chown", "chown"},
				{"group:everyone allow list,add_file,delete_child", "add_file and delete_child"},
				{"user:daemon allow add_file", "add_file"},
				{"group:admin allow add_file", "add_file"},
				{"group:wheel allow add_file", "add_file"},
				// An entry only the children inherit is the directory's own: it decides who
				// may rewrite what the step makes there.
				{"group:everyone allow add_file,file_inherit,only_inherit", "add_file"},
				{"group:everyone allow delete_child,directory_inherit,only_inherit", "delete_child"},
			} {
				refused(t, dir, c.entry, c.rights)
			}
		}
	})

	t.Run("an entry for another account that lets it change the file", func(t *testing.T) {
		for _, c := range []struct{ entry, rights string }{
			{"group:everyone allow write", "write"},
			{"group:everyone allow append", "append"},
			{"group:everyone allow delete", "delete"},
			{"group:everyone allow writesecurity", "writesecurity"},
			{"group:everyone allow chown", "chown"},
			{"user:daemon allow write,append", "write and append"},
		} {
			refused(t, file, c.entry, c.rights)
		}
	})

	t.Run("a denial, a reading entry and an entry for what changes no content pass, at each depth", func(t *testing.T) {
		for _, dir := range dirs {
			for _, entry := range []string{
				"group:everyone deny delete",
				"group:everyone deny add_file,add_subdirectory,delete_child,writesecurity,chown",
				"group:everyone allow list,search,readattr,readextattr,readsecurity",
				"user:daemon allow search",
				"group:everyone allow writeattr,writeextattr",
			} {
				passes(t, dir, entry)
			}
		}
		for _, entry := range []string{"group:everyone deny write,append,delete", "group:everyone allow read,execute,readattr", "user:daemon allow readsecurity"} {
			passes(t, file, entry)
		}
	})

	t.Run("a denial before a permit does not clear it", func(t *testing.T) {
		chmodACL(t, "+a", "user:daemon deny add_file", dirs[1])
		chmodACL(t, "+a", "group:everyone allow add_file", dirs[1])
		defer clear(dirs[1])
		if _, err := openRootOwned(file, rootOwnedFile); err == nil {
			t.Error("a permit that follows a denial passed")
		} else {
			refusedAs(t, err)
		}
	})

	t.Run("an entry a directory handed to what it made is refused on that, after the parent's own is gone", func(t *testing.T) {
		parent := filepath.Join(base, "inherits")
		mkdirMode(t, parent, 0o755)
		chmodACL(t, "+a", "group:everyone allow add_file,delete_child,list,file_inherit,directory_inherit", parent)
		child := filepath.Join(parent, "child")
		if err := os.Mkdir(child, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(child, 0o755); err != nil {
			t.Fatal(err)
		}
		made := filepath.Join(parent, "file")
		writeMode(t, made, "inherited", 0o644)
		clear(parent)
		mustOpen(t, parent, rootOwnedDirectory)
		for path, kind := range map[string]rootOwnedKind{child: rootOwnedDirectory, made: rootOwnedFile} {
			_, err := openRootOwned(path, kind)
			refusal := refusedAs(t, err)
			if !strings.HasPrefix(refusal.Detail, path+" has an access list entry that allows ") {
				t.Errorf("%s: %q", path, refusal.Detail)
			}
		}
	})

	t.Run("the files the check makes through its handles carry no entry of another account", func(t *testing.T) {
		made, err := ensureRootOwnedDir(filepath.Join(base, "made", "below"), rootReadable)
		if err != nil {
			t.Fatal(err)
		}
		defer made.Close()
		if err := made.WriteFile("policy.json", []byte("{}"), rootReadable); err != nil {
			t.Fatal(err)
		}
		again, err := openRootOwned(filepath.Join(base, "made", "below", "policy.json"), rootOwnedFile)
		if err != nil {
			t.Fatalf("what the check made, it accepts: %v", err)
		}
		again.Close()
	})

	// Everything the subtests set was cleared.
	mustOpen(t, file, rootOwnedFile)
}

func TestRootOwnedRefusesAnAccessListEntryThatLetsAnotherAccountChangeThePath(t *testing.T) {
	runExtendedACLChecks(t, ownTree(t))
}

func TestRootOwnedChecksOnRealExtendedAccessLists(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("this test builds trees that root owns, so it runs as root")
	}
	if rootOwnedTrust != (ownerTrust{}) {
		t.Fatal("a test left the path check's seam set: this test runs the check as it ships")
	}
	runExtendedACLChecks(t, systemBase(t))
}

// The kernel's own lists on directories a Mac ships, read through a handle: the
// call works on real objects whatever they carry, and what the Mac puts there takes
// nothing from root (a denial of delete on the folders people keep things in).
func TestTheAccessListOfARealDirectoryReadsWithoutAnError(t *testing.T) {
	read := 0
	for _, path := range []string{"/", "/Library", "/Applications", "/Users", "/usr", "/usr/bin", t.TempDir()} {
		fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			t.Logf("%s: %v", path, err)
			continue
		}
		acl, err := darwinACLOfDescriptor(fd)
		unix.Close(fd)
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
			t.Logf("%s: this file system keeps no access lists", path)
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		entries, err := parseExtendedACL(acl)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		problem, _ := extendedACLProblem(acl, true)
		t.Logf("%s: %d entries, problem %q", path, len(entries), problem)
		for _, entry := range entries {
			t.Logf("    kind %d rights %#x for %s", entry.kind, entry.rights, entry.principal)
		}
		read++
	}
	if read == 0 {
		t.Fatal("not one directory could be read")
	}
}
