//go:build darwin

package agent

// platformUpdateHost is the host of this platform: launchd runs the agent and the
// privileged step, and launchctl is how the step asks it about the agent.
// updatesInRelease (update_gate.go) decides whether this build uses it.
func platformUpdateHost() updateHost { return newMacOSUpdateHost(runLaunchctl) }
