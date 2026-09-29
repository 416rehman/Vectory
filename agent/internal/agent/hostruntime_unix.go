//go:build !windows

package agent

import "golang.org/x/sys/unix"

// directoryWritable reports whether this process may create files in path.
func directoryWritable(path string) bool {
	return SafePath(path) == nil && unix.Access(path, unix.W_OK|unix.X_OK) == nil
}
