//go:build windows

package agent

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
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
	sd, e := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;" + u.User.Sid.String() + ")")
	if e != nil {
		return e
	}
	acl, _, e := sd.DACL()
	if e != nil {
		return e
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, u.User.Sid, nil, acl, nil)
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
		return fail(errors.New("private file must be a regular file without links"))
	}
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil || n >= uint32(len(buf)) {
		return fail(errors.New("cannot resolve private file handle"))
	}
	resolved := strings.TrimPrefix(windows.UTF16ToString(buf[:n]), `\\?\`)
	if !strings.EqualFold(filepath.Clean(resolved), path) {
		return fail(errors.New("private file traverses an alias or reparse point"))
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
		return errors.New("secret owner is not trusted")
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
			return errors.New("secret grants access to another principal")
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
func Lock(dir string) (func(), error) {
	p := filepath.Join(dir, "agent.lock")
	if e := SafePath(p); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = protect(p, false); e != nil {
		f.Close()
		return nil, e
	}
	var o windows.Overlapped
	if e = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &o); e != nil {
		f.Close()
		return nil, errors.New("another agent operation is running")
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &o); f.Close() }, nil
}
