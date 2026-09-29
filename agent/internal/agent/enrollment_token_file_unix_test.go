//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A refused token file says which check failed and how to fix it.
func TestEnrollmentTokenFileRejectsBroadUnixModeAndHardlinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token.txt")
	if err := AtomicWrite(path, []byte("synthetic-token\n")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenEnrollmentTokenFile(path); err == nil || err.Error() != "Token file "+path+" is readable by other accounts (mode 0644). Fix it: chmod 600 "+path {
		t.Fatalf("group/world-readable token file: %v", err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, filepath.Join(filepath.Dir(path), "another-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenEnrollmentTokenFile(path); err == nil || !strings.Contains(err.Error(), "has 2 hard links") {
		t.Fatalf("hard-linked token file: %v", err)
	}
	missing := filepath.Join(t.TempDir(), "missing.txt")
	if _, err := OpenEnrollmentTokenFile(missing); err == nil || err.Error() != "Token file "+missing+" doesn't exist." {
		t.Fatalf("missing token file: %v", err)
	}
	// Run with sudo, a token file someone else owns could be swapped by them.
	if os.Geteuid() == 0 {
		theirs := filepath.Join(t.TempDir(), "theirs.txt")
		if err := os.WriteFile(theirs, []byte("synthetic-token\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(theirs, 65534, 65534); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenEnrollmentTokenFile(theirs); err == nil || !strings.Contains(err.Error(), "belongs to ") || !strings.HasSuffix(err.Error(), "and is readable by other accounts (mode 0644). Fix it: chown root "+theirs+" && chmod 600 "+theirs) {
			t.Fatalf("token file of another account: %v", err)
		}
	}
}
