package main

import (
	"fmt"
	"os"

	"github.com/vectory/vectory/agent/internal/agent"
)

// stepLogLimit bounds the file a service manager keeps the step's standard error
// in. launchd opens it for appending at every run and never shortens it, and a host
// that waits for someone to apply an update says so every 30 seconds.
const stepLogLimit = 256 << 10

// keepStepLogShort starts the file standard error is again when it has grown past
// stepLogLimit. Only a regular file is touched: under systemd standard error is the
// journal's, and in a terminal it is the terminal.
func keepStepLogShort(stderr *os.File) {
	info, err := stderr.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= stepLogLimit {
		return
	}
	if stderr.Truncate(0) == nil {
		fmt.Fprintf(stderr, "update step: this log passed %d KiB and was started again\n", stepLogLimit>>10)
	}
}

// defineUpdateHelper is one run of the privileged update step. The step's timer
// starts it every 30 seconds and at boot, as root, from the helper's own copy of the
// agent; a run with nothing to do ends at once and silently, and a run that fails
// says why on standard error, which the service manager keeps.
func defineUpdateHelper(c *cli) func() int {
	c.StateDir()
	return func() int {
		keepStepLogShort(os.Stderr)
		ctx, stop := interruptible()
		defer stop()
		if err := agent.RunUpdateHelper(ctx, *c.state); err != nil {
			return c.fail(err)
		}
		return exitOK
	}
}
