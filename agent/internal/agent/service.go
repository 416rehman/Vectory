package agent

import "time"

// ServiceInfo is the service manager's view of the agent service.
type ServiceInfo struct {
	Manager   string `json:"manager,omitempty"`
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
	State     string `json:"state,omitempty"`
	PID       int    `json:"pid,omitempty"`
	Enabled   bool   `json:"enabled,omitempty"`
	StateDir  string `json:"state_dir,omitempty"`
}

// ServiceRegistration says what registering the service changed.
type ServiceRegistration string

const (
	ServiceCreated   ServiceRegistration = "created"
	ServiceUpdated   ServiceRegistration = "updated"
	ServiceUnchanged ServiceRegistration = "unchanged"
)

// serviceStopLimit bounds a stop or restart, which waits for Vector's
// longest graceful drain (300 s) and the agent's margin.
const serviceStopLimit = 6 * time.Minute

// Running reports whether the service manager says the agent is running.
func (s ServiceInfo) Running() bool { return s.Installed && s.State == "running" }
