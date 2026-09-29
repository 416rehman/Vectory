//go:build windows

package agent

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"testing"
)

func TestReAdoptPreservesWindowsAccessDescriptor(t *testing.T) {
	dir := t.TempDir()
	source, dest := filepath.Join(dir, "source"), filepath.Join(dir, "dest")
	if err := AtomicWrite(source, []byte("original")); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(dest, []byte("replacement")); err != nil {
		t.Fatal(err)
	}
	if err := preserveSettingsSecurity(source, dest); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(dest); err != nil {
		t.Fatal(err)
	}
}

func TestExistingDaemonLockKeepsServiceAccessMetadata(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.lock")
	if err := AtomicWrite(path, []byte("")); err != nil {
		t.Fatal(err)
	}
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;SY)(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;BA)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	parts := windows.SECURITY_INFORMATION(windows.OWNER_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION)
	before, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, parts)
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := Lock(dir); err == nil {
		second()
		t.Fatal("second lock succeeded")
	}
	unlock()
	after, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, parts)
	if err != nil {
		t.Fatal(err)
	}
	if before.String() == "" || before.String() != after.String() {
		t.Fatal("lock acquisition changed existing service access")
	}
}

func TestReAdoptRejectsWindowsRemoteDeviceAndStreamPaths(t *testing.T) {
	for _, path := range []string{`\\server\share\vector.exe`, `\\?\C:\vector.exe`, `\\.\C:\vector.exe`, `C:\fixture\file:vector.exe`, `C:relative.exe`} {
		if adoptionLocalPath(path) == nil {
			t.Fatalf("accepted nonlocal/stream path %s", path)
		}
	}
}
