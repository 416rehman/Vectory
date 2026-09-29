//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnrollmentTokenFileRejectsBroadUnixModeAndHardlinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token.txt")
	if err := AtomicWrite(path, []byte("synthetic-token\n")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenEnrollmentTokenFile(path); err == nil {
		t.Fatal("group/world-readable token file accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, filepath.Join(filepath.Dir(path), "another-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenEnrollmentTokenFile(path); err == nil {
		t.Fatal("hard-linked token file accepted")
	}
}
