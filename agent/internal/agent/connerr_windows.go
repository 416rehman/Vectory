//go:build windows

package agent

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

func errRefused(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED) || errors.Is(err, syscall.ECONNREFUSED)
}
func errReset(err error) bool {
	return errors.Is(err, windows.WSAECONNRESET) || errors.Is(err, windows.WSAECONNABORTED) || errors.Is(err, syscall.ECONNRESET)
}
func errUnreachable(err error) bool {
	return errors.Is(err, windows.WSAEHOSTUNREACH) || errors.Is(err, windows.WSAENETUNREACH)
}
