package agent

import (
	"io"
	"path/filepath"
	"testing"
)

func TestEnrollmentTokenFileRequiresPrivateRegularHandle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token.txt")
	if err := AtomicWrite(path, []byte("synthetic-token\n")); err != nil {
		t.Fatal(err)
	}
	f, err := OpenEnrollmentTokenFile(path)
	if err != nil {
		t.Fatalf("protected token file refused: %v", err)
	}
	data, err := io.ReadAll(f)
	_ = f.Close()
	if err != nil || string(data) != "synthetic-token\n" {
		t.Fatalf("protected token file changed: %q, %v", data, err)
	}
	if _, err := OpenEnrollmentTokenFile(dir); err == nil {
		t.Fatal("directory accepted as a token file")
	}
	if _, err := OpenEnrollmentTokenFile("token.txt"); err == nil {
		t.Fatal("relative token file accepted")
	}
}
