package agent

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
// Process identifiers are reused, so a restart that gives the new process the old
// one's identifier and happens between two looks is not seen; the trial's deadline
// ends such a trial.
type serviceWatch struct {
	pid      uint32
	restarts int
	// awaiting: a crash was counted and the manager hasn't brought the service back
	// yet, so the process that does is that crash's restart, not another.
	awaiting bool
}

// begin starts the count at the process the step just started.
func (w *serviceWatch) begin(pid uint32) {
	*w = serviceWatch{pid: pid}
}

// observe takes one look.
func (w *serviceWatch) observe(o observedService) updateServiceState {
	state := updateServiceState{PID: int(o.PID)}
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
