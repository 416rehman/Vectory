package main

import "github.com/vectory/vectory/agent/internal/agent"

// defineUpdateHelper is one run of the privileged update step. The step's timer
// starts it every 30 seconds and at boot, as root, from the helper's own copy of the
// agent; a run with nothing to do ends at once and silently, and a run that fails
// says why on standard error, which the service manager keeps.
func defineUpdateHelper(c *cli) func() int {
	c.StateDir()
	return func() int {
		ctx, stop := interruptible()
		defer stop()
		if err := agent.RunUpdateHelper(ctx, *c.state); err != nil {
			return c.fail(err)
		}
		return exitOK
	}
}
