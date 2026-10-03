//go:build !windows

package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// ownerTrust says whose ownership passes the path check. The zero value is what
// ships: root, and nobody else.
type ownerTrust struct {
	// uid is one more account whose ownership passes. A test that can't build a
	// tree owned by root sets it to its own.
	uid    uint32
	hasUID bool
	// anchor is a directory that the check starts below: it and every directory
	// above it are opened without following links, and are not judged. A test
	// that builds its tree under a temporary directory sets it to that directory.
	anchor string
	// unjudged says no component is judged: the walk still refuses links and
	// the wrong kind of file. openPlainFile uses it.
	unjudged bool
}

// rootOwnedTrust is what openRootOwned checks against. It is the one seam of the
// path check: tests that need a tree they own assign it, and nothing else does,
// so the binary that ships always trusts root alone (see
// TestProductionAgentContainsNoTestHooks).
var rootOwnedTrust ownerTrust

func (t ownerTrust) owns(uid uint32) bool { return uid == 0 || (t.hasUID && uid == t.uid) }

// judged reports whether the directory at path is checked for its owner and its
// permissions.
func (t ownerTrust) judged(path string) bool {
	switch {
	case t.unjudged:
		return false
	case t.anchor == "":
		return true
	}
	return !(path == "/" || path == t.anchor || strings.HasPrefix(t.anchor, path+"/"))
}

// pathFacts is what the check reads from a handle.
type pathFacts struct {
	mode uint32 // st_mode: the kind of file and the permission bits
	uid  uint32 // st_uid
}

func kindName(mode uint32) string {
	switch mode & unix.S_IFMT {
	case unix.S_IFDIR:
		return "a directory"
	case unix.S_IFREG:
		return "a regular file"
	case unix.S_IFLNK:
		return "a symbolic link"
	case unix.S_IFIFO:
		return "a named pipe"
	case unix.S_IFSOCK:
		return "a socket"
	case unix.S_IFCHR:
		return "a character device"
	case unix.S_IFBLK:
		return "a block device"
	}
	return "an unknown kind of file"
}

// typeProblem says why a handle is not what the path needs at that place, or "".
func typeProblem(mode uint32, want rootOwnedKind) string {
	kind := mode & unix.S_IFMT
	switch {
	case kind == unix.S_IFLNK:
		return "is a symbolic link"
	case want == rootOwnedDirectory && kind != unix.S_IFDIR:
		return "isn't a directory (it is " + kindName(mode) + ")"
	case want == rootOwnedFile && kind != unix.S_IFREG:
		return "isn't a regular file (it is " + kindName(mode) + ")"
	}
	return ""
}

// ownerProblem says why a handle is not root's alone, or "": it belongs to
// another account, or its group or everyone can write it.
func (t ownerTrust) ownerProblem(f pathFacts) string {
	if !t.owns(f.uid) {
		return fmt.Sprintf("belongs to uid %d, not to root", f.uid)
	}
	switch f.mode & 0o022 {
	case 0o020:
		return fmt.Sprintf("is writable by its group (mode %04o)", f.mode&0o7777)
	case 0o002:
		return fmt.Sprintf("is writable by everyone (mode %04o)", f.mode&0o7777)
	case 0o022:
		return fmt.Sprintf("is writable by its group and by everyone (mode %04o)", f.mode&0o7777)
	}
	return ""
}

// judge reads a handle and refuses it, with UNTRUSTED_LOCATION, unless it is the
// kind of file the path needs there and root's alone. path is for the message.
func judge(fd int, path string, want rootOwnedKind, trust ownerTrust) error {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return &fs.PathError{Op: "stat", Path: path, Err: err}
	}
	facts := pathFacts{mode: uint32(st.Mode), uid: st.Uid}
	if problem := typeProblem(facts.mode, want); problem != "" {
		return untrustedLocation(path + " " + problem)
	}
	if trust.judged(path) {
		if problem := trust.ownerProblem(facts); problem != "" {
			return untrustedLocation(path + " " + problem)
		}
	}
	return nil
}

func openRetry(dirfd int, name string, flags int, perm uint32) (int, error) {
	for {
		fd, err := unix.Openat(dirfd, name, flags, perm)
		if err != unix.EINTR {
			return fd, err
		}
	}
}

// classifyOpenFailure turns a failed open into a refusal when the failure says
// the component is the wrong thing (a link, or not a directory), and otherwise
// into the error the system gave, which says "missing" or "no access". It asks
// the held directory what the component is, never the path again.
func classifyOpenFailure(dirfd int, name, path string, want rootOwnedKind, err error) error {
	switch err {
	case unix.ELOOP, unix.ENOTDIR, unix.ENXIO, unix.EMLINK:
		var st unix.Stat_t
		if unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW) == nil {
			if problem := typeProblem(uint32(st.Mode), want); problem != "" {
				return untrustedLocation(path + " " + problem)
			}
		}
	}
	return &fs.PathError{Op: "open", Path: path, Err: err}
}

func openFlags(want rootOwnedKind) int {
	flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	if want == rootOwnedDirectory {
		return flags | unix.O_DIRECTORY
	}
	// A file is opened without waiting for a writer: a named pipe would block
	// an open without O_NONBLOCK until someone wrote to it. It is refused after
	// the open, when its kind is read from the handle.
	return flags | unix.O_NONBLOCK | unix.O_NOCTTY
}

// openComponent opens one component of the path relative to the directory
// already held. With a nonzero makeMode, a missing directory is made and set to
// that mode through its own descriptor, so that a umask never narrows a
// directory the agent must read.
func openComponent(dirfd int, name, path string, want rootOwnedKind, makeMode os.FileMode) (int, error) {
	flags := openFlags(want)
	fd, err := openRetry(dirfd, name, flags, 0)
	created := false
	if err == unix.ENOENT && makeMode != 0 && want == rootOwnedDirectory {
		switch mkErr := unix.Mkdirat(dirfd, name, uint32(makeMode)); mkErr {
		case nil:
			created = true
		case unix.EEXIST:
		default:
			return -1, &fs.PathError{Op: "mkdir", Path: path, Err: mkErr}
		}
		fd, err = openRetry(dirfd, name, flags, 0)
	}
	if err != nil {
		return -1, classifyOpenFailure(dirfd, name, path, want, err)
	}
	if created {
		if err := unix.Fchmod(fd, uint32(makeMode)); err != nil {
			_ = unix.Close(fd)
			return -1, &fs.PathError{Op: "chmod", Path: path, Err: err}
		}
	}
	return fd, nil
}

func checkAbsolutePath(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return fmt.Errorf("%q isn't an absolute path with no . or .. or doubled separators", path)
	}
	return nil
}

// walkOwned opens path from the root of the file system. Every component is
// opened relative to the one before it with O_NOFOLLOW (a directory with
// O_DIRECTORY, the file without waiting for a writer), and judged from its own
// handle: root's, and not writable by its group or by everyone. The previous
// handle is closed once the next is open, except that the directory holding the
// file stays open beside it. With a createSpec, missing directories are made.
func walkOwned(path string, kind rootOwnedKind, trust ownerTrust, create *createSpec) (*rootOwned, error) {
	if err := checkAbsolutePath(path); err != nil {
		return nil, err
	}
	var names []string
	if path != "/" {
		names = strings.Split(path[1:], "/")
	}
	if kind == rootOwnedFile && len(names) == 0 {
		return nil, fmt.Errorf("%q isn't a file", path)
	}
	dirfd, err := openRetry(unix.AT_FDCWD, "/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: "/", Err: err}
	}
	if err := judge(dirfd, "/", rootOwnedDirectory, trust); err != nil {
		_ = unix.Close(dirfd)
		return nil, err
	}
	current := "/"
	for i, name := range names {
		next := current + name
		if current != "/" {
			next = current + "/" + name
		}
		want := rootOwnedDirectory
		last := i == len(names)-1
		if last && kind == rootOwnedFile {
			want = rootOwnedFile
		}
		var makeMode os.FileMode
		if create != nil {
			makeMode = create.mode(last)
		}
		child, err := openComponent(dirfd, name, next, want, makeMode)
		if err == nil {
			err = judge(child, next, want, trust)
			if err != nil {
				_ = unix.Close(child)
			}
		}
		if err != nil {
			_ = unix.Close(dirfd)
			return nil, err
		}
		if want == rootOwnedFile {
			return &rootOwned{
				dir:     os.NewFile(uintptr(dirfd), current),
				file:    os.NewFile(uintptr(child), next),
				path:    path,
				dirPath: current,
				trust:   trust,
			}, nil
		}
		_ = unix.Close(dirfd)
		dirfd, current = child, next
	}
	return &rootOwned{dir: os.NewFile(uintptr(dirfd), current), path: path, dirPath: current, trust: trust}, nil
}

// rootOwned is a path that was checked and is held open. Its directory is the
// path's last component, or the directory that holds the file; the file is the
// last component when the path names one. Everything the swap and the readers
// do goes through these handles (the *At methods are relative to the directory,
// and refuse a link), so a component renamed or replaced after the check changes
// nothing: the handles still refer to what was checked.
type rootOwned struct {
	dir     *os.File
	file    *os.File
	path    string // as asked, for messages
	dirPath string // where the directory was found, for messages
	trust   ownerTrust
}

// openRootOwned opens path and checks every component of it: each directory
// from the root of the file system down must belong to root and be writable by
// root alone, and a file must be a regular file with the same two properties. A
// path that fails is refused with UNTRUSTED_LOCATION and a detail that names the
// component and says why; a component that is missing is the system's own
// not-exist error, so a caller can tell the two apart.
func openRootOwned(path string, kind rootOwnedKind) (*rootOwned, error) {
	return walkOwned(path, kind, rootOwnedTrust, nil)
}

// mode is the mode of a made directory: the one at the end of the path has the
// access leaf names (0700 for rootPrivate, otherwise 0755), and the ones above
// it are 0755, so that whoever must reach the end of the path can.
func (c createSpec) mode(last bool) os.FileMode {
	if last && c.leaf == rootPrivate {
		return 0o700
	}
	return 0o755
}

// ensureRootOwnedDir is openRootOwned for a directory, which it makes with any
// missing directory above it: the last with the access leaf names, the others
// readable by everyone. A directory that exists is judged, never changed.
func ensureRootOwnedDir(path string, leaf rootFilePerm) (*rootOwned, error) {
	return walkOwned(path, rootOwnedDirectory, rootOwnedTrust, &createSpec{leaf: leaf})
}

// openPlainFile opens a regular file without following a link in any component
// of its path, and without waiting for a writer. It judges nothing else: the
// file may belong to anyone, which a caller reads from the handle. The privileged
// step reads what the service account wrote this way, and copies it before it
// believes any of it.
func openPlainFile(path string) (*os.File, error) {
	r, err := walkOwned(path, rootOwnedFile, ownerTrust{unjudged: true}, nil)
	if err != nil {
		return nil, err
	}
	_ = r.dir.Close()
	return r.file, nil
}

// canWriteRootOwned reports whether this process may write what openRootOwned
// trusts: it is root.
func canWriteRootOwned() bool { return rootOwnedTrust.owns(uint32(os.Geteuid())) }

// Path is the path as it was asked for.
func (r *rootOwned) Path() string { return r.path }

// File is the held file, or nil when the path named a directory.
func (r *rootOwned) File() *os.File { return r.file }

// Close releases the handles.
func (r *rootOwned) Close() error {
	var first error
	for _, f := range []**os.File{&r.file, &r.dir} {
		if *f != nil {
			if err := (*f).Close(); err != nil && first == nil {
				first = err
			}
			*f = nil
		}
	}
	return first
}

// ReadFile reads the held file from its start, at most limit bytes: a longer
// file is refused. It can be called again.
func (r *rootOwned) ReadFile(limit int64) ([]byte, error) {
	if r.file == nil {
		return nil, fmt.Errorf("%s isn't a file", r.path)
	}
	data, err := readBounded(io.NewSectionReader(r.file, 0, math.MaxInt64), limit)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", r.path, err)
	}
	return data, nil
}

func (r *rootOwned) entryPath(name string) string {
	if r.dirPath == "/" {
		return "/" + name
	}
	return r.dirPath + "/" + name
}

// checkEntryName accepts one name in the directory: nothing that could reach
// another directory.
func checkEntryName(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > 255 || strings.ContainsAny(name, "/\x00") {
		return fmt.Errorf("%q isn't a name in a directory", name)
	}
	return nil
}

// withDir runs op with the held directory's descriptor, which stays open for
// the whole call.
func (r *rootOwned) withDir(op func(dirfd int) error) error {
	if r == nil || r.dir == nil {
		return os.ErrClosed
	}
	conn, err := r.dir.SyscallConn()
	if err != nil {
		return err
	}
	var opErr error
	if err := conn.Control(func(fd uintptr) { opErr = op(int(fd)) }); err != nil {
		return err
	}
	return opErr
}

// OpenAt opens a regular file of the held directory for reading, without
// following a link, and judges it as the path check does: root's, and not
// writable by its group or by everyone.
func (r *rootOwned) OpenAt(name string) (*os.File, error) {
	if err := checkEntryName(name); err != nil {
		return nil, err
	}
	path := r.entryPath(name)
	fd := -1
	err := r.withDir(func(dirfd int) error {
		var err error
		if fd, err = openRetry(dirfd, name, openFlags(rootOwnedFile), 0); err != nil {
			return classifyOpenFailure(dirfd, name, path, rootOwnedFile, err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := judge(fd, path, rootOwnedFile, r.trust); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

// ReadFileAt reads a file of the held directory as OpenAt opens it, at most
// limit bytes.
func (r *rootOwned) ReadFileAt(name string, limit int64) ([]byte, error) {
	f, err := r.OpenAt(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := readBounded(f, limit)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", r.entryPath(name), err)
	}
	return data, nil
}

// CreateAt makes a new file in the held directory and opens it for writing. It
// never reuses a name and never follows a link planted at it (O_EXCL), and sets
// the permission bits of mode through the descriptor, whatever the umask says.
func (r *rootOwned) CreateAt(name string, mode os.FileMode) (*os.File, error) {
	if err := checkEntryName(name); err != nil {
		return nil, err
	}
	path := r.entryPath(name)
	perm := uint32(mode.Perm())
	fd := -1
	err := r.withDir(func(dirfd int) error {
		var err error
		fd, err = openRetry(dirfd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_NOCTTY|unix.O_CLOEXEC, perm)
		if err != nil {
			return &fs.PathError{Op: "create", Path: path, Err: err}
		}
		if err = unix.Fchmod(fd, perm); err != nil {
			_ = unix.Close(fd)
			fd = -1
			_ = unix.Unlinkat(dirfd, name, 0)
			return &fs.PathError{Op: "chmod", Path: path, Err: err}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

// LinkAt makes newName another name of the file oldName, in the held directory.
func (r *rootOwned) LinkAt(oldName, newName string) error {
	for _, name := range []string{oldName, newName} {
		if err := checkEntryName(name); err != nil {
			return err
		}
	}
	return r.withDir(func(dirfd int) error {
		if err := unix.Linkat(dirfd, oldName, dirfd, newName, 0); err != nil {
			return &os.LinkError{Op: "link", Old: r.entryPath(oldName), New: r.entryPath(newName), Err: err}
		}
		return nil
	})
}

// RenameAt renames a name of the held directory, replacing newName if it
// exists, as one atomic step.
func (r *rootOwned) RenameAt(oldName, newName string) error {
	for _, name := range []string{oldName, newName} {
		if err := checkEntryName(name); err != nil {
			return err
		}
	}
	return r.withDir(func(dirfd int) error {
		if err := unix.Renameat(dirfd, oldName, dirfd, newName); err != nil {
			return &os.LinkError{Op: "rename", Old: r.entryPath(oldName), New: r.entryPath(newName), Err: err}
		}
		return nil
	})
}

// UnlinkAt removes a name of the held directory that is not a directory.
func (r *rootOwned) UnlinkAt(name string) error {
	if err := checkEntryName(name); err != nil {
		return err
	}
	return r.withDir(func(dirfd int) error {
		if err := unix.Unlinkat(dirfd, name, 0); err != nil {
			return &fs.PathError{Op: "remove", Path: r.entryPath(name), Err: err}
		}
		return nil
	})
}

// Sync flushes the held directory, so that a rename in it survives a power cut.
func (r *rootOwned) Sync() error {
	if r.dir == nil {
		return os.ErrClosed
	}
	return r.dir.Sync()
}

// Fstat reads the held file, or the directory when the path named one.
func (r *rootOwned) Fstat() (unix.Stat_t, error) {
	held := r.file
	if held == nil {
		held = r.dir
	}
	return fstatFile(held)
}

// FstatDir reads the held directory.
func (r *rootOwned) FstatDir() (unix.Stat_t, error) { return fstatFile(r.dir) }

func fstatFile(f *os.File) (unix.Stat_t, error) {
	var st unix.Stat_t
	if f == nil {
		return st, os.ErrClosed
	}
	conn, err := f.SyscallConn()
	if err != nil {
		return st, err
	}
	var statErr error
	if err := conn.Control(func(fd uintptr) { statErr = unix.Fstat(int(fd), &st) }); err != nil {
		return st, err
	}
	return st, statErr
}

func unixMode(perm rootFilePerm) os.FileMode {
	switch perm {
	case rootPrivate:
		return 0o600
	case rootExecutable:
		return 0o755
	}
	return 0o644
}

// WriteFile replaces name in the held directory with data, so that a crash
// leaves the old file or the new one and never part of either: the bytes are
// written and synced to a new file beside it, which is then renamed over it,
// and the directory is synced. The new file has the permission bits perm names,
// whatever the umask says.
func (r *rootOwned) WriteFile(name string, data []byte, perm rootFilePerm) error {
	if err := checkEntryName(name); err != nil {
		return err
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmp := "." + name + ".tmp-" + hex.EncodeToString(suffix[:])
	if len(tmp) > 255 {
		return fmt.Errorf("%q is too long a name to replace", name)
	}
	f, err := r.CreateAt(tmp, unixMode(perm))
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = r.RenameAt(tmp, name)
	}
	if err != nil {
		if removeErr := r.UnlinkAt(tmp); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
			return fmt.Errorf("%w (and %v)", err, removeErr)
		}
		return err
	}
	return r.Sync()
}
