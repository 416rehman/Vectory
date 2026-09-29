//go:build darwin

package agent

import (
	"os/exec"
	"syscall"
)

func supervisorGuard() (func(), error) { return func() {}, nil }

// supervisorPlatformOptions starts the supervisor (and so Vector) in its own
// process group: a terminal's Ctrl-C reaches only the agent, which then asks
// for exactly one graceful stop through the supervisor's stdin.
func supervisorPlatformOptions(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
func childPlatformOptions(cmd *exec.Cmd) {}
func stopChild(cmd *exec.Cmd)            { _ = cmd.Process.Signal(syscall.SIGTERM) }
func reloadChild(cmd *exec.Cmd)          { _ = cmd.Process.Signal(syscall.SIGHUP) }
