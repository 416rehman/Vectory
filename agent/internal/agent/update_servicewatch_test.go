package agent

import (
	"testing"
	"time"
)

// watchBase is the time of the first look of a test, and watchGap what the step waits
// between two looks.
var watchBase = time.Date(2026, 10, 5, 2, 0, 0, 0, time.UTC)

const watchGap = 2 * time.Second

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
			got := w.observe(step.saw, watchBase.Add(time.Duration(i)*watchGap))
			if got.State != step.state || got.Restarts != step.restarts || got.PID != step.pid {
				t.Errorf("%s, look %d: %+v, want state %s, %d restarts, pid %d", name, i+1, got, step.state, step.restarts, step.pid)
			}
		}
	}
}

func TestBeginningAgainForgetsWhatTheLastRunCounted(t *testing.T) {
	var w serviceWatch
	w.begin(100)
	w.observe(watchCrashed(), watchBase)
	w.observe(watchRunning(200), watchBase)
	if got := w.observe(watchRunning(200), watchBase); got.Restarts != 1 {
		t.Fatalf("%+v", got)
	}
	w.begin(300)
	if got := w.observe(watchRunning(300), watchBase); got.Restarts != 0 || got.State != "active" {
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
		restarts = w.observe(step, watchBase).Restarts
	}
	if restarts < updateRestartLimit {
		t.Errorf("three crashes count as %d restarts, and the step's limit is %d", restarts, updateRestartLimit)
	}
}

// A build that crashes as it starts lives for less than a look, so no look sees its
// process, and the manager keeps the service stopped through the pauses it makes before
// each restart (5 seconds, 30 seconds, a minute). What the looks show is a service that
// crashed and has stayed stopped, so the restarts are read from the time that passes.
func TestACrashLoopNoLookSeesIsReadFromThePausesOfTheManager(t *testing.T) {
	var w serviceWatch
	w.begin(100)
	at := func(seconds float64) time.Time { return watchBase.Add(time.Duration(seconds * float64(time.Second))) }
	for _, step := range []struct {
		seconds  float64
		restarts int
	}{
		{0, 1},     // the crash that the first look finds
		{2, 1},     // the manager is still in its pause of 5 seconds
		{5.5, 1},   // and the restarted process may not have ended again yet
		{6, 2},     // it has: a second crash that no look saw
		{35, 2},    // the pause of 30 seconds
		{36.9, 2},  //
		{37, 3},    // the third, which is the step's limit
		{97.9, 3},  // the pause of a minute
		{98, 4},    // and every minute after
		{99, 4},    //
		{158.9, 4}, //
		{159, 5},   //
		{159.5, 5}, // a look in the same second counts nothing twice
	} {
		got := w.observe(watchCrashed(), at(step.seconds))
		if got.Restarts != step.restarts || got.State != "activating" {
			t.Errorf("at %.1f s after the first crash: %d restarts and %s, want %d and activating", step.seconds, got.Restarts, got.State, step.restarts)
		}
		if !got.CountsFromStart {
			t.Errorf("at %.1f s: the count isn't said to begin at the start the step made", step.seconds)
		}
	}
	// A look that sees the service run again ends the wait: the next crash is counted
	// as a new one, and the time begins again.
	if got := w.observe(watchRunning(300), at(200)); got.Restarts != 5 || got.State != "active" {
		t.Errorf("a running service after the loop: %+v", got)
	}
	if got := w.observe(watchCrashed(), at(210)); got.Restarts != 6 {
		t.Errorf("a new crash: %d restarts, want 6", got.Restarts)
	}
	if got := w.observe(watchCrashed(), at(215.9)); got.Restarts != 6 {
		t.Errorf("a look inside the first pause of the new crash: %d restarts, want 6", got.Restarts)
	}
	if got := w.observe(watchCrashed(), at(216)); got.Restarts != 7 {
		t.Errorf("the first pause of the new crash is over: %d restarts, want 7", got.Restarts)
	}
}

// The count and the delays the watch reads are the ones setup registers.
func TestTheDelaysTheWatchReadsAreThoseTheServiceIsRegisteredWith(t *testing.T) {
	want := []time.Duration{5 * time.Second, 30 * time.Second, time.Minute}
	if len(agentServiceRestartDelays) != len(want) {
		t.Fatalf("%v", agentServiceRestartDelays)
	}
	for i := range want {
		if agentServiceRestartDelays[i] != want[i] {
			t.Errorf("delay %d is %s, want %s", i+1, agentServiceRestartDelays[i], want[i])
		}
	}
}
