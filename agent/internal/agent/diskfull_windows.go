//go:build windows

package agent

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// isDiskFull reports a write that failed for lack of space: the volume is
// full, or the account's disk quota is used up.
func isDiskFull(err error) bool {
	return errors.Is(err, windows.ERROR_DISK_FULL) || errors.Is(err, windows.ERROR_HANDLE_DISK_FULL) ||
		errors.Is(err, windows.ERROR_DISK_QUOTA_EXCEEDED) || errors.Is(err, syscall.ENOSPC)
}
