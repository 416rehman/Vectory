//go:build windows

package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// RunProbe runs `version --json` of the build at path, with the time limit the
// step allows (updateProbeTimeout). Windows has no switch of account that
// doesn't need the account's password, so the probe runs as the step does: as
// LocalSystem under the service, as the administrator who runs `vectory setup` or
// `vectory update apply` otherwise. The build is the verified copy of the step's
// own, in the probe directory, which only SYSTEM and the Administrators can write,
// and what it prints decides nothing but whether the step goes on.
func (h *windowsUpdateHost) RunProbe(ctx context.Context, path string, account updateAccount) ([]byte, error) {
	return runProbe(ctx, path, updateProbeTimeout)
}

// runProbe runs the build from a directory of the system's, with a clean environment
// and nothing on standard input, ends it when the time is up, and reads its output
// to at most 4 KiB, dropping the rest without blocking the writer.
func runProbe(ctx context.Context, path string, limit time.Duration) ([]byte, error) {
	runCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(runCtx, path, "version", "--json")
	cmd.Dir = systemDirectory()
	cmd.Env = cleanEnvironment()
	output := &boundedOutput{limit: updateProbeOutput}
	cmd.Stdout = output
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		if runCtx.Err() != nil {
			return nil, fmt.Errorf("the build didn't finish within %s", limit)
		}
		return nil, fmt.Errorf("the build failed: %w", err)
	}
	if output.overflow {
		return nil, errProbeOutputTooLong
	}
	return output.buffer.Bytes(), nil
}

// systemDirectory is Windows's own directory of programs, which only root can
// write: a build that is asked its version has no business anywhere else.
func systemDirectory() string {
	if dir, err := windows.GetSystemDirectory(); err == nil && dir != "" {
		return dir
	}
	if root := os.Getenv("SystemRoot"); root != "" {
		return root + `\System32`
	}
	return `C:\Windows\System32`
}
