//go:build !darwin && !windows

package agent

import "time"

// currentBootSession and currentUptime are what the update step's macOS host asks of the
// system to tell one boot of the Mac from another, and how long it has been awake. This
// build isn't for a Mac, where that host is never run (it is built on every Unix system so
// that its text and its logic are tested everywhere), so the system says neither, and the
// record of a job told to leave is judged by its age on the wall clock alone.
func currentBootSession() string { return "" }

func currentUptime() (time.Duration, bool) { return 0, false }
