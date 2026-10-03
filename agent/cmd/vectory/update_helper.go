package main

import "github.com/vectory/vectory/agent/internal/agent"

// defineUpdateHelper is one run of the privileged update step. The step's timer
// starts it every 30 seconds and at boot, as root, from the helper's own copy of the
// agent; a run with nothing to do ends at once and silently, and a run that fails
// says why on standard error, which the service manager keeps. On Windows, where
// there is no timer, the service manager starts it as the step's own service, and it
// makes the runs itself every 30 seconds (the step's log is a file of its private
// directory then).
func defineUpdateHelper(c *cli) func() int {
	c.StateDir()
	return func() int {
		ctx, stop := interruptible()
		defer stop()
		if err := agent.RunUpdateHelperCommand(ctx, *c.state); err != nil {
			return c.fail(err)
		}
		return exitOK
	}
}
