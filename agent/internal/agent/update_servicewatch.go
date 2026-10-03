package agent

import "time"

// agentServiceRestartDelays are the pauses the Windows Service Control Manager makes
// before it restarts the agent's service after its process ended without a word: after
// the first end, after the second, and after every one that follows. Setup registers
// them (service_windows.go) and the watch reads a crash loop by them.
var agentServiceRestartDelays = []time.Duration{5 * time.Second, 30 * time.Second, time.Minute}

// restartsAfter is how many times the manager has restarted a service that crashed,
// elapsed after the crash: the pauses it makes, each with a second for the restarted
// process to start and end again. A restart that crashes within a look's width is never
// seen, and the pauses are what show it.
func restartsAfter(elapsed time.Duration) int {
	restarts := 0
	due := time.Duration(0)
	for restarts < 1000 {
		delay := agentServiceRestartDelays[min(restarts, len(agentServiceRestartDelays)-1)]
		due += delay + time.Second
		if elapsed < due {
			break
		}
		restarts++
	}
	return restarts
}

// observedService is what a service manager that doesn't count restarts reports
// about the agent's service at one moment: its state, the process that runs it
// and, for a service that has stopped, how it ended.
type observedService struct {
	// State is running, starting, stopping or stopped.
	State string
	// PID is the process that runs the service, 0 when there is none.
	PID uint32
	// Failed: the service stopped with an error. Crashed: its process ended without
	// telling the manager, which then restarts it by the recovery actions it was
	// given.
	Failed, Crashed bool
}

// serviceWatch turns those observations into what the step's watch reads: the
// state in the words systemd uses ("active", "activating", "failed" or "inactive")
// and how often the service restarted since the watch began. The Windows Service
// Control Manager keeps no count of restarts, so the watch counts what it sees:
// every crash it observes, and every change of process it observes that no crash
// accounts for. A process that crashed is "activating", as systemd calls a unit it
// is about to restart, and not "failed" or "inactive", which end a trial at once.
//
// A build that crashes as it starts lives for less than a look, so no look sees its
// process, and the manager keeps the service stopped between the restarts it makes
// (agentServiceRestartDelays): the crash seen first is the only one any look shows. The
// watch therefore reads the time that passes while it sees the service stopped after a
// crash, and counts the restarts the manager has made in it (restartsAfter).
//
// Process identifiers are reused, so a restart that gives the new process the old
// one's identifier and happens between two looks is not seen; the trial's deadline
// ends such a trial.
type serviceWatch struct {
	pid      uint32
	restarts int
	// awaiting: a crash was counted and the manager hasn't brought the service back
	// yet, so the process that does is that crash's restart, not another.
	awaiting bool
	// crashedAt is when the crash that awaiting stands for was first seen, and
	// inferred how many restarts since then no look has seen but the time has shown.
	crashedAt time.Time
	inferred  int
}

// begin starts the count at the process the step just started.
func (w *serviceWatch) begin(pid uint32) {
	*w = serviceWatch{pid: pid}
}

// observe takes one look, at the time now.
func (w *serviceWatch) observe(o observedService, now time.Time) updateServiceState {
	// The count is the host's own, from the start it made: the first crash is a
	// restart of the service, not a count that was there before the watch.
	state := updateServiceState{PID: int(o.PID), CountsFromStart: true}
	switch o.State {
	case "running":
		state.State = "active"
	case "starting":
		state.State = "activating"
	case "stopping":
		state.State = "deactivating"
	case "stopped":
		switch {
		case o.Crashed:
			state.State = "activating"
		case o.Failed:
			state.State = "failed"
		default:
			state.State = "inactive"
		}
	default:
		state.State = "inactive"
	}
	switch {
	case o.State == "stopped" && o.Crashed:
		if !w.awaiting {
			w.restarts++
			w.awaiting = true
			w.crashedAt, w.inferred = now, 0
		} else if seen := restartsAfter(now.Sub(w.crashedAt)); seen > w.inferred {
			w.restarts += seen - w.inferred
			w.inferred = seen
		}
	case o.State == "running" || o.State == "starting":
		if w.awaiting {
			w.awaiting = false
		} else if o.PID != 0 && w.pid != 0 && o.PID != w.pid {
			w.restarts++
		}
		if o.PID != 0 {
			w.pid = o.PID
		}
	}
	state.Restarts = w.restarts
	return state
}
