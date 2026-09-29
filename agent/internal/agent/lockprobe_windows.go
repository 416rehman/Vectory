//go:build windows

package agent

// On Windows the Service Control Manager reports whether the agent runs.
func agentLockHeld(dir string) bool { return false }
