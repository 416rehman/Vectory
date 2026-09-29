package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// On macOS the temporary directory lives under the /var -> /private/var link,
// which strict path checks refuse; tests work in its canonical location.
func TestMain(m *testing.M) {
	if runtime.GOOS != "windows" {
		if dir, err := filepath.EvalSymlinks(os.TempDir()); err == nil {
			_ = os.Setenv("TMPDIR", dir)
		}
	}
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		_ = os.Unsetenv(name)
	}
	os.Exit(m.Run())
}
