//go:build darwin

package agent

import (
	"bytes"
	"encoding/binary"
	"errors"
	"golang.org/x/sys/unix"
	"syscall"
	"unsafe"
)

const darwinACLHeader = 44
const darwinACLEntry = 24
const darwinACLMaximum = 128
const darwinACLNone = uint32(0xffffffff)

// ATTR_CMN_EXTENDED_SECURITY uses an attrreference followed by kauth_filesec.
// Unlike clone/copy inheritance merging, setattrlist applies this exact ACL.
// Source: Apple xnu bsd/vfs/vfs_attrlist.c and bsd/sys/kauth.h.
func darwinSettingsACL(path string) ([]byte, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	acl, err := darwinACLOfDescriptor(fd)
	if err != nil || acl == nil {
		return nil, err
	}
	if binary.LittleEndian.Uint32(acl[40:44])&(1<<16) != 0 {
		return nil, errors.New("settings ACL defers inheritance until rename; cannot preserve it safely")
	}
	return acl, nil
}

// darwinACLOfDescriptor reads the extended access list of an open file or
// directory as the kernel's kauth_filesec: the exact bytes, or nil when there is no
// list. The path check reads each handle it holds with it (rootpath_extacl_darwin.go),
// and the settings copy preserves lists with it.
func darwinACLOfDescriptor(fd int) ([]byte, error) {
	attributes := unix.Attrlist{Bitmapcount: 5, Commonattr: unix.ATTR_CMN_EXTENDED_SECURITY}
	buffer := make([]byte, 12+darwinACLHeader+darwinACLEntry*darwinACLMaximum)
	_, _, failure := syscall.Syscall6(unix.SYS_FGETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0, 0)
	if failure != 0 {
		return nil, failure
	}
	length := int(binary.LittleEndian.Uint32(buffer[:4]))
	if length < 12 || length > len(buffer) {
		return nil, errors.New("unbounded ACL")
	}
	offset := int(int32(binary.LittleEndian.Uint32(buffer[4:8])))
	size := int(binary.LittleEndian.Uint32(buffer[8:12]))
	if size == 0 {
		return nil, nil
	}
	start := 4 + offset
	if start < 12 || size < darwinACLHeader || start+size > length {
		return nil, errors.New("invalid ACL reference")
	}
	acl := append([]byte(nil), buffer[start:start+size]...)
	if binary.LittleEndian.Uint32(acl[:4]) != 0x012cc16d {
		return nil, errors.New("invalid ACL format")
	}
	count := binary.LittleEndian.Uint32(acl[36:40])
	if count == darwinACLNone {
		return nil, nil
	}
	if count > darwinACLMaximum || len(acl) != darwinACLHeader+darwinACLEntry*int(count) {
		return nil, errors.New("unbounded ACL entries")
	}
	return acl, nil
}

func setDarwinSettingsACL(path string, acl []byte) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if acl == nil {
		// A zero-length getter denotes no ACL; setter requires explicit NOACL
		// to remove any inherited destination ACL rather than leave it alone.
		acl = make([]byte, darwinACLHeader)
		binary.LittleEndian.PutUint32(acl[:4], 0x012cc16d)
		binary.LittleEndian.PutUint32(acl[36:40], darwinACLNone)
	}
	buffer := make([]byte, 8+len(acl))
	binary.LittleEndian.PutUint32(buffer[:4], 8)
	binary.LittleEndian.PutUint32(buffer[4:8], uint32(len(acl)))
	copy(buffer[8:], acl)
	attributes := unix.Attrlist{Bitmapcount: 5, Commonattr: unix.ATTR_CMN_EXTENDED_SECURITY}
	_, _, failure := syscall.Syscall6(unix.SYS_FSETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0, 0)
	if failure != 0 {
		return failure
	}
	return nil
}

func preserveExtendedSettingsSecurity(source, destination string) error {
	wanted, err := darwinSettingsACL(source)
	if err != nil {
		return err
	}
	if err = setDarwinSettingsACL(destination, wanted); err != nil {
		return err
	}
	if err = copySettingsXattrs(source, destination); err != nil {
		return err
	}
	actual, err := darwinSettingsACL(destination)
	if err != nil {
		return err
	}
	current, err := darwinSettingsACL(source)
	if err != nil {
		return err
	}
	if !bytes.Equal(wanted, actual) || !bytes.Equal(wanted, current) {
		return errors.New("settings ACL could not be preserved exactly")
	}
	return nil
}
