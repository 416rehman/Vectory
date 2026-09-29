//go:build !linux && !darwin && !windows

package agent

import "context"

func platformDetails(ctx context.Context) (string, string) { return "", "" }

// SystemdAvailable is false on platforms without a native adapter.
func SystemdAvailable() bool { return false }

// DetectRunningVector is not implemented on this platform; setup says so.
func DetectRunningVector(ctx context.Context) ([]RunningVector, bool) { return nil, false }
