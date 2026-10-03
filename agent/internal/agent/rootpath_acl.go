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
// Program Files and the system directories). Any other account is untrusted as an
// owner, because the owner of an object holds WRITE_DAC through ownership alone
// (unless an OWNER RIGHTS entry narrows it), so an object whose owner is another
// account is refused whatever its entries say; and as the holder of an allow entry,
// for the rights below.
//
// An access list isn't a set of permission bits, and one difference matters: what a
// component is to the path decides which rights refuse it (windowsRole).
//
//   - A directory above everything the step makes and above the install directory is
//     the system's own: a drive root, C:\ProgramData, C:\Program Files. A default
//     Windows installation lets Authenticated Users create folders in a drive root and
//     Users create files and folders in C:\ProgramData, and a folder made inside
//     ProgramData inherits that, so no machine could take an update if any right to
//     write there refused it. These directories are refused only for the rights that
//     change what an existing name leads to or who controls it (rightsToReplace).
//   - The directory the step makes its own directories in (%ProgramData%\Vectory, the
//     update root) and every directory below it, the install directory and the
//     executable are refused for every right that writes, adds, deletes or takes
//     control (rightsToModify): the step writes into them and trusts what they hold.
//
// The rights, with the values winnt.h gives them for a file or a directory:
//
//	FILE_WRITE_DATA, FILE_ADD_FILE (directory)          0x00000002
//	FILE_APPEND_DATA, FILE_ADD_SUBDIRECTORY (directory) 0x00000004
//	FILE_WRITE_EA                                       0x00000010
//	FILE_DELETE_CHILD                                   0x00000040
//	FILE_WRITE_ATTRIBUTES                               0x00000100
//	DELETE                                              0x00010000
//	WRITE_DAC                                           0x00040000
//	WRITE_OWNER                                         0x00080000
//	GENERIC_ALL                                         0x10000000
//	GENERIC_WRITE                                       0x40000000
//
// Why the first two directories above can allow creating. What an account needs to
// make an existing name lead somewhere else is to remove, rename or replace its
// entry: that takes DELETE on the object the name leads to or FILE_DELETE_CHILD on
// the directory that holds the name (a rename that lands on a name that exists
// removes what is there, which takes the same right on it, and the file system
// never replaces a directory), and WRITE_DAC or WRITE_OWNER to grant itself either.
// So a directory on the path is refused for FILE_DELETE_CHILD, for DELETE (renaming
// or deleting the directory itself needs it there, or FILE_DELETE_CHILD on the
// directory above) and for WRITE_DAC and WRITE_OWNER. FILE_ADD_FILE and
// FILE_ADD_SUBDIRECTORY create a name that isn't in the directory: no name on the
// path is missing, because each is opened, and judged, through its own handle. Nor
// do they turn a directory of the path into a link: the system makes a junction or a
// mount point of a directory only when it is empty, and every directory above the
// step's holds the next name of the path. FILE_WRITE_ATTRIBUTES and
// FILE_WRITE_EA change the attributes, the times and the extended attributes of the
// directory itself, and none of them adds, removes or renames an entry. Every other
// right in an access mask is a read right, SYNCHRONIZE, or ACCESS_SYSTEM_SECURITY (the
// audit list, which no entry grants: it takes a privilege). GENERIC_ALL maps to all of
// the above. GENERIC_WRITE maps to FILE_GENERIC_WRITE, which holds none of the four
// rights that decide a name, but the system maps a generic right to the object's own
// rights when it stores an entry that applies to the object itself (an inherit-only
// entry keeps it), so a generic right found in one was written some other way and the
// check doesn't guess what that would mean: it refuses it.
//
// Only allow entries are read. An entry that denies grants nothing, and counting
// every allow entry as in force, whatever order the list has, can refuse a list that
// is safe and never accepts one that isn't.
//
// The directory handles the walk holds stay open without FILE_SHARE_DELETE (and with
// the right to list them, because a directory opened for its attributes and its access
// list alone is outside sharing). While the step uses a path, no account can open any
// directory of it with DELETE access, which renaming or removing a directory takes, so
// nothing that respects sharing can move an ancestor either. The rules above are what
// keeps the path as it was checked before the step holds it and after it lets go.

const (
	sidSystem           = "S-1-5-18"
	sidAdministrators   = "S-1-5-32-544"
	sidTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	// sidCreatorOwner stands for whichever account owns the object, which the
	// check has already required to be one of the three above.
	sidCreatorOwner = "S-1-3-0"
)

// rootAccount reports whether a SID is SYSTEM, the Administrators or
// TrustedInstaller, or the one more account a test trusts.
func rootAccount(sid, extra string) bool {
	return sid == sidSystem || sid == sidAdministrators || sid == sidTrustedInstaller || (extra != "" && sid == extra)
}

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
	// windowsAbove: a directory above everything the step makes and above the
	// install directory: a drive root, C:\ProgramData, C:\Program Files.
	windowsAbove windowsRole = iota + 1
	// windowsHolds: a directory that must be root's alone to change: the one that
	// holds the object (or is it), and the update root and everything below it.
	windowsHolds
	// windowsObject: the file.
	windowsObject
	// windowsClosable: the update root as setup's first look finds it, before setup
	// changes anything. Setup closes a root that belongs to root and is open to
	// others itself (closeDirectoryToOthers), so only who owns it is judged.
	windowsClosable
)

// windowsPrefixes lists the root of a drive and every directory down to path, a
// clean path on a local drive (checkLocalPath has seen it): C:\, C:\ProgramData,
// C:\ProgramData\Vectory.
func windowsPrefixes(path string) []string {
	volume := ""
	if len(path) >= 2 && path[1] == ':' {
		volume = path[:2]
	}
	prefixes := []string{volume + `\`}
	rest := strings.TrimPrefix(path[len(volume):], `\`)
	if rest == "" {
		return prefixes
	}
	current := volume
	for _, part := range strings.Split(rest, `\`) {
		current += `\` + part
		prefixes = append(prefixes, current)
	}
	return prefixes
}

// windowsPathRoles says what each component of a path is. prefixes are the root of
// the drive and every directory down to the path (windowsPrefixes), kind says what
// the last one is, and updateRoot is the directory the step makes its own
// directories in when the path is at or below it, and "" otherwise. A path's holder
// and what is below it are windowsHolds and windowsObject from the update root on;
// everything above is windowsAbove. preflight is for setup's first look.
func windowsPathRoles(prefixes []string, kind rootOwnedKind, updateRoot string, preflight bool) []windowsRole {
	n := len(prefixes)
	roles := make([]windowsRole, n)
	strictFrom := n - 1
	if kind == rootOwnedFile {
		strictFrom = n - 2
	}
	rootAt := -1
	if updateRoot != "" {
		for i, prefix := range prefixes {
			if strings.EqualFold(prefix, updateRoot) {
				rootAt = i
				break
			}
		}
	}
	if rootAt >= 0 && rootAt < strictFrom {
		strictFrom = rootAt
	}
	for i := range roles {
		switch {
		case i == n-1 && kind == rootOwnedFile:
			roles[i] = windowsObject
		case i >= strictFrom:
			roles[i] = windowsHolds
		default:
			roles[i] = windowsAbove
		}
	}
	if preflight && rootAt >= 0 {
		roles[rootAt] = windowsClosable
	}
	return roles
}

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
// Administrators' alone, or "", for what the component is to the path (role):
// which rights refuse it is in the comment at the top of this file. extra is one
// more account whose ownership and entries pass (a test's own). name turns a SID
// into what a person reads; nil leaves the SID.
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
	if role == windowsClosable {
		return ""
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

// checkWindowsEntryName accepts one plain name in a directory: letters, digits,
// dots, underscores and hyphens, which can't reach another directory, a stream of
// a file or a short name, and isn't the name of a device. The system opens CON,
// PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9, with or without an extension, as
// the device in every directory, so a name that is one is refused.
func checkWindowsEntryName(name string) error {
	invalid := fmt.Errorf("%q isn't a name in a directory", name)
	if name == "" || name == "." || name == ".." || len(name) > 255 || strings.HasSuffix(name, ".") {
		return invalid
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
			return invalid
		}
	}
	base, _, _ := strings.Cut(strings.ToUpper(name), ".")
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return invalid
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9' {
		return invalid
	}
	return nil
}

// Rights as SDDL writes them: the mask of FILE_GENERIC_READ and
// FILE_GENERIC_EXECUTE together, which is what a person running a program needs.
const sddlReadAndRun = "0x1200a9"

// windowsSDDL is the security descriptor of what root makes on Windows: the
// Administrators own it, SYSTEM and the Administrators have full control and
// nobody else gets more than what perm says, and nothing is inherited into it from
// the directory that holds it. A file that inherited its directory's entries would
// be as safe as the directory's inheritable entries, which the check doesn't read
// (it judges the entries that apply to the directory itself), so every file and
// directory root makes has a list of its own. For a directory the entries pass to
// what is made in it.
//
//	rootPrivate     SYSTEM, the Administrators
//	rootReadable    and the agent's service reads
//	rootExecutable  and TrustedInstaller; the Users and the agent's service read
//	                and run it
func windowsSDDL(perm rootFilePerm, directory bool, service string) string {
	inherit := ""
	if directory {
		inherit = "OICI"
	}
	base := "O:BAD:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)"
	switch perm {
	case rootPrivate:
		return base
	case rootReadable:
		return base + "(A;" + inherit + ";FR;;;" + serviceSID(service) + ")"
	case rootExecutable:
		return base + "(A;" + inherit + ";FA;;;" + sidTrustedInstaller + ")(A;" + inherit + ";" + sddlReadAndRun + ";;;BU)(A;" + inherit + ";" + sddlReadAndRun + ";;;" + serviceSID(service) + ")"
	}
	return ""
}

// updateRootSDDL is the security descriptor of the directory the policy's and the
// step's directories are made in (%ProgramData%\Vectory): the Administrators own it,
// SYSTEM and the Administrators have full control of it and of what is made in
// it, the agent's service may list and read it (its own directories are below it),
// and nobody else may add an entry, which is what a squatter needs. Every directory
// the agent makes in %ProgramData% is made with a list of its own like this one: a
// folder made there without one inherits what ProgramData passes on, which is
// CREATOR OWNER (full control of what an account makes) and the Users' right to
// create files and folders in it and in every folder below it.
func updateRootSDDL(service string) string {
	return "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;" + sddlReadAndRun + ";;;" + serviceSID(service) + ")"
}

// privateDirectorySDDL is the security descriptor of a directory that is private to
// the account that makes it: that account (owner), SYSTEM and the Administrators
// have full control of it and of what is made in it, nothing is inherited into it,
// and nobody else gets anything. The agent's state directory is made with it; setup
// adds the agent's service when it registers the service (ServiceInstallFor).
func privateDirectorySDDL(account string) string {
	return "O:" + account + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + account + ")"
}

// privateDirectoryProblem says why a directory that only root may enter is
// open to someone else, or "": its owner must be root's, and no entry may give any
// account but root a right of any kind, even one that only passes to what is made
// in it later. aclProblem judges what an account can change; this judges what it
// can see. extra is one more account that passes, as for aclProblem.
func privateDirectoryProblem(owner string, hasACL bool, entries []aclEntry, extra string, name func(string) string) string {
	label := func(sid string) string {
		if name != nil {
			return name(sid)
		}
		return sid
	}
	root := func(sid string) bool {
		return sid == sidSystem || sid == sidAdministrators || sid == sidTrustedInstaller || (extra != "" && sid == extra)
	}
	switch {
	case !root(owner):
		return "belongs to " + label(owner) + ", not to SYSTEM or the Administrators"
	case !hasACL:
		return "has no access list, so everyone can enter it"
	}
	for _, entry := range entries {
		switch entry.Type {
		case aclAccessAllowed:
			// The entry for whichever account owns what is made in the directory is
			// no account of its own: that account is root, and is judged as such.
			if !root(entry.SID) && entry.SID != sidCreatorOwner && entry.Mask != 0 {
				return "can be entered by " + label(entry.SID)
			}
		case aclAccessDenied:
		default:
			return "has an access entry of a kind this check doesn't read (type " + strconv.Itoa(int(entry.Type)) + ")"
		}
	}
	return ""
}
