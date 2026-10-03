//go:build windows

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// What the Windows tests of the step share: digests, the access list of a path as the
// system reports it, a file held open the way a virus scanner holds one, and whether
// a program is still running.

func sha256OfText(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func sha256OfFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256OfText(string(data))
}

// exists reports whether a name is in its directory. A file that was removed while
// something still holds it open is still there until the last holder lets go, and
// the system answers "access denied" to everyone who asks for it meanwhile: that is
// a name that is there.
func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	switch {
	case err == nil:
		return true
	case os.IsNotExist(err):
		return false
	case errors.Is(err, windows.ERROR_ACCESS_DENIED):
		return true
	}
	t.Fatal(err)
	return false
}

// descriptor is who owns a path and what its access list says, as the system reports
// them: whether the list is protected from what the parent gives, and each entry.
type descriptor struct {
	owner     string
	protected bool
	entries   []aclEntry
}

func readDescriptor(t *testing.T, path string) descriptor {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("reading the access list of %s: %v", path, err)
	}
	var found descriptor
	if owner, _, err := sd.Owner(); err == nil && owner != nil {
		found.owner = owner.String()
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	found.protected = control&windows.SE_DACL_PROTECTED != 0
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		t.Fatalf("%s has no access list: %v", path, err)
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			t.Fatal(err)
		}
		found.entries = append(found.entries, aclEntry{
			SID:   (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String(),
			Type:  ace.Header.AceType,
			Flags: ace.Header.AceFlags,
			Mask:  uint32(ace.Mask),
		})
	}
	return found
}

// requireOnlyRootAndThese checks the access list of a file the step made: owned by the
// Administrators, protected from what its directory gives, with no entry that was
// inherited, and exactly the entries in want (SID to rights).
func requireOnlyRootAndThese(t *testing.T, path string, want map[string]uint32) {
	t.Helper()
	found := readDescriptor(t, path)
	if found.owner != sidAdministrators {
		t.Errorf("%s belongs to %s, want the Administrators", path, accountName(found.owner))
	}
	if !found.protected {
		t.Errorf("%s takes what its directory gives", path)
	}
	got := map[string]uint32{}
	for _, entry := range found.entries {
		if entry.Type != aclAccessAllowed {
			t.Errorf("%s has an entry of type %d", path, entry.Type)
		}
		if entry.Flags&windows.INHERITED_ACE != 0 {
			t.Errorf("%s has an entry that was inherited: %+v", path, entry)
		}
		got[entry.SID] |= entry.Mask
	}
	if len(got) != len(want) {
		t.Errorf("%s: access list %v, want %v", path, got, want)
		return
	}
	for sid, mask := range want {
		if got[sid] != mask {
			t.Errorf("%s: %s has %#x, want %#x (%v)", path, accountName(sid), got[sid], mask, got)
		}
	}
}

// What a file the step makes grants, by the account it names.
const fullControl = 0x1f01ff

func executableAccess() map[string]uint32 {
	return map[string]uint32{
		sidSystem: fullControl, sidAdministrators: fullControl, sidTrustedInstaller: fullControl,
		sidUsers: 0x1200a9, serviceSID(ServiceName): 0x1200a9,
	}
}

func readableAccess() map[string]uint32 {
	return map[string]uint32{sidSystem: fullControl, sidAdministrators: fullControl, serviceSID(ServiceName): 0x120089}
}

func privateAccess() map[string]uint32 {
	return map[string]uint32{sidSystem: fullControl, sidAdministrators: fullControl}
}

// requireStepFilePrivate checks that a file the step wrote is its own. What decides
// who can read a Windows file is its access list: its permission bits say nothing (a
// file is 0666, or 0444 when it is read-only, whoever can open it). The step's files
// are SYSTEM's and the Administrators' alone, owned by the Administrators, protected
// from what the directory gives, with no entry that was inherited.
func requireStepFilePrivate(t *testing.T, path string) {
	t.Helper()
	requireOnlyRootAndThese(t, path, privateAccess())
}

// holdFile opens path the way a program that reads a file and lets others write it
// does (a virus scanner, an indexer): without sharing deletion, so that a rename or a
// removal of the file is refused until the handle is let go. The returned function
// lets go, and may be called more than once.
func holdFile(t *testing.T, path string) (release func()) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("holding %s: %v", path, err)
	}
	var once sync.Once
	release = func() { once.Do(func() { _ = windows.CloseHandle(h) }) }
	t.Cleanup(release)
	return release
}

// stillRunning reports whether the program cmd started is running.
func stillRunning(cmd *exec.Cmd) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(process) }()
	event, err := windows.WaitForSingleObject(process, 0)
	return err == nil && event == uint32(windows.WAIT_TIMEOUT)
}

// becomes waits up to limit for ok to be true, and says whether it was.
func becomes(limit time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(limit)
	for {
		if ok() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}
