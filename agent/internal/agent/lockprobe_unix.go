//go:build !windows

package agent

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// agentLockHeld reports whether an agent process holds the state lock. It
// never creates the lock file; a shared probe is released immediately.
func agentLockHeld(dir string) bool {
	f, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_RDONLY, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := unix.Flock(int(f.Fd()), unix.LOCK_SH|unix.LOCK_NB); err != nil {
		return errors.Is(err, unix.EWOULDBLOCK)
	}
	_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
	return false
}
