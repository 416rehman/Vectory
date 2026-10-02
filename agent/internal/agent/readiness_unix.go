//go:build !windows

package agent

import "golang.org/x/sys/unix"

// directoryAcceptsFiles reports whether this process may create entries in the
// directory, asking the system and creating nothing.
func directoryAcceptsFiles(path string) bool {
	return unix.Access(path, unix.W_OK|unix.X_OK) == nil
}
