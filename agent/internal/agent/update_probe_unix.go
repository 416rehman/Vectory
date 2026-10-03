//go:build !windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// RunProbe runs `version --json` of the build at path as the service account, with
// the time limit the step allows (updateProbeTimeout).
func (unixUpdateHost) RunProbe(ctx context.Context, path string, account updateAccount) ([]byte, error) {
	return runProbe(ctx, path, account, updateProbeTimeout)
}

// runProbe runs the build as the service account. The step is root, and the build
// is run as the service account with no supplementary group (Go clears the list when
// it is given none), from the root directory, with a clean environment and nothing
// on standard input, in a process group of its own that is killed as a whole when
// the time is up. The output is read to at most 4 KiB and the rest is dropped
// without blocking the writer. No descriptor of the step reaches it: every file the
// step opens is opened close-on-exec, and the three it gets are its own.
//
// The credential is set only when this process is not already that account: root
// can switch, and a test that runs as the account itself (the step's tests run as
// whoever runs them) has nothing to switch. The step never gets here for an
// account of root: a service that runs as root is refused before.
//
// Ending a process that is another account's takes the right to signal it (the
// step's unit lists CAP_KILL for this): without it a build that never answers would
// hold the step until the service manager gave up on the whole run.
func runProbe(ctx context.Context, path string, account updateAccount, limit time.Duration) ([]byte, error) {
	if account.UID == 0 {
		return nil, errors.New("the probe never runs as root")
	}
	runCtx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(runCtx, path, "version", "--json")
	cmd.Dir = "/"
	cmd.Env = cleanEnvironment()
	output := &boundedOutput{limit: updateProbeOutput}
	cmd.Stdout = output
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if os.Geteuid() != int(account.UID) || os.Getegid() != int(account.GID) {
		cmd.SysProcAttr.Credential = &syscall.Credential{Uid: account.UID, Gid: account.GID}
	}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
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
