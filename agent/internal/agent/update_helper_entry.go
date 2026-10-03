package agent

import "context"

// RunUpdateHelperCommand is what the hidden update-helper command runs. Where the
// operating system starts the step as a service of its own (Windows, whose service
// manager has no timer to start it), the process is that service and runs the step
// every 30 seconds until it is stopped. Everywhere else, and when a person runs the
// command in a console, it is one run of the step, as RunUpdateHelper is.
func RunUpdateHelperCommand(ctx context.Context, dir string) error {
	if ran, err := runUpdateService(ctx, dir); ran {
		return err
	}
	return RunUpdateHelper(ctx, dir)
}
