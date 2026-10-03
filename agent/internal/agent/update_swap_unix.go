//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// The swap, on Linux and macOS: one rename over the executable, with the build it
// replaces kept beside it under a second name. Everything is relative to the
// install directory's descriptor, which openRootOwned checked once and the step
// holds open: no component of the path is resolved again, so nothing that renames
// or replaces a directory on the way can redirect a link or a rename to
// somewhere else. The install directory belongs to root and is closed to everyone
// else (the check refuses anything else), so no one can race a name inside it
// either; the handle discipline is what makes that claim hold up when a check is
// wrong about a component.
//
// The directory always holds a complete executable. A rename replaces a name in
// one step, and the previous build is kept as a second name of the very file the
// executable was (a hard link), so going back is one rename that needs no room.

// unixInstall is the install directory and the executable in it, held open.
type unixInstall struct {
	held *rootOwned
	name string
	path string
}

// openUnixInstall opens executable and the directory that holds it, and checks
// every component from the root of the file system (openRootOwned): each directory
// is root's and closed to its group and everyone, and the file is a regular file
// with the same two properties.
func openUnixInstall(executable string) (*unixInstall, error) {
	held, err := openRootOwned(executable, rootOwnedFile)
	if err != nil {
		return nil, err
	}
	return &unixInstall{held: held, name: filepath.Base(executable), path: executable}, nil
}

func (i *unixInstall) Path() string  { return i.path }
func (i *unixInstall) Name() string  { return i.name }
func (i *unixInstall) Style() string { return updateSwapRename }

func (i *unixInstall) ReadOnly() bool {
	st, err := statfsOf(i.held)
	return err == nil && statfsReadOnly(st)
}

// Immutable looks at the flags of the executable and of the directory that holds it,
// through the handles (update_flags.go): a flag that forbids replacing the executable,
// or adding and removing files beside it, is found before the service stops.
func (i *unixInstall) Immutable() string {
	var found []string
	if words := immutableWords(i.path, "replace it", fileFlagsOf(i.held.file)); words != "" {
		found = append(found, words)
	}
	if words := immutableWords(filepath.Dir(i.path), "add or remove files in it", fileFlagsOf(i.held.dir)); words != "" {
		found = append(found, words)
	}
	return strings.Join(found, " ")
}

func (i *unixInstall) FreeSpace() (uint64, error) {
	st, err := statfsOf(i.held)
	if err != nil {
		return 0, fmt.Errorf("couldn't read the free space beside %s: %w", i.path, err)
	}
	return statfsFree(st), nil
}

func (i *unixInstall) Close() error { return i.held.Close() }

// Open opens a file of the install directory for reading, judged like the path
// check judges a file: root's, and closed to its group and everyone.
func (i *unixInstall) Open(name string) (io.ReadCloser, error) {
	f, err := i.held.OpenAt(name)
	if err != nil {
		return nil, err
	}
	return f, nil
}

// Digest hashes a file of the install directory through the held handle.
func (i *unixInstall) Digest(name string) (string, bool, error) {
	f, err := i.held.OpenAt(name)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	digest, err := digestOfReader(f)
	return digest, err == nil, err
}

// checkSwapName refuses a name that is the executable itself, or that isn't a name
// in the directory: the step never creates, replaces or removes the executable
// except by the one rename of Swap and Restore.
func (i *unixInstall) checkSwapName(name string) error {
	if err := checkEntryName(name); err != nil {
		return err
	}
	if name == i.name {
		return fmt.Errorf("%q is the executable itself", name)
	}
	return nil
}

// Stage makes the staged file beside the executable (copyIntoDirectory: created
// new, so a name that exists is refused and a link planted at it is never
// followed; mode 0755 whatever the umask says; written, synced and read back
// through the directory handle, so that the digest returned is the digest of what
// is on the file system under that name and not of what this process meant to
// write).
func (i *unixInstall) Stage(name string, src io.Reader, size int64) (string, error) {
	if err := i.checkSwapName(name); err != nil {
		return "", err
	}
	return copyIntoDirectory(i.held, name, 0o755, src, size)
}

// Swap makes the staged file the executable and keeps the executable it replaces
// as previous. Each step is one system call on the held directory, and the
// directory holds a complete executable between any two of them:
//
//	linkat   executable -> previous.new     a second name of the executable
//	renameat previous.new -> previous       replaces the previous build kept before
//	renameat staged -> executable           the swap; the old build keeps its name
//	fsync    the directory                  the renames survive a power cut
//
// A crash before the second rename leaves the old build installed; a crash after
// it leaves the new one. previous is a name of the very file the executable was,
// so it needs no copy and no room.
func (i *unixInstall) Swap(staged, previous string) error {
	for _, name := range []string{staged, previous} {
		if err := i.checkSwapName(name); err != nil {
			return err
		}
	}
	if staged == previous {
		return errors.New("the staged file and the previous build can't be one name")
	}
	fresh := previous + ".new"
	if err := i.held.UnlinkAt(fresh); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := i.held.LinkAt(i.name, fresh); err != nil {
		return readOnly(err)
	}
	faultPoint("swap:linked")
	if err := i.held.RenameAt(fresh, previous); err != nil {
		return err
	}
	faultPoint("swap:previous_kept")
	if err := i.held.RenameAt(staged, i.name); err != nil {
		return err
	}
	faultPoint("swap:renamed")
	if err := i.held.Sync(); err != nil {
		return err
	}
	faultPoint("swap:synced")
	return nil
}

// Restore puts the previous build back in the executable's place with one rename,
// and syncs the directory.
func (i *unixInstall) Restore(previous string) error {
	if err := i.checkSwapName(previous); err != nil {
		return err
	}
	if err := i.held.RenameAt(previous, i.name); err != nil {
		return err
	}
	faultPoint("restore:renamed")
	return i.held.Sync()
}

// Remove removes a file of the directory other than the executable.
func (i *unixInstall) Remove(name string) error {
	if err := i.checkSwapName(name); err != nil {
		return err
	}
	if err := i.held.UnlinkAt(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

var _ updateInstall = (*unixInstall)(nil)

// OpenInstall is updateHost's OpenInstall for the platforms that share these
// primitives.
func (unixUpdateHost) OpenInstall(executable string) (updateInstall, error) {
	install, err := openUnixInstall(executable)
	if err != nil {
		return nil, err
	}
	return install, nil
}

// readOnly marks an error that says the file system is mounted read-only, so that
// the step (which is the same on every platform) can tell READ_ONLY from any other
// failure to write beside the executable.
func readOnly(err error) error {
	if errors.Is(err, unix.EROFS) && !errors.Is(err, errUpdateReadOnly) {
		return fmt.Errorf("%w: %v", errUpdateReadOnly, err)
	}
	return err
}
