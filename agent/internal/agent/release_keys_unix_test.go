//go:build !windows

package agent

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A private key is created closed to everyone else, whatever the umask says,
// and is read back only while it stays that way.
func TestPrivateKeyFileIsPrivateOnUnix(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	dir := privateTempDir(t)
	path := filepath.Join(dir, "team.key")
	key := testPrivateKey(t, 6)
	if err := WriteReleasePrivateKey(path, key); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode().Perm() != 0o600 || !info.Mode().IsRegular() {
		t.Fatalf("%v %v", info, err)
	}
	if contents, _ := os.ReadFile(path); string(contents) != string(key.FileContents()) {
		t.Fatalf("%q", contents)
	}
	// Owner-only is enough; anything for the group or others is refused.
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadReleasePrivateKey(path); err != nil {
		t.Errorf("a key only its owner can read: %v", err)
	}
	for _, mode := range []os.FileMode{0o640, 0o604, 0o644, 0o660, 0o666} {
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		_, err := ReadReleasePrivateKey(path)
		if err == nil || !strings.Contains(err.Error(), "readable by other accounts") || !strings.Contains(err.Error(), "chmod 600") || strings.Contains(err.Error(), "token") {
			t.Errorf("mode %04o: %v", mode, err)
		}
	}
}

func TestPrivateKeyFileRefusesLinksAndOtherFiles(t *testing.T) {
	dir := privateTempDir(t)
	real := filepath.Join(dir, "real.key")
	if err := WriteReleasePrivateKey(real, testPrivateKey(t, 6)); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(dir, "link.key")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadReleasePrivateKey(link); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Errorf("a symbolic link: %v", err)
	}

	hard := filepath.Join(dir, "hard.key")
	if err := os.Link(real, hard); err != nil {
		t.Fatal(err)
	}
	// The fix the shared wording gives for a second name is said for a key, not a token.
	if _, err := ReadReleasePrivateKey(hard); err == nil || !strings.Contains(err.Error(), "hard links") || !strings.Contains(err.Error(), "Save the key in a new file") || strings.Contains(err.Error(), "token") {
		t.Errorf("a second name for the file: %v", err)
	}
	_ = os.Remove(hard)

	if _, err := ReadReleasePrivateKey(dir); err == nil {
		t.Error("a directory is refused")
	}

	// A named pipe is refused without waiting for a writer.
	fifo := filepath.Join(dir, "pipe.key")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := ReadReleasePrivateKey(fifo)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a pipe is accepted")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("reading a pipe waits for a writer")
	}

	// A path with a link above it is refused to read and to write.
	linkedDir := filepath.Join(dir, "linked")
	if err := os.Symlink(dir, linkedDir); err != nil {
		t.Fatal(err)
	}
	if err := WriteReleasePrivateKey(filepath.Join(linkedDir, "new.key"), testPrivateKey(t, 8)); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Errorf("a write through a linked directory: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "new.key")); err == nil {
		t.Error("the write went through the link")
	}
}

// A symbolic link in the place of the new file, even one that points nowhere,
// is refused: nothing is created at its target.
func TestWritingAPrivateKeyNeverFollowsALink(t *testing.T) {
	dir := privateTempDir(t)
	target := filepath.Join(dir, "target.key")
	link := filepath.Join(dir, "team.key")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := WriteReleasePrivateKey(link, testPrivateKey(t, 6)); err == nil {
		t.Fatal("a write through a link was accepted")
	}
	if _, err := os.Lstat(target); err == nil {
		t.Error("a file was created at the link's target")
	}
	// A file that exists is refused as existing, and left as it was.
	existing := filepath.Join(dir, "existing.key")
	if err := os.WriteFile(existing, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteReleasePrivateKey(existing, testPrivateKey(t, 6)); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("%v", err)
	}
	if contents, _ := os.ReadFile(existing); string(contents) != "mine" {
		t.Errorf("%q", contents)
	}
}
