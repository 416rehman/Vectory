//go:build windows

package agent

// windowsUpdatesInRelease is the release gate of the Windows step (update_gate.go).
// It is open only while the native proof of the step, on a real Service Control
// Manager, is green; closing it makes every Windows host report
// PLATFORM_NOT_IN_RELEASE and makes setup refuse --updates there, and changes
// nothing else.
const windowsUpdatesInRelease = false

// platformUpdateHost is the host of this platform.
func platformUpdateHost() updateHost {
	return gatedUpdateHost(windowsUpdatesInRelease, func() updateHost { return nil })
}
