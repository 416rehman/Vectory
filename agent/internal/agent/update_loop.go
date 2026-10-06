package agent

import (
	"context"
	"time"
)

// updateRunInterval is how long a service that has no timer (the Windows step)
// waits between the end of one run of the step and the start of the next: the 30
// seconds the timer and its equivalents give every other platform.
const updateRunInterval = 30 * time.Second

// runUpdateLoop runs the step again and again until ctx ends: one run, a pause of
// every, the next run. A run that fails is reported and doesn't end the loop, as a
// timer that starts a failed unit again doesn't stop; a run that ends because ctx
// did is not a failure. The clock is the step's own, so that a test moves it.
func runUpdateLoop(ctx context.Context, clock updateClock, every time.Duration, run func(context.Context) error, report func(error)) {
	for ctx.Err() == nil {
		if err := run(ctx); err != nil && ctx.Err() == nil {
			report(err)
		}
		if clock.Sleep(ctx, every) != nil {
			return
		}
	}
}
