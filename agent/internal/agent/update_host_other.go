//go:build !linux && !windows

package agent

// platformUpdateHost is the host of the running operating system. The privileged
// step is built for Linux and Windows; macOS has no host yet, so every function of
// the step's API says that this build has no update step for the platform and
// UpdateEligibility reports PLATFORM_NOT_IN_RELEASE. When an operating system gets
// its step, its host replaces this answer for it.
func platformUpdateHost() updateHost { return nil }
