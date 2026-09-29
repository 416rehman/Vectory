//go:build !windows

package agent

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

// Elevated reports whether this process can install system files and services.
func Elevated() bool { return os.Geteuid() == 0 }

// writableLocation reports whether path exists writable or could be created
// under its nearest existing ancestor.
func writableLocation(path string) bool {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		if _, err := os.Stat(p); err == nil {
			return unix.Access(p, unix.W_OK) == nil
		}
		if filepath.Dir(p) == p {
			return false
		}
	}
}

const elevationHint = "Run it with sudo: setup installs the agent and registers a system service. The service itself runs as an unprivileged account."

func binaryMode() os.FileMode { return 0755 }

// ownerSuffix names a file's owner for doctor output.
func ownerSuffix(info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	id := strconv.FormatUint(uint64(stat.Uid), 10)
	if account, err := user.LookupId(id); err == nil {
		return ", owner " + account.Username
	}
	return ", owner uid " + id
}
