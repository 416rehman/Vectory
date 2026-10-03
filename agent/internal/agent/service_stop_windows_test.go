//go:build windows

package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// serviceScript is a service whose states, one for each look, and whose answers to a
// stop are set by a test.
type serviceScript struct {
	states   []svc.State // what each look finds; the last one repeats
	onStop   func(looks int) error
	looks    int
	controls int
}

func (s *serviceScript) Query() (svc.Status, error) {
	state := s.states[len(s.states)-1]
	if s.looks < len(s.states) {
		state = s.states[s.looks]
	}
	s.looks++
	return svc.Status{State: state}, nil
}

func (s *serviceScript) Control(cmd svc.Cmd) (svc.Status, error) {
	if cmd != svc.Stop {
		return svc.Status{}, errors.New("only a stop is asked")
	}
	s.controls++
	if s.onStop != nil {
		return svc.Status{}, s.onStop(s.looks)
	}
	return svc.Status{State: svc.StopPending}, nil
}

func stopWithin(s *serviceScript, limit time.Duration) error {
	return stopController(context.Background(), "test", s, limit, time.Millisecond)
}

// A service that is starting takes no stop until it reports that it runs: the
// manager answers ERROR_INVALID_SERVICE_CONTROL, and the stop waits and asks again
// instead of ending with that answer, as removing the step's service right after it
// was restarted did.
func TestAStopWaitsForAServiceThatIsStillStartingAndAsksOnce(t *testing.T) {
	s := &serviceScript{
		states: []svc.State{svc.StartPending, svc.StartPending, svc.Running, svc.StopPending, svc.Stopped},
		onStop: func(looks int) error {
			if looks <= 2 {
				return windows.ERROR_INVALID_SERVICE_CONTROL
			}
			return nil
		},
	}
	if err := stopWithin(s, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if s.controls != 3 {
		t.Errorf("the stop was asked %d times, want twice refused while the service started and once taken", s.controls)
	}
}

// A service that runs and doesn't take a stop is an answer, not something to wait for.
func TestAStopRefusedByAServiceThatRunsIsAnErrorAtOnce(t *testing.T) {
	s := &serviceScript{
		states: []svc.State{svc.Running},
		onStop: func(int) error { return windows.ERROR_INVALID_SERVICE_CONTROL },
	}
	started := time.Now()
	err := stopWithin(s, time.Minute)
	if !errors.Is(err, windows.ERROR_INVALID_SERVICE_CONTROL) {
		t.Fatalf("the error is %v", err)
	}
	if s.controls != 1 || time.Since(started) > 10*time.Second {
		t.Errorf("%d stops asked, and it took %s", s.controls, time.Since(started))
	}
}

func TestAStopIsNotAskedOfAServiceThatIsStoppingOrStopped(t *testing.T) {
	for name, states := range map[string][]svc.State{
		"stopped":  {svc.Stopped},
		"stopping": {svc.StopPending, svc.StopPending, svc.Stopped},
	} {
		s := &serviceScript{states: states}
		if err := stopWithin(s, 5*time.Second); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if s.controls != 0 {
			t.Errorf("%s: a stop was asked %d times", name, s.controls)
		}
	}
}

func TestAStopThatNeverEndsGivesUpAtItsLimitAndEndsWithItsContext(t *testing.T) {
	s := &serviceScript{states: []svc.State{svc.Running}}
	err := stopWithin(s, 20*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "didn't stop in time") {
		t.Errorf("a service that never stopped: %v", err)
	}
	if s.controls != 1 {
		t.Errorf("the stop was asked %d times, want once", s.controls)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s = &serviceScript{states: []svc.State{svc.Running}}
	if err := stopController(ctx, "test", s, time.Minute, time.Hour); !errors.Is(err, context.Canceled) {
		t.Errorf("a stop whose context ended: %v", err)
	}
}
