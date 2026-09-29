//go:build !windows

package agent

import (
	"errors"
	"syscall"
)

func errRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }
func errReset(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE)
}
func errUnreachable(err error) bool {
	return errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH)
}
