//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
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

// privateFileProblem says which check made openPrivateFile refuse path, and a
// command that fixes it.
func privateFileProblem(path string, openErr error) (problem, fix string) {
	info, err := os.Lstat(path)
	switch {
	case os.IsNotExist(err):
		return "doesn't exist", ""
	case err != nil || errors.Is(openErr, fs.ErrPermission):
		return "can't be read by this account", "Run the command with sudo."
	case info.Mode()&os.ModeSymlink != 0 || errors.Is(openErr, unix.ELOOP):
		return "is a symbolic link", "Pass the real file's path."
	case !info.Mode().IsRegular():
		return "isn't a regular file", ""
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "isn't private", ""
	}
	quoted := quoteArg(path)
	var problems, fixes []string
	if stat.Uid != uint32(os.Geteuid()) && stat.Uid != 0 {
		owner := "uid " + strconv.FormatUint(uint64(stat.Uid), 10)
		if account, err := user.LookupId(strconv.FormatUint(uint64(stat.Uid), 10)); err == nil {
			owner = account.Username
		}
		problems = append(problems, "belongs to "+owner)
		fixes = append(fixes, "chown root "+quoted)
	}
	if perm := info.Mode().Perm(); perm&0077 != 0 {
		problems = append(problems, fmt.Sprintf("is readable by other accounts (mode %04o)", perm))
		fixes = append(fixes, "chmod 600 "+quoted)
	}
	switch {
	case stat.Nlink != 1:
		return strings.Join(append(problems, fmt.Sprintf("has %d hard links", stat.Nlink)), " and "), "Save the token in a new file, then chmod 600 it."
	case len(problems) == 0:
		return "isn't private", ""
	case stat.Uid != uint32(os.Geteuid()) && stat.Uid != 0 && os.Geteuid() != 0:
		return strings.Join(problems, " and "), "Use a file you own, with chmod 600."
	}
	return strings.Join(problems, " and "), "Fix it: " + strings.Join(fixes, " && ")
}

// keepOwner gives the temporary file that is about to replace path the owner
// and group of the file it replaces, when this process is root. Files the
// service account owns then stay the service account's when root replaces
// them (a foreground run, pause or retry as root), instead of turning into
// files the service can no longer read. Only the owner and group carry over:
// the replacement stays private (0600), whatever the old file allowed. An
// owner other than the one the directory itself belongs to is never kept.
// Failing to keep an owner leaves root's ownership, which is safe.
func keepOwner(tmp, path string) {
	if os.Geteuid() != 0 {
		return
	}
	old, err := os.Lstat(path)
	if err != nil || !old.Mode().IsRegular() {
		return
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return
	}
	oldStat, oldOK := old.Sys().(*syscall.Stat_t)
	parentStat, parentOK := parent.Sys().(*syscall.Stat_t)
	if !oldOK || !parentOK || oldStat.Uid != parentStat.Uid {
		return
	}
	_ = os.Lchown(tmp, int(oldStat.Uid), int(oldStat.Gid))
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
		return nil, lockHeld(dir)
	}
	recordLockOwner(f)
	return func() { clearLockOwner(f); unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}
