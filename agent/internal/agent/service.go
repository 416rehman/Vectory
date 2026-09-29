package agent

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

// Running reports whether the service manager says the agent is running.
func (s ServiceInfo) Running() bool { return s.Installed && s.State == "running" }
