//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func protect(path string, dir bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (stat.Uid != uint32(os.Geteuid()) && stat.Uid != 0) {
		return errors.New("protected path owner is not trusted")
	}
	if dir {
		return os.Chmod(path, 0700)
	}
	return os.Chmod(path, 0600)
}

// Walk from an anchored root descriptor. Every component rejects symlinks,
// including a link substituted concurrently after earlier path inspection.
func openPrivateFile(path string) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("private file requires absolute path")
	}
	parts := strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/")
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for i, part := range parts {
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
		if i != len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, openErr := unix.Openat(fd, part, flags, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ok || stat.Nlink != 1 || (stat.Uid != uint32(os.Geteuid()) && stat.Uid != 0) {
		f.Close()
		return nil, errors.New("private file ownership, permissions or link count rejected")
	}
	return f, nil
}
func checkPrivateFile(path string) error {
	f, err := openPrivateFile(path)
	if err != nil {
		return err
	}
	return f.Close()
}
func rejectPlatformLink(path string) error { return nil }
func replaceFile(from, to string) error    { return os.Rename(from, to) }
func syncDir(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}

// The parent directory remains after a state purge. Locking it briefly while
// opening agent.lock prevents a second process from locking a newly-created
// agent.lock after purge has unlinked the original one.
func lockLifecycle(dir string) (func(), error) {
	parent := filepath.Dir(filepath.Clean(dir))
	if err := SafePath(parent); err != nil {
		return nil, err
	}
	f, err := os.Open(parent)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.IsDir() {
		f.Close()
		return nil, errors.New("state parent is not a directory")
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another agent lifecycle operation is running")
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }, nil
}

func purgeNeedsAgentUnlock() bool { return false }

func purgeMarkerIdentity(dir string) (string, error) { return filepath.Clean(dir), nil }

func stateDirectoryIdentity(dir string) (string, error) {
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok {
		return "", errors.New("state path is not a directory")
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}

func lockAgentFile(dir string) (func(), error) {
	p := dir + "/agent.lock"
	if e := SafePath(p); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("another agent operation is running")
	}
	return func() { unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}
