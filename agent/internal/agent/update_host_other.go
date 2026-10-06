//go:build !linux && !darwin && !windows

package agent

// platformUpdateHost is the host of the running operating system. Linux, macOS and
// Windows have one (update_service_linux.go, update_service_darwin.go,
// update_service_windows.go); every other platform has no host yet, so every
// function of the step's API says that this build has no update step for it and
// UpdateEligibility reports PLATFORM_NOT_IN_RELEASE. When an operating system gets
// its step, its host replaces this answer for it.
func platformUpdateHost() updateHost { return nil }
