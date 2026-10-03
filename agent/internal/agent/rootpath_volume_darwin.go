//go:build darwin

package agent

import "golang.org/x/sys/unix"

// platformVolume reads the file system that holds a handle the path check holds
// (fstatfs, through the handle and never through its path), for volumeFacts.problem to
// judge. A handle whose volume can't be read is an error, and the path is refused with
// it: a check that can't read the volume doesn't take the path for clean.
func platformVolume(fd int) (volumeFacts, bool, error) {
	var st unix.Statfs_t
	if err := unix.Fstatfs(fd, &st); err != nil {
		return volumeFacts{}, false, err
	}
	return volumeFacts{flags: st.Flags, mountedOn: unix.ByteSliceToString(st.Mntonname[:])}, true, nil
}
