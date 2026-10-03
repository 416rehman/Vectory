//go:build windows

package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// The Windows primitives of the privileged step: the lock, the copy, the removal,
// the replacement, the reading of what the service account wrote, and the room left
// on a volume. Every one works on a directory the step holds open (rootOwned) and
// names its entries by path, which nothing but root can change there (see
// rootpath_windows.go); where Unix would unlink or rename through a descriptor, a
// Windows file that another program holds open for a moment (a virus scanner reads
// what was written a second ago) is waited for instead.

// moveRetry says how long a rename or a removal waits for another program's hold
// on a file to end, and whether "access denied" is such a hold: it is for a
// file that was just removed and is still open somewhere (the removal is pending)
// and for one that is open somewhere and is to be replaced, and it is not for the
// executable of a running process that is to be replaced, which can be renamed but
// never replaced: only a rename that never replaces a running image waits for it.
type moveRetry struct {
	attempts     int
	wait         time.Duration
	accessDenied bool
}

// The step waits ten times half a second for a file another program holds.
var (
	holdRetry  = moveRetry{attempts: 10, wait: 500 * time.Millisecond, accessDenied: true}
	patientTry = moveRetry{attempts: 10, wait: 500 * time.Millisecond}
)

func (r moveRetry) retries(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || r.accessDenied && errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

// moveFile renames from over to, replacing to when it is there, and returns when
// the move is on disk (MOVEFILE_WRITE_THROUGH). The move is repeated while another
// program holds either file.
func moveFile(from, to string, retry moveRetry) error {
	f, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	t, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	for attempt := 1; ; attempt++ {
		err = windows.MoveFileEx(f, t, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil {
			return nil
		}
		if attempt >= retry.attempts || !retry.retries(err) {
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
		}
		time.Sleep(retry.wait)
	}
}

// deleteFile removes a file; one that isn't there is not an error. A file that
// another program holds is waited for.
func deleteFile(path string, retry moveRetry) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	for attempt := 1; ; attempt++ {
		err = windows.DeleteFile(p)
		if err == nil || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return nil
		}
		if attempt >= retry.attempts || !retry.retries(err) {
			return &fs.PathError{Op: "remove", Path: path, Err: err}
		}
		time.Sleep(retry.wait)
	}
}

// createExclusively makes a new file called path, for writing and reading back,
// with the access list perm names and nothing inherited. A name that exists is
// refused, a link planted there is never followed, and the file is shared with
// readers only, so that nothing else writes or replaces it while it is open. A
// name that was removed a moment ago and is still open in a scanner is waited for:
// its removal is pending, which the system reports as "access denied".
func createExclusively(path string, perm rootFilePerm) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sa, err := securityAttributes(windowsSDDL(perm, false, ServiceName))
	if err != nil {
		return nil, err
	}
	for attempt := 1; ; attempt++ {
		h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ, sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err == nil {
			return os.NewFile(uintptr(h), path), nil
		}
		if attempt >= holdRetry.attempts || !holdRetry.retries(err) {
			return nil, &fs.PathError{Op: "create", Path: path, Err: err}
		}
		time.Sleep(holdRetry.wait)
	}
}

// readOnlyVolume marks an error that says the volume is read-only, so that the
// step (which is the same on every platform) can tell READ_ONLY from any other
// failure to write beside the executable.
func readOnlyVolume(err error) error {
	if errors.Is(err, windows.ERROR_WRITE_PROTECT) && !errors.Is(err, errUpdateReadOnly) {
		return fmt.Errorf("%w: %v", errUpdateReadOnly, err)
	}
	return err
}

// copyIntoHeldDirectory makes the new file name in dir, which the step holds open,
// and fills it with exactly size bytes of src (any length up to the largest agent
// build when size is negative). The file is created exclusively with the access
// list perm names, written and flushed, and read back through the handle that wrote
// it, which nothing else can write or replace while it is open: the digest is the
// digest of what is on the volume under that name. A source with more or fewer
// bytes than size is refused, and a failure removes the new file.
func copyIntoHeldDirectory(dir *rootOwned, name string, perm rootFilePerm, src io.Reader, size int64) (string, error) {
	if err := checkEntryName(name); err != nil {
		return "", err
	}
	path := dir.entryPath(name)
	f, err := createExclusively(path, perm)
	if err != nil {
		return "", readOnlyVolume(err)
	}
	complete := false
	defer func() {
		if !complete {
			_ = f.Close()
			_ = deleteFile(path, holdRetry)
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
	if err != nil {
		return "", readOnlyVolume(err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	digest, err := digestOfReader(f)
	if err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", readOnlyVolume(err)
	}
	complete = true
	return digest, nil
}

// freeBytes is how many bytes the step may still write on the volume that holds
// path.
func freeBytes(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree); err != nil {
		return 0, fmt.Errorf("couldn't read the free space of %s: %w", path, err)
	}
	return free, nil
}

// volumeReadOnly reports whether the volume that holds path is mounted read-only.
func volumeReadOnly(path string) (bool, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	root := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumePathName(p, &root[0], uint32(len(root))); err != nil {
		return false, err
	}
	var flags uint32
	if err := windows.GetVolumeInformation(&root[0], nil, 0, nil, nil, &flags, nil, 0); err != nil {
		return false, err
	}
	return flags&windows.FILE_READ_ONLY_VOLUME != 0, nil
}

// ---------------------------------------------------------------- the host

// Lock takes the step's lock: a file of the private directory opened for reading
// and writing and shared with nobody, so that a second run, which asks for the
// same, is refused by the system. The system drops it when the process ends, so a
// step that was killed never leaves it held. The files an earlier commit left
// beside the helper copy are removed first (removeAsides).
func (h *windowsUpdateHost) Lock(private *rootOwned) (func(), error) {
	path := private.entryPath(updateLockFile)
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sa, err := securityAttributes(windowsSDDL(rootPrivate, false, ServiceName))
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, sa, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return nil, errUpdateStepBusy
	}
	if err != nil {
		return nil, &fs.PathError{Op: "lock", Path: path, Err: err}
	}
	// The lock file is the step's own, in a directory only root can write: judge it
	// like the rest of the path.
	if err := checkHandle(handle, path, rootOwnedFile); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if private.trust.judged(path) {
		if err := judgeHandle(handle, path, windowsObject, private.trust); err != nil {
			_ = windows.CloseHandle(handle)
			return nil, err
		}
	}
	removeAsides(private)
	return func() { _ = windows.CloseHandle(handle) }, nil
}

// removeAsides removes the old copies of the helper that Replace left beside it
// when it stepped a running executable aside. A copy that is still running can't be
// deleted, and stays until the process is gone: the next run that finds it unused
// removes it.
func removeAsides(private *rootOwned) {
	directory := private.entryPath(updateHelperDir)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "vectory.exe"+helperAsideMarker) {
			continue
		}
		if p, err := windows.UTF16PtrFromString(filepath.Join(directory, name)); err == nil {
			_ = windows.DeleteFile(p)
		}
	}
}

// helperAsideMarker is what a copy of the helper that stepped aside is called,
// followed by a random suffix.
const helperAsideMarker = ".old-"

// randomSuffix is n random bytes as hexadecimal.
func randomSuffix(n int) (string, error) {
	random := make([]byte, n)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}

// FreeSpace is the room left on the volume that holds dir.
func (h *windowsUpdateHost) FreeSpace(dir *rootOwned) (uint64, error) {
	return freeBytes(dir.dirPath)
}

// CheckPrivate refuses a private directory that anyone but root could enter: the
// step's copies of what the service account wrote are there, and so are the counter
// floors. The path check has already seen that nobody else can change it; this
// reads its access list again for who can see into it.
func (h *windowsUpdateHost) CheckPrivate(private *rootOwned) error {
	handle, err := private.directoryHandle()
	if err != nil {
		return err
	}
	found, err := readSecurity(handle, private.Path())
	if err != nil {
		return err
	}
	if problem := privateDirectoryProblem(found.owner, found.hasACL, found.entries, private.trust.sid, accountName); problem != "" {
		return untrustedLocation(private.Path() + " " + problem)
	}
	return nil
}

// CopyInto is updateHost's CopyInto.
func (h *windowsUpdateHost) CopyInto(dir *rootOwned, name string, perm rootFilePerm, src io.Reader, size int64) (string, error) {
	return copyIntoHeldDirectory(dir, name, perm, src, size)
}

// RemoveFrom removes one file of a held directory. A file that isn't there is not
// an error.
func (h *windowsUpdateHost) RemoveFrom(dir *rootOwned, name string) error {
	if err := checkEntryName(name); err != nil {
		return err
	}
	return deleteFile(dir.entryPath(name), holdRetry)
}

// EmptyDir removes everything in a held directory and leaves the directory.
func (h *windowsUpdateHost) EmptyDir(dir *rootOwned) error {
	entries, err := os.ReadDir(dir.dirPath)
	if err != nil {
		return err
	}
	var first error
	for _, entry := range entries {
		if err := removeTree(filepath.Join(dir.dirPath, entry.Name())); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Replace renames a file of a held directory over another, which returns when the
// rename is on disk. A running executable can be renamed but not replaced, so when
// the name that is taken belongs to a program that is running (the helper copy the
// step itself runs from), that file steps aside under a name of its own and the
// new one takes its place: the old copy keeps running from the file it was started
// from, and removeAsides deletes it at a run after the process is gone.
func (h *windowsUpdateHost) Replace(dir *rootOwned, from, to string) error {
	for _, name := range []string{from, to} {
		if err := checkEntryName(name); err != nil {
			return err
		}
	}
	fromPath, toPath := dir.entryPath(from), dir.entryPath(to)
	err := moveFile(fromPath, toPath, patientTry)
	if err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return err
	}
	aside, suffixErr := asideName(to)
	if suffixErr != nil {
		return suffixErr
	}
	if moveErr := moveFile(toPath, dir.entryPath(aside), patientTry); moveErr != nil {
		return fmt.Errorf("%w (and stepping the copy that is there aside failed: %v)", err, moveErr)
	}
	if moveErr := moveFile(fromPath, toPath, patientTry); moveErr != nil {
		_ = moveFile(dir.entryPath(aside), toPath, patientTry)
		return moveErr
	}
	return nil
}

// asideName is the name a copy of name that steps aside takes.
func asideName(name string) (string, error) {
	suffix, err := randomSuffix(8)
	if err != nil {
		return "", err
	}
	return name + helperAsideMarker + suffix, nil
}

// OpenServiceFile opens one file the service account wrote. The directory is
// walked from the root of the drive without following a link or an alias at any
// component, and the file is opened as itself (a link in its place is refused, not
// followed), shared with every other opener, so that the agent that wrote it can
// replace it while it is read and the step never waits for it. What the walk and the
// open return is judged by the handle and never by the path: the file must be a
// regular file on a disk with one name only (a hard link to a file that isn't the
// agent's is refused), owned by the agent's service account or by root, and within
// limit. The state directory belongs to the service account, which can rename and
// replace anything in it at any time, so nothing about the file is believed beyond
// what the open handle says now: the caller copies the bytes and verifies the copy.
func (h *windowsUpdateHost) OpenServiceFile(directory, name string, account updateAccount, limit int64) (*updateServiceFile, error) {
	if err := checkEntryName(name); err != nil {
		return nil, err
	}
	dir, err := walkOwned(directory, rootOwnedDirectory, ownerTrust{unjudged: true}, nil)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	path := dir.entryPath(name)
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	fail := func(err error) (*updateServiceFile, error) {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if err := checkHandle(handle, path, rootOwnedFile); err != nil {
		return fail(err)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return fail(&fs.PathError{Op: "stat", Path: path, Err: err})
	}
	if info.NumberOfLinks != 1 {
		return fail(untrustedLocation(fmt.Sprintf("%s has %d names, so it may be a link to a file that isn't the agent's", path, info.NumberOfLinks)))
	}
	found, err := readSecurity(handle, path)
	if err != nil {
		return fail(err)
	}
	if found.owner != serviceSID(ServiceName) && !rootAccount(found.owner, rootOwnedTrust.sid) {
		return fail(untrustedLocation(fmt.Sprintf("%s belongs to %s, not to the agent's service account (%s)", path, accountName(found.owner), account.Name)))
	}
	size := int64(info.FileSizeHigh)<<32 | int64(info.FileSizeLow)
	if size < 0 || size > limit {
		return fail(fmt.Errorf("%s is %d bytes and the step reads at most %d: %w", path, size, limit, errServiceFileTooLarge))
	}
	return &updateServiceFile{File: os.NewFile(uintptr(handle), path), Size: size, ModTime: time.Unix(0, info.LastWriteTime.Nanoseconds())}, nil
}
