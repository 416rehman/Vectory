//go:build windows

package agent

import "golang.org/x/sys/windows"

// On Windows the Service Control Manager reports whether the agent runs.
func agentLockHeld(dir string) bool { return false }

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
