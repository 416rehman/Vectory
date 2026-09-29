//go:build darwin

package agent

import (
	"os/exec"
	"syscall"
)

func supervisorGuard() (func(), error)   { return func() {}, nil }
func childPlatformOptions(cmd *exec.Cmd) {}
func stopChild(cmd *exec.Cmd)            { _ = cmd.Process.Signal(syscall.SIGTERM) }
func reloadChild(cmd *exec.Cmd)          { _ = cmd.Process.Signal(syscall.SIGHUP) }
