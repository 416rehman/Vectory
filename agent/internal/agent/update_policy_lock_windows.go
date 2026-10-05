//go:build windows

package agent

import (
	"errors"
	"io/fs"

	"golang.org/x/sys/windows"
)

func tryLockUpdatePolicy(dir *rootOwned) (func(), error) {
	path := dir.entryPath(updatePolicyLockFile)
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sa, err := securityAttributes(windowsSDDL(rootPrivate, false, ServiceName))
	if err != nil {
		return nil, err
	}
	// No sharing prevents a second writer from using or replacing this file
	// until the first writer closes its handle. The directory's checked handle
	// also keeps its path stable during the transaction.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, sa, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return nil, errUpdatePolicyLockBusy
	}
	if err != nil {
		return nil, &fs.PathError{Op: "lock", Path: path, Err: err}
	}
	if err := checkHandle(handle, path, rootOwnedFile); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if dir.trust.judged(path) {
		if err := judgeHandle(handle, path, windowsObject, dir.trust); err != nil {
			_ = windows.CloseHandle(handle)
			return nil, err
		}
	}
	return func() { _ = windows.CloseHandle(handle) }, nil
}
