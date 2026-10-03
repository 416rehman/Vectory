package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

var loopStart = time.Date(2026, 10, 5, 2, 0, 0, 0, time.UTC)

// pacedClock is time that moves when the loop sleeps: it records each pause and
// ends the loop's context after a number of them.
type pacedClock struct {
	now    time.Time
	pauses []time.Duration
	stopAt int
	cancel context.CancelFunc
}

func (c *pacedClock) Now() time.Time { return c.now }

func (c *pacedClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.pauses = append(c.pauses, d)
	c.now = c.now.Add(d)
	if len(c.pauses) == c.stopAt {
		c.cancel()
	}
	return ctx.Err()
}

func TestTheLoopRunsTheStepAgainAfterEveryPauseAndStopsWhenItsContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	clock := &pacedClock{now: loopStart, stopAt: 3, cancel: cancel}
	runs := 0
	runUpdateLoop(ctx, clock, updateRunInterval, func(context.Context) error { runs++; return nil }, func(error) { t.Error("a run that succeeded was reported") })
	if runs != 3 || len(clock.pauses) != 3 {
		t.Fatalf("%d runs and %d pauses, want 3 of each", runs, len(clock.pauses))
	}
	for _, pause := range clock.pauses {
		if pause != 30*time.Second {
			t.Errorf("a pause of %s, and the step runs every 30 seconds", pause)
		}
	}
}

func TestAFailedRunIsReportedAndTheLoopGoesOn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	clock := &pacedClock{now: loopStart, stopAt: 2, cancel: cancel}
	failure := errors.New("the journal can't be read")
	var reported []error
	runUpdateLoop(ctx, clock, time.Second, func(context.Context) error { return failure }, func(err error) { reported = append(reported, err) })
	if len(reported) != 2 || !errors.Is(reported[0], failure) {
		t.Fatalf("reported %v", reported)
	}
}

func TestARunThatEndsBecauseTheContextDidIsNotAFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	clock := &pacedClock{now: loopStart, stopAt: 1, cancel: cancel}
	runUpdateLoop(ctx, clock, time.Second, func(ctx context.Context) error {
		cancel()
		return ctx.Err()
	}, func(err error) { t.Errorf("a run cut short by the service stopping was reported: %v", err) })
	if len(clock.pauses) != 0 {
		t.Errorf("the loop paused %d times after its context ended", len(clock.pauses))
	}
}

func TestALoopWhoseContextIsAlreadyOverNeverRuns(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runUpdateLoop(ctx, &pacedClock{now: loopStart}, time.Second, func(context.Context) error {
		t.Error("the step ran")
		return nil
	}, func(error) {})
}
