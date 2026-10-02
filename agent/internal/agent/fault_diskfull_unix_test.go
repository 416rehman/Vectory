//go:build !windows

package agent

import "syscall"

// errDiskFull is what a write to a full disk returns on this platform.
var errDiskFull error = syscall.ENOSPC
