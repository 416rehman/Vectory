//go:build windows

package agent

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// The swap on Windows: two renames, one that steps the installed executable aside
// as the previous build and one that puts the staged file in its place (the
// sequence is in update_swap_tworenames.go, where it is shared with the tests that
// run it on Unix). The directory holds no executable between them; the journal
// names both files before the first, so a run that finds the gap, whether a crash
// or a power cut made it, puts the previous build back. A running image can be
// renamed but not overwritten, so neither rename replaces a file that is running;
// and a rename that meets a file another program holds (a virus scan reads what
// was written a second ago) waits and tries again, ten times over five seconds.
//
// Everything is made in the install directory, which openRootOwned checked once
// and which is held open (its directories can't be renamed or removed while it
// is), and named by its path there, which only root can change.

// windowsInstall is the install directory, and the executable in it when there is
// one, held open.
type windowsInstall struct {
	// held is the executable and the directory that holds it; when the executable
	// isn't there (the gap) it is the directory alone.
	held *rootOwned
	name string
	path string
	// retry is how a rename waits for a file another program holds. A file that is
	// open somewhere answers a rename that takes it as its source with a sharing
	// violation, and one that replaces it with "access denied"; both end when the
	// other program lets go. (The same answer, for good, is what a running image gives
	// to a rename that replaces it, which the swap never asks: the executable is
	// always the source of its rename, which a running image allows. The helper copy,
	// which is replaced while it runs, is another matter: see Replace.)
	retry moveRetry
}

// openWindowsInstall opens the executable and the directory that holds it, and
// checks every component (openRootOwned): no link, no alias, SYSTEM's, the
// Administrators' and TrustedInstaller's alone to change, with the executable a
// regular file. An executable that isn't there is the one state a swap that was
// cut short can leave: the directory is opened alone, and the not-exist error is
// returned beside it, so that the step can still settle the update there.
func openWindowsInstall(executable string) (*windowsInstall, error) {
	held, err := openRootOwned(executable, rootOwnedFile)
	if err == nil {
		return &windowsInstall{held: held, name: filepath.Base(executable), path: executable, retry: holdRetry}, nil
	}
	if !notExist(err) {
		return nil, err
	}
	directory, dirErr := openRootOwned(filepath.Dir(executable), rootOwnedDirectory)
	if dirErr != nil {
		return nil, err
	}
	return &windowsInstall{held: directory, name: filepath.Base(executable), path: executable, retry: holdRetry}, err
}

func (i *windowsInstall) Path() string  { return i.path }
func (i *windowsInstall) Name() string  { return i.name }
func (i *windowsInstall) Style() string { return updateSwapTwoRenames }
func (i *windowsInstall) Close() error  { return i.held.Close() }

func (i *windowsInstall) ReadOnly() bool {
	readOnly, err := volumeReadOnly(i.held.dirPath)
	return err == nil && readOnly
}

func (i *windowsInstall) FreeSpace() (uint64, error) {
	free, err := freeBytes(i.held.dirPath)
	if err != nil {
		return 0, fmt.Errorf("couldn't read the free space beside %s: %w", i.path, err)
	}
	return free, nil
}

// Open opens a file of the install directory for reading, judged like the path
// check judges a file.
func (i *windowsInstall) Open(name string) (io.ReadCloser, error) {
	f, err := i.held.OpenAt(name)
	if err != nil {
		return nil, err
	}
	return f, nil
}

// Digest hashes a file of the install directory. A file that isn't there is
// reported as present false.
func (i *windowsInstall) Digest(name string) (string, bool, error) {
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
// except by the renames of Swap and Restore. File names are compared without regard
// to case, because that is how the system compares them (a directory can be made
// case-sensitive, and the comparison then refuses more than it must, never less).
func (i *windowsInstall) checkSwapName(name string) error {
	if err := checkEntryName(name); err != nil {
		return err
	}
	if strings.EqualFold(name, i.name) {
		return fmt.Errorf("%q is the executable itself", name)
	}
	return nil
}

// Stage makes the staged file beside the executable: created new, so a name that
// exists is refused and a link planted at it is never followed, with an access list
// of its own (SYSTEM, the Administrators and TrustedInstaller write it, the Users and
// the agent's service read and run it), written, flushed and read back through the
// handle that wrote it.
func (i *windowsInstall) Stage(name string, src io.Reader, size int64) (string, error) {
	if err := i.checkSwapName(name); err != nil {
		return "", err
	}
	return copyIntoHeldDirectory(i.held, name, rootExecutable, src, size)
}

// the install directory as the two-rename swap sees it
func (i *windowsInstall) renames() twoRenames {
	return twoRenames{
		executable: i.name,
		rename: func(from, to string) error {
			return moveFile(i.held.entryPath(from), i.held.entryPath(to), i.retry)
		},
		present: func(name string) (bool, error) {
			_, err := os.Lstat(i.held.entryPath(name))
			if errors.Is(err, fs.ErrNotExist) {
				return false, nil
			}
			return err == nil, err
		},
	}
}

// Swap makes the staged file the executable and keeps the executable it replaces as
// previous: the executable is renamed to previous, replacing the build kept from an
// earlier update, and the staged file is renamed to the executable.
func (i *windowsInstall) Swap(staged, previous string) error {
	for _, name := range []string{staged, previous} {
		if err := i.checkSwapName(name); err != nil {
			return err
		}
	}
	if err := i.checkSwapName(previous + ".new"); err != nil {
		return err
	}
	if strings.EqualFold(staged, previous) {
		return errors.New("the staged file and the previous build can't be one name")
	}
	return readOnlyVolume(i.renames().swap(staged, previous))
}

// Restore puts the previous build back in the executable's place: the build that is
// there, if one is, steps aside, and previous is renamed to the executable.
func (i *windowsInstall) Restore(previous string) error {
	for _, name := range []string{previous, previous + ".new"} {
		if err := i.checkSwapName(name); err != nil {
			return err
		}
	}
	return i.renames().restore(previous)
}

// Remove removes a file of the directory other than the executable. A file that
// isn't there is not an error.
func (i *windowsInstall) Remove(name string) error {
	if err := i.checkSwapName(name); err != nil {
		return err
	}
	return deleteFile(i.held.entryPath(name), holdRetry)
}

var _ updateInstall = (*windowsInstall)(nil)

// OpenInstall is updateHost's OpenInstall. An executable that isn't there gives the
// install of its directory beside the not-exist error (openWindowsInstall); when
// nothing could be opened the interface is nil, never a nil pointer inside one.
func (h *windowsUpdateHost) OpenInstall(executable string) (updateInstall, error) {
	install, err := openWindowsInstall(executable)
	if install == nil {
		return nil, err
	}
	return install, err
}
