//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"

	"golang.org/x/sys/unix"
)

// The Unix primitives of the privileged step, shared by Linux and macOS. Every
// one works through a handle that was checked once (rootOwned) and never through
// a path resolved again.

// unixUpdateHost is the part of updateHost that is the same on Linux and macOS:
// the lock, the free space, reading what the service account wrote and the probe.
// A platform's host embeds it and adds its service manager.
type unixUpdateHost struct{}

// Lock takes the step's lock: an exclusive, non-blocking flock on a file of the
// private directory. The kernel drops it when the process ends, so a step that was
// killed never leaves it held.
func (unixUpdateHost) Lock(private *rootOwned) (func(), error) {
	path := private.entryPath(updateLockFile)
	fd := -1
	err := private.withDir(func(dirfd int) error {
		var err error
		fd, err = openRetry(dirfd, updateLockFile, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NOCTTY|unix.O_CLOEXEC, 0o600)
		if err != nil {
			return &fs.PathError{Op: "open", Path: path, Err: err}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// The lock file is the step's own, in a directory only root can write: judge it
	// like the rest of the path, then close the one way it could still be wrong.
	if err := judge(fd, path, rootOwnedFile, private.trust); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = unix.Close(fd)
		if err == unix.EWOULDBLOCK {
			return nil, errUpdateStepBusy
		}
		return nil, &fs.PathError{Op: "lock", Path: path, Err: err}
	}
	return func() {
		_ = unix.Flock(fd, unix.LOCK_UN)
		_ = unix.Close(fd)
	}, nil
}

// statfsOf reads the file system that holds a directory the step has open.
func statfsOf(dir *rootOwned) (unix.Statfs_t, error) {
	var st unix.Statfs_t
	err := dir.withDir(func(fd int) error { return unix.Fstatfs(fd, &st) })
	return st, err
}

// statfsFree is what an unprivileged writer could still write: the free blocks the
// file system keeps for it, in bytes.
func statfsFree(st unix.Statfs_t) uint64 { return uint64(st.Bavail) * uint64(st.Bsize) }

// statfsReadOnly reports a file system mounted read-only (ST_RDONLY on Linux,
// MNT_RDONLY on macOS: bit 0 of the flags on both).
func statfsReadOnly(st unix.Statfs_t) bool { return uint64(st.Flags)&1 != 0 }

// FreeSpace is the room left on the file system that holds dir.
func (unixUpdateHost) FreeSpace(dir *rootOwned) (uint64, error) {
	st, err := statfsOf(dir)
	if err != nil {
		return 0, fmt.Errorf("couldn't read the free space of %s: %w", dir.Path(), err)
	}
	return statfsFree(st), nil
}

// OpenServiceFile opens one file the service account wrote. The directory is
// walked from the root of the file system with O_NOFOLLOW at every component, and
// the file is opened relative to it with O_NOFOLLOW|O_NONBLOCK, so that a link at
// any depth is refused and a named pipe is opened without waiting for a writer and
// then refused for what it is. What the walk returns is judged by the handle and
// never by the path: the file must be a regular file (a named pipe, a device, a
// socket and a directory are refused), it must belong to the service account (a
// hard link to a file of root's or of any other account is refused), and its size
// must be within limit. The state directory belongs to the service account, which
// can rename and replace anything in it at any time, so nothing about the file is
// believed beyond what the open handle says now: the caller copies the bytes and
// verifies the copy.
func (unixUpdateHost) OpenServiceFile(directory, name string, account updateAccount, limit int64) (*updateServiceFile, error) {
	dir, err := walkOwned(directory, rootOwnedDirectory, ownerTrust{unjudged: true}, nil)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	f, err := dir.OpenAt(name)
	if err != nil {
		return nil, err
	}
	path := dir.entryPath(name)
	st, err := fstatFile(f)
	if err != nil {
		f.Close()
		return nil, &fs.PathError{Op: "stat", Path: path, Err: err}
	}
	switch {
	case st.Mode&unix.S_IFMT != unix.S_IFREG:
		f.Close()
		return nil, untrustedLocation(path + " isn't a regular file (it is " + kindName(uint32(st.Mode)) + ")")
	case st.Uid != account.UID || account.UID == 0:
		f.Close()
		return nil, untrustedLocation(fmt.Sprintf("%s belongs to uid %d, not to the agent's service account (uid %d)", path, st.Uid, account.UID))
	case st.Size < 0 || st.Size > limit:
		f.Close()
		return nil, fmt.Errorf("%s is %d bytes and the step reads at most %d: %w", path, st.Size, limit, errServiceFileTooLarge)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, &fs.PathError{Op: "stat", Path: path, Err: err}
	}
	return &updateServiceFile{File: f, Size: st.Size, ModTime: info.ModTime()}, nil
}

// copyIntoDirectory makes the new file name in dir, which the step holds open, and
// fills it with exactly size bytes of src. The file is created with O_EXCL and
// without following a link (CreateAt), so a name that exists is refused and one
// that someone planted is never written through; its mode is set through the
// descriptor, whatever the umask says. The bytes are written and synced, and then
// the name is opened again relative to the held directory and read back, which is
// where the digest comes from: it is the digest of what is on the file system under
// that name, and the check that the name still refers to the file that was
// written. A source with more or fewer bytes than size is refused, and a failure
// removes the new file.
func copyIntoDirectory(dir *rootOwned, name string, mode os.FileMode, src io.Reader, size int64) (string, error) {
	f, err := dir.CreateAt(name, mode)
	if err != nil {
		return "", readOnly(err)
	}
	complete := false
	defer func() {
		if !complete {
			_ = dir.UnlinkAt(name)
		}
	}()
	exact := size >= 0
	if !exact {
		size = MaxAgentBuild
	}
	written, err := io.Copy(f, io.LimitReader(src, size+1))
	switch {
	case err != nil:
	case written > size && exact:
		err = fmt.Errorf("the source has more than the %d bytes it had when it was opened", size)
	case written > size:
		err = fmt.Errorf("the source is larger than an agent build can be (%d bytes)", size)
	case written < size && exact:
		err = fmt.Errorf("the source has %d bytes, fewer than the %d it had when it was opened", written, size)
	}
	if err == nil {
		err = f.Sync()
	}
	wrote, statErr := fstatFile(f)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = statErr
	}
	if err != nil {
		return "", readOnly(err)
	}
	back, err := dir.OpenAt(name)
	if err != nil {
		return "", err
	}
	defer back.Close()
	read, err := fstatFile(back)
	if err != nil {
		return "", err
	}
	if read.Ino != wrote.Ino || read.Dev != wrote.Dev {
		return "", fmt.Errorf("%s isn't the file that was written", dir.entryPath(name))
	}
	digest, err := digestOfReader(back)
	if err != nil {
		return "", err
	}
	complete = true
	return digest, nil
}

// CopyInto is updateHost's CopyInto.
func (unixUpdateHost) CopyInto(dir *rootOwned, name string, perm rootFilePerm, src io.Reader, size int64) (string, error) {
	return copyIntoDirectory(dir, name, unixMode(perm), src, size)
}

// RemoveFrom removes one file of a held directory, and syncs the directory so that
// the removal survives a power cut.
func (unixUpdateHost) RemoveFrom(dir *rootOwned, name string) error {
	if err := dir.UnlinkAt(name); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	return dir.Sync()
}

// Replace renames from over to in a held directory and syncs the directory.
func (unixUpdateHost) Replace(dir *rootOwned, from, to string) error {
	if err := dir.RenameAt(from, to); err != nil {
		return err
	}
	return dir.Sync()
}

// EmptyDir removes everything in a held directory and leaves the directory.
func (unixUpdateHost) EmptyDir(dir *rootOwned) error { return removeTreeContents(dir) }

// CheckPrivate refuses a directory that its group or everyone can enter. The path
// check has already seen that it is root's and that nobody else can write it.
func (unixUpdateHost) CheckPrivate(private *rootOwned) error {
	st, err := private.FstatDir()
	if err != nil {
		return &fs.PathError{Op: "stat", Path: private.Path(), Err: err}
	}
	if st.Mode&0o077 != 0 {
		return untrustedLocation(fmt.Sprintf("%s isn't private to root (mode %04o)", private.Path(), uint32(st.Mode)&0o7777))
	}
	return nil
}

// removeTreeContents removes everything inside the directory dir holds open,
// without following a link and without leaving the directory: the entries are
// unlinked relative to the held descriptor, and a directory is emptied before it
// is removed. The directory itself stays.
func removeTreeContents(dir *rootOwned) error {
	return dir.withDir(func(fd int) error { return removeEntries(fd, dir.Path()) })
}

func removeEntries(dirfd int, path string) error {
	// A second descriptor for the same directory, because reading entries moves
	// the offset of the one the caller holds.
	readFd, err := unix.Openat(dirfd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return &fs.PathError{Op: "open", Path: path, Err: err}
	}
	handle := os.NewFile(uintptr(readFd), path)
	defer handle.Close()
	names, err := handle.Readdirnames(-1)
	if err != nil {
		return &fs.PathError{Op: "readdir", Path: path, Err: err}
	}
	var first error
	for _, name := range names {
		child := path + "/" + name
		err := unix.Unlinkat(dirfd, name, 0)
		if err == nil || err == unix.ENOENT {
			continue
		}
		if err == unix.EISDIR || err == unix.EPERM {
			// A directory: empty it through its own descriptor, then remove it.
			sub, openErr := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if openErr == nil {
				openErr = removeEntries(sub, child)
				_ = unix.Close(sub)
			}
			if openErr == nil {
				openErr = unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR)
			}
			if openErr == nil || openErr == unix.ENOENT {
				continue
			}
			err = openErr
		}
		if first == nil {
			first = &fs.PathError{Op: "remove", Path: child, Err: err}
		}
	}
	return first
}
