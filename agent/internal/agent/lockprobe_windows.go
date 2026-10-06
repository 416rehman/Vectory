//go:build windows

package agent

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// agentLockHeld reports whether an agent process holds the state lock. The
// agent locks the first byte of agent.lock exclusively (lockAgentFile), so a
// shared lock on it fails while one runs. The Service Control Manager reports a
// registered service; this finds an agent that runs without one. It never
// creates the lock file, and it releases at once what it takes.
func agentLockHeld(dir string) bool {
	f, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_RDONLY, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	var o windows.Overlapped
	handle := windows.Handle(f.Fd())
	if err := windows.LockFileEx(handle, windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &o); err != nil {
		return errors.Is(err, windows.ERROR_LOCK_VIOLATION)
	}
	_ = windows.UnlockFileEx(handle, 0, 1, 0, &o)
	return false
}

// processAlive reports whether pid is a running process.
func processAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// Access denied still means the process exists.
		return err == windows.ERROR_ACCESS_DENIED
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if windows.GetExitCodeProcess(handle, &code) != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}
