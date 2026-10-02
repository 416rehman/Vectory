//go:build !windows

package agent

import "golang.org/x/sys/unix"

// mkfifo makes a named pipe, which blocks whoever opens it for reading.
func mkfifo(path string) error { return unix.Mkfifo(path, 0600) }
