package agent

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// The macOS side of the path check, as plain values. rootpath_extacl_darwin.go
// reads the access list of each handle the check holds and hands the bytes to
// extendedACLProblem, which decides; keeping the decision free of macOS calls lets
// every case run on every platform.
//
// Why the check reads them. The Unix check judges the owning account and the permission bits
// of each directory and file on a path, which is all a Linux or BSD file system
// has. A macOS file system also keeps an access control list (chmod +a, or one a
// parent hands down), whose entries can let another account write a file, add
// files to a directory, delete what a directory holds, change its permissions or
// take it over, without changing st_mode. On such a path the service account could
// replace the update policy (pinning its own key) or the executable the step
// installs. An entry that allows any of those to an account other than root makes
// the path untrusted, whatever it names and whether or not it is inherited: the
// step creates files in the directories it checks, and an entry that only
// children inherit still decides who may rewrite the files it makes there. An
// entry that denies, or allows only reading, passes: they take nothing from root.
//
// The principal of an entry is a GUID. Root's is the one macOS derives from user
// ID 0, and it alone passes; every other principal, a user, the group everyone, the
// group wheel, is refused for a right below as the permission bits refuse a group
// or everyone that can write.
//
// The layout is the kernel's kauth_filesec (xnu bsd/sys/kauth.h), as
// fgetattrlist(ATTR_CMN_EXTENDED_SECURITY) returns it, in the host's byte order,
// which on every Mac the agent runs on is little-endian: a magic number, the
// owner's and the group's GUIDs, the count of entries and the list's flags, then
// each entry as a GUID, flags and rights.

const (
	extACLMagic      = 0x012cc16d        // KAUTH_FILESEC_MAGIC
	extACLHeader     = 44                // magic, two GUIDs, entry count, flags
	extACLEntry      = 24                // GUID, flags, rights
	extACLMaxEntries = 128               // KAUTH_ACL_MAX_ENTRIES
	extACLNone       = uint32(1<<32 - 1) // KAUTH_FILESEC_NOACL: no list
)

// Entry kinds, in the low bits of an entry's flags (KAUTH_ACE_*). Only an entry
// that permits can give anyone anything.
const (
	extACEKindMask = 0xf
	extACEPermit   = 1
)

// Rights (KAUTH_VNODE_*; the same values as acl_perm_t in sys/acl.h). A right has
// two names, one for a file and one for a directory.
const (
	extRightWriteData     = 1 << 2  // write; add_file
	extRightDelete        = 1 << 4  // delete
	extRightAppendData    = 1 << 5  // append; add_subdirectory
	extRightDeleteChild   = 1 << 6  // delete_child
	extRightWriteSecurity = 1 << 12 // writesecurity: change the list and the mode
	extRightTakeOwner     = 1 << 13 // chown

	// extRightsRefused are the rights an entry for anyone but root may not allow.
	extRightsRefused = extRightWriteData | extRightDelete | extRightAppendData | extRightDeleteChild | extRightWriteSecurity | extRightTakeOwner
)

// extPrincipal is the GUID of an account or a group.
type extPrincipal [16]byte

// The GUIDs macOS derives from user and group IDs (the compatibility UUIDs the
// directory service gives an account that has none of its own): a fixed prefix and
// the ID as four bytes, most significant first. Root is user 0, and wheel group 0.
var (
	extUserPrefix  = [12]byte{0xff, 0xff, 0xee, 0xee, 0xdd, 0xdd, 0xcc, 0xcc, 0xbb, 0xbb, 0xaa, 0xaa}
	extGroupPrefix = [12]byte{0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef}
	extRoot        = extPrincipal{0xff, 0xff, 0xee, 0xee, 0xdd, 0xdd, 0xcc, 0xcc, 0xbb, 0xbb, 0xaa, 0xaa, 0, 0, 0, 0}
)

// String names a principal as a person can use: "uid 501" and "gid 80" for the
// derived GUIDs, and the GUID itself for any other.
func (p extPrincipal) String() string {
	id := binary.BigEndian.Uint32(p[12:])
	switch {
	case [12]byte(p[:12]) == extUserPrefix:
		return fmt.Sprintf("uid %d", id)
	case [12]byte(p[:12]) == extGroupPrefix:
		return fmt.Sprintf("gid %d", id)
	}
	return fmt.Sprintf("the account with the GUID %X-%X-%X-%X-%X", p[0:4], p[4:6], p[6:8], p[8:10], p[10:16])
}

// extEntry is one entry of an access list.
type extEntry struct {
	principal extPrincipal
	kind      uint32
	rights    uint32
}

// parseExtendedACL reads the bytes fgetattrlist returns for a handle's access list.
// An empty value and a list the kernel marks as none are no entries. A list that
// doesn't have the kernel's format, or whose size and count disagree, is an error:
// a check that can't read a list doesn't take the path for clean.
func parseExtendedACL(blob []byte) ([]extEntry, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	if len(blob) < extACLHeader || binary.LittleEndian.Uint32(blob[0:4]) != extACLMagic {
		return nil, errors.New("the access list isn't in the kernel's format")
	}
	count := binary.LittleEndian.Uint32(blob[36:40])
	if count == extACLNone {
		return nil, nil
	}
	if count > extACLMaxEntries || len(blob) != extACLHeader+extACLEntry*int(count) {
		return nil, errors.New("the access list's size and its count of entries disagree")
	}
	entries := make([]extEntry, count)
	for i := range entries {
		raw := blob[extACLHeader+extACLEntry*i:][:extACLEntry]
		copy(entries[i].principal[:], raw[:16])
		entries[i].kind = binary.LittleEndian.Uint32(raw[16:20]) & extACEKindMask
		entries[i].rights = binary.LittleEndian.Uint32(raw[20:24])
	}
	return entries, nil
}

// extendedACLProblem says why an access list lets an account other than root change
// what it guards, as the end of a sentence about the path ("has an access list
// entry that allows add_file to gid 12"), or "" when it doesn't. directory says
// which names the rights go by.
func extendedACLProblem(blob []byte, directory bool) (string, error) {
	entries, err := parseExtendedACL(blob)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if entry.kind != extACEPermit || entry.principal == extRoot {
			continue
		}
		if granted := entry.rights & extRightsRefused; granted != 0 {
			return fmt.Sprintf("has an access list entry that allows %s to %s", quoteList(extRightNames(granted, directory)), entry.principal), nil
		}
	}
	return "", nil
}

// extRightNames names rights as chmod(1) does, in the order it lists them.
func extRightNames(rights uint32, directory bool) []string {
	write, appendName := "write", "append"
	if directory {
		write, appendName = "add_file", "add_subdirectory"
	}
	var names []string
	for _, right := range []struct {
		bit  uint32
		name string
	}{
		{extRightWriteData, write}, {extRightAppendData, appendName}, {extRightDelete, "delete"},
		{extRightDeleteChild, "delete_child"}, {extRightWriteSecurity, "writesecurity"}, {extRightTakeOwner, "chown"},
	} {
		if rights&right.bit != 0 {
			names = append(names, right.name)
		}
	}
	return names
}
