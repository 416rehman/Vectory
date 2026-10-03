package agent

import "testing"

func watchRunning(pid uint32) observedService  { return observedService{State: "running", PID: pid} }
func watchStarting(pid uint32) observedService { return observedService{State: "starting", PID: pid} }
func watchCrashed() observedService {
	return observedService{State: "stopped", Failed: true, Crashed: true}
}

// look is one look at the service and what the watch makes of it.
type look struct {
	saw      observedService
	state    string
	restarts int
	pid      int
}

func TestTheWatchCountsWhatTheManagerDoesNotCount(t *testing.T) {
	for name, tc := range map[string]struct {
		begin uint32
		looks []look
	}{
		"a build that stays up": {100, []look{
			{watchRunning(100), "active", 0, 100},
			{watchRunning(100), "active", 0, 100},
			{watchRunning(100), "active", 0, 100},
		}},
		"a build that crashes at every start, which the manager restarts after each pause": {100, []look{
			{watchRunning(100), "active", 0, 100},
			// Crashed: the manager is about to restart it, as systemd's activating says.
			{watchCrashed(), "activating", 1, 0},
			{watchCrashed(), "activating", 1, 0},
			{watchRunning(200), "active", 1, 200},
			{watchCrashed(), "activating", 2, 0},
			{watchRunning(300), "active", 2, 300},
			{watchCrashed(), "activating", 3, 0},
		}},
		"a restart between two looks that gives the process a new identifier": {100, []look{
			{watchRunning(100), "active", 0, 100},
			{watchRunning(200), "active", 1, 200},
			{watchRunning(200), "active", 1, 200},
			{watchRunning(300), "active", 2, 300},
		}},
		// Process identifiers are reused: a crash that was seen is counted once, whichever
		// identifier the restarted process has.
		"a crash seen, and the restart that has the same identifier": {100, []look{
			{watchRunning(100), "active", 0, 100},
			{watchCrashed(), "activating", 1, 0},
			{watchRunning(100), "active", 1, 100},
			{watchRunning(100), "active", 1, 100},
			{watchRunning(200), "active", 2, 200},
		}},
		"a service that is still starting": {100, []look{
			{watchStarting(100), "activating", 0, 100},
			{watchRunning(100), "active", 0, 100},
		}},
		"a service that exits with an error of its own, which the manager doesn't restart": {100, []look{
			{watchRunning(100), "active", 0, 100},
			{observedService{State: "stopped", Failed: true}, "failed", 0, 0},
		}},
		"a service that was stopped": {100, []look{
			{watchRunning(100), "active", 0, 100},
			{observedService{State: "stopping", PID: 100}, "deactivating", 0, 100},
			{observedService{State: "stopped"}, "inactive", 0, 0},
		}},
		"a service that has no process yet": {0, []look{
			{watchStarting(0), "activating", 0, 0},
			{watchRunning(500), "active", 0, 500},
			{watchRunning(500), "active", 0, 500},
		}},
		"a state the watch doesn't know": {100, []look{
			{observedService{State: "unknown"}, "inactive", 0, 0},
		}},
	} {
		var w serviceWatch
		w.begin(tc.begin)
		for i, step := range tc.looks {
			got := w.observe(step.saw)
			if got.State != step.state || got.Restarts != step.restarts || got.PID != step.pid {
				t.Errorf("%s, look %d: %+v, want state %s, %d restarts, pid %d", name, i+1, got, step.state, step.restarts, step.pid)
			}
		}
	}
}

func TestBeginningAgainForgetsWhatTheLastRunCounted(t *testing.T) {
	var w serviceWatch
	w.begin(100)
	w.observe(watchCrashed())
	w.observe(watchRunning(200))
	if got := w.observe(watchRunning(200)); got.Restarts != 1 {
		t.Fatalf("%+v", got)
	}
	w.begin(300)
	if got := w.observe(watchRunning(300)); got.Restarts != 0 || got.State != "active" {
		t.Errorf("after the service was started again: %+v", got)
	}
}

// The step ends a trial when the count reaches three, and a build that crashes at
// every start must reach it within the five minutes: the manager restarts after 5
// seconds, 30 seconds and a minute, so three crashes are seen within two minutes.
func TestACrashLoopReachesTheStepsLimitWithinTheTrial(t *testing.T) {
	var w serviceWatch
	w.begin(100)
	restarts := 0
	for _, step := range []observedService{watchRunning(100), watchCrashed(), watchRunning(101), watchCrashed(), watchRunning(102), watchCrashed()} {
		restarts = w.observe(step).Restarts
	}
	if restarts < updateRestartLimit {
		t.Errorf("three crashes count as %d restarts, and the step's limit is %d", restarts, updateRestartLimit)
	}
}
