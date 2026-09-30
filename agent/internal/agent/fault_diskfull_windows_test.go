//go:build windows

package agent

import "golang.org/x/sys/windows"

// errDiskFull is what a write to a full disk returns on this platform.
var errDiskFull error = windows.ERROR_DISK_FULL
