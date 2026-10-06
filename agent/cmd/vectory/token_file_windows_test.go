//go:build windows

package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
	"golang.org/x/sys/windows"
)

func TestEnrollmentRefusesPublicTokenFileBeforeStateAccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "synthetic-token.txt")
	if err := agent.AtomicWrite(path, []byte("synthetic-token\n")); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}

	oldStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() { os.Stderr = oldStderr; _ = w.Close() }()
	code := run([]string{"enroll", "--state-dir", filepath.Join(dir, "uninstalled"), "--server", "https://example.invalid", "--id", "edge-01", "--token-file", path})
	_ = w.Close()
	os.Stderr = oldStderr
	defer r.Close()
	message, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if code != 1 || !strings.Contains(string(message), "is readable by other accounts") {
		t.Fatalf("public token file was accepted past input preflight: exit=%d, stderr=%q", code, message)
	}
	if _, err := os.Lstat(filepath.Join(dir, "uninstalled")); !os.IsNotExist(err) {
		t.Fatalf("refused enrollment created state: %v", err)
	}
}

func TestEnrollmentRefusesAlternateStreamTokenFileBeforeStateAccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "synthetic-token.txt")
	if err := agent.AtomicWrite(path, []byte("ordinary-file\n")); err != nil {
		t.Fatal(err)
	}
	stream := path + ":alternate"
	if err := os.WriteFile(stream, []byte("synthetic-token\n"), 0600); err != nil {
		t.Skipf("test volume cannot create an alternate data stream: %v", err)
	}

	oldStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() { os.Stderr = oldStderr; _ = w.Close() }()
	code := run([]string{"enroll", "--state-dir", filepath.Join(dir, "uninstalled"), "--server", "https://example.invalid", "--id", "edge-01", "--token-file", stream})
	_ = w.Close()
	os.Stderr = oldStderr
	defer r.Close()
	message, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if code != 1 || !strings.Contains(string(message), "isn't a plain path on a local disk") {
		t.Fatalf("alternate stream was accepted past input preflight: exit=%d, stderr=%q", code, message)
	}
	if _, err := os.Lstat(filepath.Join(dir, "uninstalled")); !os.IsNotExist(err) {
		t.Fatalf("refused enrollment created state: %v", err)
	}
}
