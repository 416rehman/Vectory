//go:build linux

package agent

import (
	"os"

	"golang.org/x/sys/unix"
)

// fileFlagsOf reads the inode flags of an open file or directory (FS_IOC_GETFLAGS,
// through the handle and never through the path) and names the ones that stop the step
// (update_flags.go). A file system that has no such flags, or a handle that can't be
// asked, has none that stop it: the check is only for what can be seen, and a swap that
// meets a flag it couldn't see fails as it always did, before anything is replaced.
func fileFlagsOf(f *os.File) []fileFlag {
	if f == nil {
		return nil
	}
	conn, err := f.SyscallConn()
	if err != nil {
		return nil
	}
	var flags uint32
	var ioctlErr error
	if err := conn.Control(func(fd uintptr) {
		flags, ioctlErr = unix.IoctlGetUint32(int(fd), unix.FS_IOC_GETFLAGS)
	}); err != nil || ioctlErr != nil {
		return nil
	}
	return linuxFileFlags(flags)
}
