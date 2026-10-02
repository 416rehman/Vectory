//go:build !linux && !darwin && !windows

package agent

import "context"

// collectStartup: this platform can't tell how a process was started (and
// can't list Vector processes either, so setup never asks).
func collectStartup(ctx context.Context, running RunningVector) VectorStartup {
	return VectorStartup{PID: running.PID, Service: running.Service}
}
