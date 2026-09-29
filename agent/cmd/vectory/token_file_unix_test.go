//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A world-readable token file is refused at input preflight, before the
// state directory is looked at or created, by enroll and by setup.
func TestPublicTokenFileIsRefusedBeforeStateAccess(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "synthetic-token.txt")
	if err := os.WriteFile(path, []byte("synthetic-token\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, "uninstalled")
	for _, args := range [][]string{
		{"enroll", "--state-dir", state, "--server", "https://example.invalid", "--name", "edge-01", "--token-file", path},
		{"setup", "--state-dir", state, "--server", "https://example.invalid", "--name", "edge-01", "--service", "none", "--token-file", path},
	} {
		code, stdout, stderr := invoke(args...)
		if code != 1 || !strings.Contains(stderr, "token file must be private") {
			t.Fatalf("%s: public token file passed input preflight: exit=%d stdout=%q stderr=%q", args[0], code, stdout, stderr)
		}
		if strings.Contains(stderr, "install the agent first") {
			t.Fatalf("%s: state was checked before the token input", args[0])
		}
		if _, err := os.Lstat(state); !os.IsNotExist(err) {
			t.Fatalf("%s: refused enrollment touched state: %v", args[0], err)
		}
	}
}
