//go:build windows

package agent

import (
	"golang.org/x/sys/windows"
	"path/filepath"
	"testing"
)

func TestSecretRejectsBroadWindowsDACL(t *testing.T) {
	p := filepath.Join(t.TempDir(), "token")
	if err := AtomicWrite(p, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = readLocalSecret(p); err == nil {
		t.Fatal("Everyone DACL allowed secret export")
	}
}
