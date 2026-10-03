//go:build linux || darwin

package agent

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Root creates the log for a service that runs as another account. The file
// belongs to whoever owns the state directory, or the service couldn't append
// Vector's own lines to it.
func TestNoteLocallyHandsTheNewLogToTheStateDirectoryOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("only root can hand a file to another account")
	}
	dir := t.TempDir()
	if err := os.Chown(dir, 41001, 41002); err != nil {
		t.Skip("this file system doesn't take a chown:", err)
	}
	NoteLocally(dir, "Host operator allowed destination 127.0.0.1:8688 (vectory allow)")
	info, err := os.Stat(filepath.Join(dir, vectorLogName))
	if err != nil {
		t.Fatalf("the note was dropped: %v", err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if stat.Uid != 41001 || stat.Gid != 41002 || info.Mode().Perm() != 0600 {
		t.Fatalf("log owner %d:%d mode %04o, want 41001:41002 mode 0600", stat.Uid, stat.Gid, info.Mode().Perm())
	}
}
