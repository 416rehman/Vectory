//go:build windows

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"
)

func protect(path string, dir bool) error {
	t, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return e
	}
	defer t.Close()
	u, e := t.GetTokenUser()
	if e != nil {
		return e
	}
	flags := ""
	if dir {
		flags = "OICI"
	}
	// SYSTEM, the administrators of this machine and the writing account. The
	// service writes its own files as its virtual account, so without the
	// administrators an elevated `vectory status` could not read them.
	sd, e := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;BA)(A;" + flags + ";FA;;;" + u.User.Sid.String() + ")")
	if e != nil {
		return e
	}
	acl, _, e := sd.DACL()
	if e != nil {
		return e
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, u.User.Sid, nil, acl, nil)
}

// Private-file checks that failed, for privateFileProblem.
var (
	errPrivateFileLinks  = errors.New("private file must be a regular file without links")
	errPrivateFileAlias  = errors.New("private file traverses an alias or reparse point")
	errPrivateFileOwner  = errors.New("secret owner is not trusted")
	errPrivateFileShared = errors.New("secret grants access to another principal")
)

// privateFileProblem says which check made openPrivateFile refuse path, and
// how to fix it.
func privateFileProblem(path string, openErr error) (problem, fix string) {
	switch {
	case errors.Is(openErr, windows.ERROR_FILE_NOT_FOUND), errors.Is(openErr, windows.ERROR_PATH_NOT_FOUND):
		return "doesn't exist", ""
	case errors.Is(openErr, windows.ERROR_ACCESS_DENIED):
		return "can't be read by this account", "Run the command from an elevated PowerShell."
	case errors.Is(openErr, windows.ERROR_SHARING_VIOLATION):
		return "is open in another program", "Close it, then run the command again."
	case errors.Is(openErr, errPrivateFileLinks):
		return "isn't a regular file with a single name", "Save the token in a new file."
	case errors.Is(openErr, errPrivateFileAlias):
		return "is reached through a link or alias", "Pass the file's real path."
	case errors.Is(openErr, errPrivateFileOwner):
		return "belongs to another account", "Save the token in a new file from an elevated PowerShell."
	}
	return "is readable by other accounts", "Allow only Administrators and SYSTEM to read it (Properties > Security), then run the command again."
}

// Inspect the opened object, never an independently looked-up pathname. Denying
// write/delete sharing pins both bytes and the name for the bounded read.
func openPrivateFile(path string) (*os.File, error) {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) || strings.HasPrefix(path, `\\`) {
		return nil, errors.New("private file requires a local absolute path")
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.READ_CONTROL, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(h), path)
	fail := func(err error) (*os.File, error) { f.Close(); return nil, err }
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil {
		return fail(err)
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 {
		return fail(errPrivateFileLinks)
	}
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil || n >= uint32(len(buf)) {
		return fail(errors.New("cannot resolve private file handle"))
	}
	resolved := strings.TrimPrefix(windows.UTF16ToString(buf[:n]), `\\?\`)
	if !strings.EqualFold(filepath.Clean(resolved), path) {
		return fail(errPrivateFileAlias)
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil || sd == nil {
		return fail(errors.New("cannot verify private ACL"))
	}
	if err = checkPrivateDescriptor(sd); err != nil {
		return fail(err)
	}
	return f, nil
}
func checkPrivateDescriptor(sd *windows.SECURITY_DESCRIPTOR) error {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	allowed := map[string]bool{user.User.Sid.String(): true, "S-1-5-18": true, "S-1-5-32-544": true}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !allowed[owner.String()] {
		return errPrivateFileOwner
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errors.New("secret has no restrictive DACL")
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err = windows.GetAce(acl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("unsupported secret ACL")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !allowed[sid.String()] && ace.Mask != 0 {
			return errPrivateFileShared
		}
	}
	return nil
}
func checkPrivateFile(path string) error {
	f, err := openPrivateFile(path)
	if err != nil {
		return err
	}
	return f.Close()
}

// keepOwner does nothing on Windows: the replacement carries its own protected
// access list (protect), which names SYSTEM, the administrators and the writing
// account.
func keepOwner(tmp, path string) {}
func rejectPlatformLink(path string) error {
	p, e := windows.UTF16PtrFromString(path)
	if e != nil {
		return e
	}
	a, e := windows.GetFileAttributes(p)
	if e != nil {
		return e
	}
	if a&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("reparse-point paths are forbidden")
	}
	return nil
}
func replaceFile(from, to string) error {
	f, e := windows.UTF16PtrFromString(from)
	if e != nil {
		return e
	}
	t, e := windows.UTF16PtrFromString(to)
	if e != nil {
		return e
	}
	return windows.MoveFileEx(f, t, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func syncDir(path string) error { return nil } // MoveFileEx WRITE_THROUGH is the Windows durability boundary.
// A global named mutex survives deletion of agent.lock and coordinates the
// service session with an interactive administrator. It is held only during
// lock acquisition, except that purge holds it through deletion.
func lockLifecycle(dir string) (func(), error) {
	canonical, err := canonicalLifecyclePath(dir)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(strings.ToLower(canonical)))
	name, err := windows.UTF16PtrFromString(`Global\VectoryLifecycle-` + hex.EncodeToString(digest[:]))
	if err != nil {
		return nil, err
	}
	// Only synchronization/release rights are shared; state-file ACLs remain
	// unchanged. The file lock below still gates actual agent operations.
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00100001;;;AU)")
	if err != nil {
		return nil, err
	}
	attrs := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	h, err := windows.CreateMutexEx(&attrs, name, 0, windows.SYNCHRONIZE|windows.MUTEX_MODIFY_STATE)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	// Windows mutex ownership belongs to a thread, not a goroutine.
	runtime.LockOSThread()
	result, err := windows.WaitForSingleObject(h, 0)
	if err != nil || result != windows.WAIT_OBJECT_0 && result != windows.WAIT_ABANDONED {
		runtime.UnlockOSThread()
		_ = windows.CloseHandle(h)
		if err != nil {
			return nil, err
		}
		return nil, errors.New("another agent lifecycle operation is running")
	}
	return func() {
		_ = windows.ReleaseMutex(h)
		_ = windows.CloseHandle(h)
		runtime.UnlockOSThread()
	}, nil
}

// Resolve existing directories by handle so an 8.3 spelling, different case,
// or an aliased parent cannot select a second mutex for the same state tree.
// A fresh install has no final directory yet, so resolve its existing parent.
func canonicalLifecyclePath(dir string) (string, error) {
	if err := adoptionLocalPath(dir); err != nil {
		return "", err
	}
	if err := SafePath(dir); err != nil {
		return "", err
	}
	path := filepath.Clean(dir)
	resolved, err := finalDirectoryPath(path)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return "", err
	}
	parent, err := finalDirectoryPath(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func purgeMarkerIdentity(dir string) (string, error) {
	path, err := canonicalLifecyclePath(dir)
	return strings.ToLower(path), err
}

func stateDirectoryIdentity(dir string) (string, error) {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil {
		return "", err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return "", errors.New("state path is not a directory")
	}
	return fmt.Sprintf("%08x:%08x:%08x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}

func finalDirectoryPath(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil {
		return "", err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return "", errors.New("state lifecycle path is not a directory")
	}
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "", err
	}
	if n == 0 || n >= uint32(len(buf)) {
		return "", errors.New("cannot resolve state lifecycle path")
	}
	resolved := strings.TrimPrefix(windows.UTF16ToString(buf[:n]), `\\?\`)
	if err = adoptionLocalPath(resolved); err != nil {
		return "", err
	}
	return filepath.Clean(resolved), nil
}

// Windows will not unlink agent.lock while its locking handle remains open.
// The named lifecycle mutex still excludes every current-version operation.
func purgeNeedsAgentUnlock() bool { return true }

func lockAgentFile(dir string) (func(), error) {
	p := filepath.Join(dir, "agent.lock")
	if e := SafePath(p); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	created := e == nil
	if os.IsExist(e) {
		f, e = os.OpenFile(p, os.O_RDWR, 0600)
	}
	if e != nil {
		return nil, e
	}
	// Preserve an existing service account's access, including when a stopped
	// agent is maintained by another authorized local operator.
	if created {
		e = protect(p, false)
	}
	if e != nil {
		f.Close()
		return nil, e
	}
	var o windows.Overlapped
	if e = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &o); e != nil {
		f.Close()
		return nil, lockHeld(dir)
	}
	recordLockOwner(f)
	return func() {
		clearLockOwner(f)
		windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &o)
		f.Close()
	}, nil
}
