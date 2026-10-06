//go:build !windows

package agent

import (
	"errors"
	"syscall"
)

// isDiskFull reports a write that failed for lack of space: the device is
// full, or the account's disk quota is used up.
func isDiskFull(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT)
}
