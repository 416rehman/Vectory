//go:build !windows

package agent

import (
	"errors"
	"io/fs"

	"golang.org/x/sys/unix"
)

func tryLockUpdateFile(dir *rootOwned, name string) (func(), error) {
	path := dir.entryPath(name)
	fd := -1
	err := dir.withDir(func(dirfd int) error {
		var err error
		fd, err = openRetry(dirfd, name, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NOCTTY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0o600)
		if err != nil {
			return &fs.PathError{Op: "open", Path: path, Err: err}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := judge(fd, path, rootOwnedFile, dir.trust); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = unix.Close(fd)
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, errUpdateFileLockBusy
		}
		return nil, &fs.PathError{Op: "lock", Path: path, Err: err}
	}
	return func() {
		_ = unix.Flock(fd, unix.LOCK_UN)
		_ = unix.Close(fd)
	}, nil
}
