package agent

import (
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
)

// The Windows side of the path check, as plain values. rootpath_windows.go reads
// the owning account and the access entries of each handle and hands them to
// aclProblem, which decides; keeping the decision free of Windows calls lets
// every case run on every platform.
//
// Who counts as root: SYSTEM, the Administrators and TrustedInstaller (which owns
// Program Files and the system directories). An access entry that grants any
// other account a right below, or an owning account that is any other, makes a
// path untrusted.
//
// An access list isn't a set of permission bits, and one difference matters.
// A default Windows install lets ordinary accounts create files and folders in
// C:\ProgramData and folders in C:\ (Users and Authenticated Users hold
// FILE_ADD_FILE or FILE_ADD_SUBDIRECTORY there), and a folder made inside
// ProgramData inherits that. Creating a new name in a directory doesn't let
// anyone replace a name that exists, and every name on the path exists and is
// checked through its own handle. So the directories above the one that holds
// the object are refused for the rights that replace what is in them or take
// them over (rightsToReplace), and the directory that holds the object, and the
// object itself, are refused for every right to change them (rightsToModify):
// the step writes into the first, and trusts the second.

const (
	sidSystem           = "S-1-5-18"
	sidAdministrators   = "S-1-5-32-544"
	sidTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	// sidCreatorOwner stands for whichever account owns the object, which the
	// check has already required to be one of the three above.
	sidCreatorOwner = "S-1-3-0"
)

// Access entry types and flags (winnt.h).
const (
	aclAccessAllowed = 0
	aclAccessDenied  = 1
	aclInheritOnly   = 0x08 // INHERIT_ONLY_ACE: the entry doesn't apply to this object
)

// Access rights (winnt.h).
const (
	rightWriteData       uint32 = 0x00000002 // FILE_WRITE_DATA; FILE_ADD_FILE on a directory
	rightAppendData      uint32 = 0x00000004 // FILE_APPEND_DATA; FILE_ADD_SUBDIRECTORY on a directory
	rightWriteEA         uint32 = 0x00000010
	rightDeleteChild     uint32 = 0x00000040
	rightWriteAttributes uint32 = 0x00000100
	rightDelete          uint32 = 0x00010000
	rightWriteDAC        uint32 = 0x00040000
	rightWriteOwner      uint32 = 0x00080000
	rightGenericAll      uint32 = 0x10000000
	rightGenericWrite    uint32 = 0x40000000

	// rightsToReplace lets an account remove, rename, or take over what it is
	// granted them on, or change who may do so.
	rightsToReplace = rightDeleteChild | rightDelete | rightWriteDAC | rightWriteOwner | rightGenericAll | rightGenericWrite
	// rightsToModify adds the rights to change the contents.
	rightsToModify = rightsToReplace | rightWriteData | rightAppendData | rightWriteEA | rightWriteAttributes
)

// windowsRole says what a component of the path is, which decides the rights
// that refuse it.
type windowsRole int

const (
	// windowsAbove: a directory above the one that holds the object.
	windowsAbove windowsRole = iota + 1
	// windowsHolds: the directory that holds the object, or is it.
	windowsHolds
	// windowsObject: the file.
	windowsObject
)

// aclEntry is one entry of an access list, as the check reads it.
type aclEntry struct {
	SID   string
	Type  uint8
	Flags uint8
	Mask  uint32
}

// rightsText names what mask grants that a path must not grant others.
func rightsText(mask uint32) string {
	var parts []string
	switch {
	case mask&rightGenericAll != 0:
		parts = append(parts, "full control")
	case mask&(rightGenericWrite|rightWriteData|rightAppendData|rightWriteEA|rightWriteAttributes) != 0:
		parts = append(parts, "write")
	}
	if mask&(rightDelete|rightDeleteChild) != 0 {
		parts = append(parts, "delete")
	}
	if mask&(rightWriteDAC|rightWriteOwner) != 0 {
		parts = append(parts, "change permissions")
	}
	return strings.Join(parts, ", ")
}

// aclProblem says why an owner and an access list are not SYSTEM's and the
// Administrators' alone, or "". extra is one more account whose ownership and
// entries pass (a test's own). name turns a SID into what a person reads; nil
// leaves the SID.
func aclProblem(owner string, hasACL bool, entries []aclEntry, role windowsRole, extra string, name func(string) string) string {
	label := func(sid string) string {
		if name != nil {
			return name(sid)
		}
		return sid
	}
	trusted := func(sid string) bool {
		return sid == sidSystem || sid == sidAdministrators || sid == sidTrustedInstaller || (extra != "" && sid == extra)
	}
	if !trusted(owner) {
		return "belongs to " + label(owner) + ", not to SYSTEM or the Administrators"
	}
	if !hasACL {
		return "has no access list, so everyone can change it"
	}
	changing := rightsToModify
	if role == windowsAbove {
		changing = rightsToReplace
	}
	for _, entry := range entries {
		switch entry.Type {
		case aclAccessAllowed:
		case aclAccessDenied:
			// A refusal grants nothing. Counting every allow entry as in force
			// can refuse a path that is safe; it never accepts one that isn't.
			continue
		default:
			return "has an access entry of a kind this check doesn't read (type " + strconv.Itoa(int(entry.Type)) + ")"
		}
		if entry.Flags&aclInheritOnly != 0 || trusted(entry.SID) || entry.SID == sidCreatorOwner {
			continue
		}
		if granted := entry.Mask & uint32(changing); granted != 0 {
			return "can be changed by " + label(entry.SID) + " (" + rightsText(granted) + ")"
		}
	}
	return ""
}

// serviceSID is the SID of the virtual account NT SERVICE\<name>: S-1-5-80
// followed by the five 32-bit words of the SHA-1 of the upper-cased name in
// UTF-16 little endian. The account has this SID whether or not the service is
// registered yet, which is how a policy can be written before setup registers
// the service. The same derivation gives TrustedInstaller's SID.
func serviceSID(name string) string {
	units := utf16.Encode([]rune(strings.ToUpper(name)))
	text := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(text[2*i:], unit)
	}
	sum := sha1.Sum(text)
	words := make([]string, 5)
	for i := range words {
		words[i] = fmt.Sprint(binary.LittleEndian.Uint32(sum[4*i:]))
	}
	return "S-1-5-80-" + strings.Join(words, "-")
}

// windowsSDDL is the security descriptor of what root makes on Windows: SYSTEM
// and the Administrators have full control and nobody else gets more than what
// perm says, and nothing is inherited. For a directory the entries pass to what
// is made in it. rootExecutable has no descriptor of its own: what is made
// takes the access its directory gives, which is the install directory's.
func windowsSDDL(perm rootFilePerm, directory bool, service string) string {
	inherit := ""
	if directory {
		inherit = "OICI"
	}
	base := "D:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)"
	switch perm {
	case rootPrivate:
		return base
	case rootReadable:
		return base + "(A;" + inherit + ";FR;;;" + serviceSID(service) + ")"
	}
	return ""
}
