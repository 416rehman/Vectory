//go:build linux

package agent

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// A POSIX access list lets root's file or directory carry a write grant for
// another account that no owner or mode bit shows. The kernel keeps the list in
// the attribute system.posix_acl_access, and once it names an account, the group
// bits of the mode show the list's mask: the most that any entry but the owner's
// grants. A named account that can write therefore shows as a mode the check
// already refuses. These tests build such lists on trees root owns, and run the
// check as it ships. They need root, and a file system that keeps access lists.

const posixACLAttribute = "system.posix_acl_access"

// Entry tags of a POSIX access list (linux/posix_acl.h).
const (
	posixUserObj  = 0x01
	posixUser     = 0x02
	posixGroupObj = 0x04
	posixGroup    = 0x08
	posixMask     = 0x10
	posixOther    = 0x20
	posixNoID     = 0xffffffff
)

type posixEntry struct {
	tag, perm uint16
	id        uint32
}

// posixACL is an access list as the kernel stores it: a version, then each entry
// as a tag, its permissions and the account it names.
func posixACL(entries ...posixEntry) []byte {
	blob := binary.LittleEndian.AppendUint32(nil, 2)
	for _, e := range entries {
		blob = binary.LittleEndian.AppendUint16(blob, e.tag)
		blob = binary.LittleEndian.AppendUint16(blob, e.perm)
		blob = binary.LittleEndian.AppendUint32(blob, e.id)
	}
	return blob
}

// namedGrant is the list of a file whose owner, group and everyone else have the
// given permissions and that also gives account 65534 (a user, or a group, by
// tag) perm. The mask is the union of the permissions that aren't the owner's.
func namedGrant(tag, perm, owner, group, other uint16) []byte {
	entries := []posixEntry{{posixUserObj, owner, posixNoID}}
	if tag == posixUser {
		entries = append(entries, posixEntry{posixUser, perm, 65534})
	}
	entries = append(entries, posixEntry{posixGroupObj, group, posixNoID})
	if tag == posixGroup {
		entries = append(entries, posixEntry{posixGroup, perm, 65534})
	}
	return posixACL(append(entries,
		posixEntry{posixMask, group | perm, posixNoID},
		posixEntry{posixOther, other, posixNoID})...)
}

func TestRootOwnedRefusesAWriteGrantInAPosixAccessList(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("this test builds trees that root owns, so it runs as root")
	}
	if rootOwnedTrust != (ownerTrust{}) {
		t.Fatal("a test left the path check's seam set: this test runs the check as it ships")
	}
	base := systemBase(t)
	dir := filepath.Join(base, "granted")
	mkdirMode(t, dir, 0o755)
	file := filepath.Join(dir, "file")
	writeMode(t, file, "good", 0o644)
	mustOpen(t, file, rootOwnedFile)

	// grant puts a list on path for the length of the subtest; the mode it had
	// comes back with it.
	grant := func(t *testing.T, path string, blob []byte, original os.FileMode) {
		t.Helper()
		err := unix.Setxattr(path, posixACLAttribute, blob, 0)
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.ENOSYS) {
			t.Skipf("this file system keeps no POSIX access lists: %v", err)
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := unix.Removexattr(path, posixACLAttribute); err != nil {
				t.Errorf("remove the list: %v", err)
			}
			if err := os.Chmod(path, original); err != nil {
				t.Errorf("restore the mode: %v", err)
			}
		})
	}

	for _, who := range []struct {
		name string
		tag  uint16
	}{{"a named account", posixUser}, {"a named group", posixGroup}} {
		t.Run(who.name+" that can only read passes", func(t *testing.T) {
			grant(t, dir, namedGrant(who.tag, 5, 7, 5, 5), 0o755)
			grant(t, file, namedGrant(who.tag, 4, 6, 4, 4), 0o644)
			if _, err := openRootOwned(file, rootOwnedFile); err != nil {
				t.Errorf("read access for %s: %v", who.name, err)
			}
		})
		t.Run(who.name+" that can write the directory", func(t *testing.T) {
			grant(t, dir, namedGrant(who.tag, 7, 7, 5, 5), 0o755)
			_, err := openRootOwned(file, rootOwnedFile)
			if refusal := refusedAs(t, err); refusal.Detail != dir+" is writable by its group (mode 0775)" {
				t.Errorf("%q", refusal.Detail)
			}
		})
		t.Run(who.name+" that can write the file", func(t *testing.T) {
			grant(t, file, namedGrant(who.tag, 6, 6, 4, 4), 0o644)
			_, err := openRootOwned(file, rootOwnedFile)
			if refusal := refusedAs(t, err); refusal.Detail != file+" is writable by its group (mode 0664)" {
				t.Errorf("%q", refusal.Detail)
			}
		})
	}
	// What the subtests undid leaves the tree as it was checked at the start.
	if _, err := openRootOwned(file, rootOwnedFile); err != nil {
		t.Errorf("after the lists were removed: %v", err)
	}
}
