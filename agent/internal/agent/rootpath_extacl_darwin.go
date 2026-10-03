//go:build darwin

package agent

import (
	"errors"

	"golang.org/x/sys/unix"
)

// accessListProblem reads the extended access list of a handle the path check
// holds, and says why it lets an account other than root change what the handle
// names, or "" (see rootpath_extacl.go). It reads the handle, never its path: the
// list that is judged is the list of the object that is held.
//
// A file system that keeps no access lists (a network share, a FAT volume) says
// ENOTSUP, and there is nothing to read there. Every other failure is an error,
// and the path is refused with it: a check that can't read a list doesn't take the
// path for clean.
func accessListProblem(fd int, directory bool) (string, error) {
	acl, err := darwinACLOfDescriptor(fd)
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return extendedACLProblem(acl, directory)
}
