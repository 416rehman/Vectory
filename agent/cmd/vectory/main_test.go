package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Tests work in the canonical temporary directory: strict path checks refuse
// aliases such as macOS's /var -> /private/var link and a Windows runner's
// 8.3 short TEMP (C:\Users\RUNNER~1\...), which EvalSymlinks expands.
func TestMain(m *testing.M) {
	if dir, err := filepath.EvalSymlinks(os.TempDir()); err == nil {
		if runtime.GOOS == "windows" {
			_ = os.Setenv("TMP", dir)
			_ = os.Setenv("TEMP", dir)
		} else {
			_ = os.Setenv("TMPDIR", dir)
		}
	}
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		_ = os.Unsetenv(name)
	}
	os.Exit(m.Run())
}
