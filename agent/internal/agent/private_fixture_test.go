package agent

import (
	"path/filepath"
	"testing"
)

// privateTempDir is t.TempDir() in canonical form. Private-file checks
// compare the opened handle's final path with the requested one, so
// fixtures must not name files through aliases: Windows CI runners use an
// 8.3 short TEMP (C:\Users\RUNNER~1\...), and macOS TMPDIR sits under the
// /var symlink. AtomicWrite already gives new files an owner-only ACL.
func privateTempDir(t testing.TB) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}
