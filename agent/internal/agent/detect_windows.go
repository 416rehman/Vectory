//go:build windows

package agent

import (
	"context"
	"fmt"

	"golang.org/x/sys/windows"
)

func platformDetails(ctx context.Context) (string, string) {
	v := windows.RtlGetVersion()
	return fmt.Sprintf("Windows %d.%d (build %d)", v.MajorVersion, v.MinorVersion, v.BuildNumber), "Windows services"
}

// SystemdAvailable is false on Windows.
func SystemdAvailable() bool { return false }

// DetectRunningVector is not implemented on Windows; setup says so.
func DetectRunningVector(ctx context.Context) ([]RunningVector, bool) { return nil, false }
