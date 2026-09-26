//go:build linux

package agent

import (
	"os/exec"
	"syscall"
)

func supervisorGuard() (func(), error) { return func() {}, nil }
func childPlatformOptions(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
func stopChild(cmd *exec.Cmd) { _ = cmd.Process.Signal(syscall.SIGTERM) }
