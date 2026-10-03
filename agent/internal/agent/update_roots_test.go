package agent

import (
	"path/filepath"
	"runtime"
	"testing"
)

// realTempDir is a temporary directory with no link in its path: on macOS the
// temporary directory is behind /var, a link, and the readers of the update
// files refuse a link at any depth.
func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// useUpdateRoots points every update path (UpdateLocations) at a tree the test
// owns, and makes the path check trust the test's own account there, until the
// test ends. Tests of the code that reads the policy, reads the step's status
// or writes the step's files use it instead of the system's directories, which
// only root can make. It returns the paths; nothing exists under them yet
// (ensureRootOwnedDir and the writers make what they need). A test that makes
// directories that only root may change calls requireRootOwnedWriter first.
func useUpdateRoots(t *testing.T) UpdatePaths {
	t.Helper()
	root := ownTree(t)
	// Directories above each of the two, as there are on a host, so that the
	// check judges more than the last.
	paths := newUpdatePaths(filepath.Join(root, "etc", "vectory", "updates"), filepath.Join(root, "var", "lib", "vectory-update"), runtime.GOOS == "windows")
	old := updateLocationsOverride
	updateLocationsOverride = &paths
	t.Cleanup(func() { updateLocationsOverride = old })
	return paths
}

func TestUseUpdateRootsPointsTheUpdateCodeAtATreeTheTestOwns(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if UpdateLocations() != paths {
		t.Fatal("the update paths weren't moved")
	}
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatalf("a directory under the test's tree: %v", err)
	}
	dir.Close()
	again, err := openRootOwned(paths.PolicyDir, rootOwnedDirectory)
	if err != nil {
		t.Fatalf("a directory the test made: %v", err)
	}
	again.Close()
}
