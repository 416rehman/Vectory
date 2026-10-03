//go:build windows

package agent

import "sync"

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

// platformUpdateHost is the host of this platform. Whether this build ships it is the
// gate's to say (update_gate.go): currentUpdateHost asks it first.
func platformUpdateHost() updateHost { return newWindowsUpdateHost() }
