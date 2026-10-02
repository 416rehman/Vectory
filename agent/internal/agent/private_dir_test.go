//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// The service account owns the private directory, and has to reach it through
// the directories setup created above it. They were root's alone (mode 0700),
// so an agent installed as a service could never write its managed
// configuration; they are searchable by everyone now, whatever the umask, and
// only the private directory is private.
func TestPrivateDirMakesTheDirectoriesItCreatesAboveItTraversable(t *testing.T) {
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	root := t.TempDir()
	private := filepath.Join(root, "etc", "vectory", "managed")
	if err := PrivateDir(private); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Join(root, "etc"), filepath.Join(root, "etc", "vectory")} {
		if got := mode(t, dir); got != 0755 {
			t.Errorf("%s: mode %04o, want 0755", dir, got)
		}
	}
	if got := mode(t, private); got != 0700 {
		t.Errorf("the private directory: mode %04o, want 0700", got)
	}
}

func TestPrivateDirLeavesADirectoryThatExistsAsItIs(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "shared")
	if err := os.Mkdir(parent, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0750); err != nil {
		t.Fatal(err)
	}
	if err := PrivateDir(filepath.Join(parent, "private")); err != nil {
		t.Fatal(err)
	}
	if got := mode(t, parent); got != 0750 {
		t.Errorf("an existing parent changed to %04o", got)
	}
}

func TestFreshStateDirectoryKeepsItsNewParentTraversable(t *testing.T) {
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	root := t.TempDir()
	dir := filepath.Join(root, "Vectory", "agent")
	if err := createFreshStateDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if got := mode(t, filepath.Join(root, "Vectory")); got != 0755 {
		t.Errorf("the new parent of the state directory: mode %04o, want 0755", got)
	}
}

func TestServiceAccountMustBeAbleToReachItsFolders(t *testing.T) {
	root := t.TempDir()
	closed := filepath.Join(root, "etc")
	leaf := filepath.Join(closed, "vectory", "managed")
	if err := os.MkdirAll(leaf, 0700); err != nil {
		t.Fatal(err)
	}
	// Another account, as the service account is for a root-owned tree: the
	// closed directory is no way in.
	other, otherGroup := os.Getuid()+1000, os.Getgid()+1000
	err := checkServiceCanReach(leaf, "vectory", other, otherGroup)
	if err == nil || !strings.Contains(err.Error(), "chmod o+x") || !strings.Contains(err.Error(), filepath.Join(closed, "vectory")) {
		t.Fatalf("a closed directory above the folder: %v", err)
	}
	// Opening every directory above it lets the account in (the test's own
	// folders, up to the system's temporary directory, included).
	for dir := filepath.Join(closed, "vectory"); dir != os.TempDir() && dir != "/"; dir = filepath.Dir(dir) {
		if err := os.Chmod(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkServiceCanReach(leaf, "vectory", other, otherGroup); err != nil {
		t.Fatalf("open directories: %v", err)
	}
	// A directory the account itself owns is open to it whatever its mode.
	if err := os.Chmod(filepath.Join(closed, "vectory"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := checkServiceCanReach(leaf, "vectory", os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("a directory the account owns: %v", err)
	}
	// A group that may search it is enough.
	if err := os.Chmod(filepath.Join(closed, "vectory"), 0710); err != nil {
		t.Fatal(err)
	}
	if err := checkServiceCanReach(leaf, "vectory", other, os.Getgid()); err != nil {
		t.Fatalf("a group that may search: %v", err)
	}
}
