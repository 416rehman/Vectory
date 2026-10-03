//go:build windows

package agent

import "sync"

// windowsUpdatesInRelease is the release gate of the Windows step (update_gate.go).
// Windows ships updates only if the native proof of the step, on a real Service
// Control Manager (the windows job of .github/workflows/platforms.yml, tests/platform/
// agent-update.mjs), is green at the cut. It is closed until then: a closed gate
// makes every Windows host report PLATFORM_NOT_IN_RELEASE and makes setup refuse
// --updates there ("Hosts of this kind update by hand in this release."), and
// changes nothing else.
//
// The proof builds every agent it uses with this word changed to true in a copy of
// the source (openWindowsGate in tests/platform/update-lib.mjs), so it tests the
// step as it ships; opening the gate for the release is changing it here, in the
// commit that cites the green run.
const windowsUpdatesInRelease = false

// windowsUpdateHost is the Windows Service Control Manager, the volume and the
// registry as the step sees them. The files are in update_helper_windows.go, the
// swap in update_swap_windows.go, the services in update_service_windows.go and
// the questions of who owns the agent in update_eligibility_windows.go.
type windowsUpdateHost struct {
	// watch counts the restarts of the agent's service the step sees, which the
	// manager doesn't count itself.
	mu    sync.Mutex
	watch serviceWatch

	// stepService is the name of the step's own service when it isn't the usual one:
	// the tests of the registration use a name of their own, so that they never touch
	// the service of the host they run on. Only the package's tests set it.
	stepService string
}

func newWindowsUpdateHost() *windowsUpdateHost { return &windowsUpdateHost{} }

// stepServiceName is how the Service Control Manager knows the step's service.
func (h *windowsUpdateHost) stepServiceName() string {
	if h.stepService != "" {
		return h.stepService
	}
	return updateServiceName
}

// platformUpdateHost is the host of this platform.
func platformUpdateHost() updateHost {
	return gatedUpdateHost(windowsUpdatesInRelease, func() updateHost { return newWindowsUpdateHost() })
}
