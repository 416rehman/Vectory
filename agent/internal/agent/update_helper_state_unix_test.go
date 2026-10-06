//go:build !windows

package agent

import (
	"os"
	"testing"
)

// requireStepFilePrivate checks that a file the step wrote is its own: mode 0600, so
// that only its owner (root) can read it. A Windows file has an access list instead
// (update_windows_support_test.go).
func requireStepFilePrivate(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("%s: %v, %v", path, info, err)
	}
}
