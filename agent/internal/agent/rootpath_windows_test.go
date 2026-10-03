//go:build windows

package agent

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// A test can't make SYSTEM or the Administrators own a tree it builds, so these
// tests build one under a temporary directory, give each directory and file an
// access list of their own, and trust the test's own account there
// (rootOwnedTrust). The decisions about access lists are also tested with plain
// values, on every platform (rootpath_acl_test.go).

func currentUserSID(t *testing.T) string {
	t.Helper()
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.String()
}

// setDACL replaces the access list of a path with the one sddl describes, and
// protects it from what its parent gives.
func setDACL(t *testing.T, path, sddl string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
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
}

// ownDACL is the access list of a directory or file the test owns: SYSTEM, the
// Administrators and the test's account, inherited by what is made in a
// directory, and then the entries in extra, which apply to the object alone.
func ownDACL(t *testing.T, directory bool, extra ...string) string {
	t.Helper()
	inherit := ""
	if directory {
		inherit = "OICI"
	}
	return "D:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)(A;" + inherit + ";FA;;;" + currentUserSID(t) + ")" + strings.Join(extra, "")
}

// ownTree is a directory the check starts inside, with the test's own account
// trusted below its temporary parent.
func ownTree(t *testing.T) string {
	t.Helper()
	base, err := finalDirectoryPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	trustTree(t, base)
	tree := filepath.Join(base, "tree")
	if err := os.Mkdir(tree, 0o755); err != nil {
		t.Fatal(err)
	}
	setDACL(t, tree, ownDACL(t, true))
	return tree
}

// trustTree makes the check start below root and trust this account there, until
// the test ends.
func trustTree(t *testing.T, root string) {
	t.Helper()
	old := rootOwnedTrust
	rootOwnedTrust = ownerTrust{sid: currentUserSID(t), anchor: root}
	t.Cleanup(func() { rootOwnedTrust = old })
}

// requireRootOwnedWriter skips a test that makes what only SYSTEM and the
// Administrators may use, when the test doesn't run elevated: its own account
// would be locked out of the directories it makes.
func requireRootOwnedWriter(t *testing.T) {
	t.Helper()
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("what root makes is closed to everyone but SYSTEM and the Administrators, so this test runs elevated")
	}
}

func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeText(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func refusedAs(t *testing.T, err error) *UpdateRefusal {
	t.Helper()
	var refusal *UpdateRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("got %v, want an UpdateRefusal", err)
	}
	if refusal.Code != "UNTRUSTED_LOCATION" {
		t.Fatalf("the code is %q, want UNTRUSTED_LOCATION", refusal.Code)
	}
	return refusal
}

func mustOpen(t *testing.T, path string, kind rootOwnedKind) *rootOwned {
	t.Helper()
	r, err := openRootOwned(path, kind)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

// policyTree is three directories and a file, as the update policy sits under
// its directories.
func policyTree(t *testing.T) (tree, file string) {
	t.Helper()
	tree = ownTree(t)
	mkdirAll(t, filepath.Join(tree, "a", "b", "c"))
	file = filepath.Join(tree, "a", "b", "c", "file")
	writeText(t, file, "good")
	return tree, file
}

func TestOpenRootOwnedHoldsTheTreeItChecked(t *testing.T) {
	_, file := policyTree(t)
	r := mustOpen(t, file, rootOwnedFile)
	if data, err := r.ReadFile(16); err != nil || string(data) != "good" {
		t.Fatalf("read %q, %v", data, err)
	}
	if data, err := r.ReadFile(16); err != nil || string(data) != "good" {
		t.Fatalf("a second read: %q, %v", data, err)
	}
	if _, err := r.ReadFile(2); !errors.Is(err, errRootOwnedTooLarge) {
		t.Fatalf("a read past its bound gave %v", err)
	}
	writeText(t, filepath.Join(filepath.Dir(file), "other"), "beside it")
	if data, err := r.ReadFileAt("other", 16); err != nil || string(data) != "beside it" {
		t.Fatalf("a file beside it: %q, %v", data, err)
	}
	dir := mustOpen(t, filepath.Dir(file), rootOwnedDirectory)
	if dir.File() != nil {
		t.Error("a directory path holds a file")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("a second Close: %v", err)
	}
}

func TestOpenRootOwnedRefusesAnAccountThatCanChangeTheHolderOrTheFile(t *testing.T) {
	tree, file := policyTree(t)
	holder := filepath.Dir(file)
	users, everyone := accountName(sidUsers), accountName(sidEveryone)
	for _, tc := range []struct {
		name      string
		path      string
		directory bool
		entry     string // an access entry for the path alone, in SDDL
		problem   string // what the check says, or "" when the path is accepted
	}{
		{"the holder is writable by Users", holder, true, "(A;;FW;;;BU)", "can be changed by " + users + " (write)"},
		{"the file is writable by Users", file, false, "(A;;FW;;;BU)", "can be changed by " + users + " (write)"},
		{"the file is writable by Everyone", file, false, "(A;;FA;;;WD)", "can be changed by " + everyone + " (write, delete, change permissions)"},
		{"the file is readable by Users", file, false, "(A;;FR;;;BU)", ""},
		{"a directory above the holder lets Users create", filepath.Join(tree, "a"), true, "(A;;FW;;;BU)", ""},
		{"a directory above the holder lets Users modify", filepath.Join(tree, "a"), true, "(A;;0x1301bf;;;BU)", "can be changed by " + users + " (delete)"},
		{"a directory above the holder lets Users delete a child", filepath.Join(tree, "a", "b"), true, "(A;;0x40;;;BU)", "can be changed by " + users + " (delete)"},
	} {
		setDACL(t, tc.path, ownDACL(t, tc.directory, tc.entry))
		held, err := openRootOwned(file, rootOwnedFile)
		if tc.problem == "" {
			if err != nil {
				t.Errorf("%s: %v", tc.name, err)
			} else {
				// A held path can't be removed with the temporary directory.
				held.Close()
			}
		} else if refusal := refusedAs(t, err); refusal.Detail != tc.path+" "+tc.problem {
			t.Errorf("%s: %q, want %q", tc.name, refusal.Detail, tc.path+" "+tc.problem)
		}
		setDACL(t, tc.path, ownDACL(t, tc.directory))
	}
	mustOpen(t, file, rootOwnedFile)
}

// What the path names must be what the caller asked for, and a link or alias is
// never followed, at any depth.
func TestOpenRootOwnedRefusesALinkAtEachDepth(t *testing.T) {
	tree, file := policyTree(t)
	for _, depth := range []string{"a", `a\b`, `a\b\c`} {
		link := filepath.Join(tree, depth)
		real := link + "-real"
		if err := os.Rename(link, real); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, real).CombinedOutput(); err != nil {
			t.Skipf("can't make a junction here: %v: %s", err, out)
		}
		_, err := openRootOwned(file, rootOwnedFile)
		if refusal := refusedAs(t, err); refusal.Detail != link+" is a symbolic link or a junction" {
			t.Errorf("a junction at %s: %q", depth, refusal.Detail)
		}
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(real, link); err != nil {
			t.Fatal(err)
		}
	}
	mustOpen(t, file, rootOwnedFile)

	// A link to the file, where the file should be.
	if err := os.Rename(file, file+"-real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(file+"-real", file); err != nil {
		t.Skipf("can't make a symbolic link here: %v", err)
	}
	_, err := openRootOwned(file, rootOwnedFile)
	if refusal := refusedAs(t, err); refusal.Detail != file+" is a symbolic link or a junction" {
		t.Errorf("a symbolic link to the file: %q", refusal.Detail)
	}
}

func TestOpenRootOwnedRefusesAnAliasOfTheDirectory(t *testing.T) {
	tree := ownTree(t)
	long := filepath.Join(tree, "a directory with a long name")
	mkdirAll(t, long)
	writeText(t, filepath.Join(long, "file"), "x")
	name, err := windows.UTF16PtrFromString(long)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, 32768)
	n, err := windows.GetShortPathName(name, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || n >= uint32(len(buf)) {
		t.Skipf("this file system has no 8.3 names: %v", err)
	}
	short := windows.UTF16ToString(buf[:n])
	if strings.EqualFold(short, long) {
		t.Skip("this file system has no distinct 8.3 name")
	}
	_, err = openRootOwned(filepath.Join(short, "file"), rootOwnedFile)
	if refusal := refusedAs(t, err); !strings.Contains(refusal.Detail, "is reached through another name") {
		t.Errorf("a short name: %q", refusal.Detail)
	}
	mustOpen(t, filepath.Join(long, "file"), rootOwnedFile)
}

func TestOpenRootOwnedSaysWhenSomethingIsMissingAndRefusesTheWrongKind(t *testing.T) {
	tree, file := policyTree(t)
	for _, path := range []string{filepath.Join(tree, "missing"), filepath.Join(tree, "a", "missing", "file"), filepath.Join(filepath.Dir(file), "missing")} {
		_, err := openRootOwned(path, rootOwnedFile)
		var refusal *UpdateRefusal
		if err == nil || errors.As(err, &refusal) || !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s: %v, want the not-exist error", path, err)
		}
	}
	_, err := openRootOwned(filepath.Dir(file), rootOwnedFile)
	if refusal := refusedAs(t, err); refusal.Detail != filepath.Dir(file)+" isn't a regular file (it is a directory)" {
		t.Errorf("a directory where a file is needed: %q", refusal.Detail)
	}
	_, err = openRootOwned(file, rootOwnedDirectory)
	if refusal := refusedAs(t, err); refusal.Detail != file+" isn't a directory (it is a file)" {
		t.Errorf("a file where a directory is needed: %q", refusal.Detail)
	}
	r := mustOpen(t, filepath.Dir(file), rootOwnedDirectory)
	if _, err := r.OpenAt("NUL"); err == nil {
		t.Error("a device was opened as a file")
	}
	// A device is opened in every directory by its name, with or without an
	// extension, so those names are refused before anything is opened.
	for _, name := range []string{"", ".", "..", `..\file`, "a/b", "a:stream", "a.", "a ", "a*b", "NUL", "con.json", "COM1", "lpt9.txt", strings.Repeat("n", 256)} {
		if _, err := r.OpenAt(name); err == nil {
			t.Errorf("OpenAt(%q) succeeded", name)
		}
		if err := r.WriteFile(name, []byte("x"), rootPrivate); err == nil {
			t.Errorf("WriteFile(%q) succeeded", name)
		}
	}
	for _, path := range []string{"", `relative\path`, `C:relative`, `\\server\share\dir`, `\\?\C:\Windows`, tree + `\`, tree + `\..\tree`, tree + `\\a`} {
		if _, err := openRootOwned(path, rootOwnedDirectory); err == nil {
			t.Errorf("%q was opened", path)
		}
	}
}

// Every directory of a held path, from the root of the drive down to the one that
// holds the object, is held with the right to list it and without delete sharing,
// so nothing that respects sharing (root included) can rename one of them, or move
// another directory into its place, while the value is open. A directory opened for
// its attributes and its access list alone would be outside sharing, and nothing
// would be refused; that is why the handles ask for the right to list.
func TestOpenRootOwnedHeldDirectoryCannotBeRenamedOrReplaced(t *testing.T) {
	tree, file := policyTree(t)
	holder := filepath.Dir(file)
	r := mustOpen(t, file, rootOwnedFile)
	for _, held := range []string{holder, filepath.Dir(holder), filepath.Join(tree, "a"), tree} {
		moved := held + "-moved"
		if err := os.Rename(held, moved); err == nil {
			t.Errorf("%s was renamed while the path was held", held)
			_ = os.Rename(moved, held)
		} else {
			t.Logf("renaming %s while it is held: %v", held, err)
		}
	}
	if data, err := r.ReadFile(16); err != nil || string(data) != "good" {
		t.Errorf("read after the attempts: %q, %v", data, err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	// Once the value is closed the directories are free again.
	if err := os.Rename(holder, holder+"-moved"); err != nil {
		t.Errorf("the directory can't be renamed after the path is closed: %v", err)
	}
}

func TestRootOwnedWriteFileMakesFilesOnlyRootChanges(t *testing.T) {
	requireRootOwnedWriter(t)
	tree := ownTree(t)
	dir, err := ensureRootOwnedDir(filepath.Join(tree, "updates"), rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	for _, perm := range []rootFilePerm{rootReadable, rootPrivate} {
		name := map[rootFilePerm]string{rootReadable: "readable.json", rootPrivate: "private.json"}[perm]
		if err := dir.WriteFile(name, []byte("first"), perm); err != nil {
			t.Fatal(err)
		}
		if err := dir.WriteFile(name, []byte("second"), perm); err != nil {
			t.Fatal(err)
		}
		if data, err := dir.ReadFileAt(name, 16); err != nil || string(data) != "second" {
			t.Errorf("%s: %q, %v", name, data, err)
		}
		accounts := daclOf(t, filepath.Join(tree, "updates", name))
		want := map[string]uint32{sidSystem: 0x1f01ff, sidAdministrators: 0x1f01ff}
		if perm == rootReadable {
			want[serviceSID("Vectory")] = 0x120089
		}
		if len(accounts) != len(want) {
			t.Errorf("%s: %v, want %v", name, accounts, want)
		}
		for sid, mask := range want {
			if accounts[sid] != mask {
				t.Errorf("%s: %s has %#x, want %#x", name, sid, accounts[sid], mask)
			}
		}
	}
	entries, err := os.ReadDir(filepath.Join(tree, "updates"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Errorf("a temporary file was left: %s", entry.Name())
		}
	}
	// The directory that was made has the access list setup gives the policy's.
	accounts := daclOf(t, filepath.Join(tree, "updates"))
	if accounts[sidSystem] != 0x1f01ff || accounts[sidAdministrators] != 0x1f01ff || accounts[serviceSID("Vectory")] != 0x120089 || len(accounts) != 3 {
		t.Errorf("the made directory: %v", accounts)
	}
	again, err := openRootOwned(filepath.Join(tree, "updates", "readable.json"), rootOwnedFile)
	if err != nil {
		t.Fatalf("what the check made, it accepts: %v", err)
	}
	again.Close()
}

// daclOf reads the access entries of a path as SID to rights.
func daclOf(t *testing.T, path string) map[string]uint32 {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		t.Fatalf("%s has no access list: %v", path, err)
	}
	accounts := map[string]uint32{}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			t.Fatal(err)
		}
		accounts[(*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()] |= uint32(ace.Mask)
	}
	return accounts
}

// The directories above the one that holds the object are the ones a default
// Windows install makes: a drive root, Program Files, Windows. They must pass
// the check as it ships, with no seam, or no host could take an update.
func TestTheDirectoriesAWindowsInstallStartsWithPassTheCheck(t *testing.T) {
	if rootOwnedTrust != (ownerTrust{}) {
		t.Fatal("a test left the path check's seam set: this test runs the check as it ships")
	}
	for _, path := range []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Common Files"),
		filepath.Join(os.Getenv("SystemRoot"), "System32"),
	} {
		r, err := openRootOwned(path, rootOwnedDirectory)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		r.Close()
	}
}

// The rights the path check names are the values the system defines for a file or a
// directory, so that what refuses a path is what Windows lets an account do.
func TestTheRightsThePathCheckNamesAreTheValuesTheSystemDefines(t *testing.T) {
	for name, pair := range map[string][2]uint32{
		"FILE_WRITE_DATA":       {rightWriteData, windows.FILE_WRITE_DATA},
		"FILE_APPEND_DATA":      {rightAppendData, windows.FILE_APPEND_DATA},
		"FILE_WRITE_EA":         {rightWriteEA, windows.FILE_WRITE_EA},
		"FILE_WRITE_ATTRIBUTES": {rightWriteAttributes, windows.FILE_WRITE_ATTRIBUTES},
		"DELETE":                {rightDelete, windows.DELETE},
		"WRITE_DAC":             {rightWriteDAC, windows.WRITE_DAC},
		"WRITE_OWNER":           {rightWriteOwner, windows.WRITE_OWNER},
		"GENERIC_ALL":           {rightGenericAll, windows.GENERIC_ALL},
		"GENERIC_WRITE":         {rightGenericWrite, windows.GENERIC_WRITE},
		// The package that carries the other values has no name for this one.
		"FILE_DELETE_CHILD": {rightDeleteChild, 0x40},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s is %#x here and %#x in the system's header", name, pair[0], pair[1])
		}
	}
}

// entriesOf reads the owner and the access entries of a descriptor the way readSecurity
// reads them from a handle.
func entriesOf(t *testing.T, sd *windows.SECURITY_DESCRIPTOR) (owner string, hasACL bool, entries []aclEntry) {
	t.Helper()
	if account, _, err := sd.Owner(); err == nil && account != nil {
		owner = account.String()
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return owner, false, nil
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, aclEntry{SID: (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String(), Type: ace.Header.AceType, Flags: ace.Header.AceFlags, Mask: uint32(ace.Mask)})
	}
	return owner, true, entries
}

// The lists the tests of the decision judge are written as descriptor text and read by
// a reader of their own on every platform; here Windows reads the same text, and must
// find the same owner and the same entries, or those tests judged something else.
func TestTheDescriptorTextOfTheListsIsReadByWindowsAsThePathCheckTestsReadIt(t *testing.T) {
	lists := map[string]string{
		"the update root":       updateRootSDDL(ServiceName),
		"a private directory":   privateDirectorySDDL(sidSomeUser),
		"the install directory": windowsSDDL(rootExecutable, true, ServiceName),
		"the install file":      windowsSDDL(rootExecutable, false, ServiceName),
		"a private file":        windowsSDDL(rootPrivate, false, ServiceName),
	}
	for name, sddl := range stockLists {
		lists[name] = sddl
	}
	for name, sddl := range lists {
		sd, err := windows.SecurityDescriptorFromString(sddl)
		if err != nil {
			t.Errorf("%s: Windows doesn't read %q: %v", name, sddl, err)
			continue
		}
		gotOwner, gotHas, got := entriesOf(t, sd)
		wantOwner, wantHas, want := parseSDDL(t, sddl)
		if gotOwner != wantOwner || gotHas != wantHas || len(got) != len(want) {
			t.Errorf("%s: Windows reads owner %q, access list %v, %d entries; the test reader reads %q, %v, %d", name, gotOwner, gotHas, len(got), wantOwner, wantHas, len(want))
			continue
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%s: entry %d is %+v for Windows and %+v for the test reader", name, i, got[i], want[i])
			}
		}
	}
}

// Setup's first look judges the part of a path that exists as the walk of the whole
// path will. On a machine that has no %ProgramData%\Vectory yet the nearest directory
// that exists is C:\ProgramData, which lets the Users create entries: it is above the
// directories that are made in it, and refused only when it is the one that holds
// what is made.
func TestTheFirstLookJudgesTheDirectoryThatExistsAsWhatIsAboveThePathThatDoesNot(t *testing.T) {
	tree := ownTree(t)
	above := filepath.Join(tree, "a")
	mkdirAll(t, above)
	setDACL(t, above, ownDACL(t, true, "(A;;FW;;;BU)"))
	target := filepath.Join(above, "b")
	if err := untrustedPrefix(target); err != nil {
		t.Errorf("a directory that lets the Users create entries, above a path that doesn't exist yet: %v", err)
	}
	if err := untrustedPrefix(filepath.Join(target, "c", "d")); err != nil {
		t.Errorf("the same, with two directories missing: %v", err)
	}
	users := accountName(sidUsers)
	if refusal := refusedAs(t, untrustedPrefix(above)); refusal.Detail != above+" can be changed by "+users+" (write)" {
		t.Errorf("that directory as the one that holds what is made: %q", refusal.Detail)
	}
	// Once the directory below it exists it is judged for every right to change it.
	mkdirAll(t, target)
	if err := untrustedPrefix(target); err != nil {
		t.Errorf("a directory made inside one that lets the Users create entries: %v", err)
	}
	setDACL(t, target, ownDACL(t, true, "(A;;FW;;;BU)"))
	if refusal := refusedAs(t, untrustedPrefix(target)); refusal.Detail != target+" can be changed by "+users+" (write)" {
		t.Errorf("the directory the path ends in, open to the Users: %q", refusal.Detail)
	}
	// What lets an account delete or take over what is in a directory above is refused.
	setDACL(t, target, ownDACL(t, true))
	setDACL(t, above, ownDACL(t, true, "(A;;0x40;;;BU)"))
	if refusal := refusedAs(t, untrustedPrefix(filepath.Join(target, "c"))); refusal.Detail != above+" can be changed by "+users+" (delete)" {
		t.Errorf("a directory above that lets the Users delete a child: %q", refusal.Detail)
	}
	// A file where a directory should be, and a path that isn't one, are refused as the walk refuses them.
	file := filepath.Join(tree, "file")
	writeText(t, file, "x")
	if refusal := refusedAs(t, untrustedPrefix(filepath.Join(file, "below"))); refusal.Detail != file+" isn't a directory (it is a file)" {
		t.Errorf("a file on the way: %q", refusal.Detail)
	}
	if err := untrustedPrefix(`relative\path`); err == nil {
		t.Error("a relative path was looked at")
	}
}

// Every directory the walk makes has a list of its own: the last the one its caller
// names, the ones above it the one the agent's service can read, and none takes what
// the directory that holds it passes on.
func TestEveryDirectoryTheWalkMakesHasAListOfItsOwn(t *testing.T) {
	requireRootOwnedWriter(t)
	tree := ownTree(t)
	dir, err := ensureRootOwnedDir(filepath.Join(tree, "x", "y", "z"), rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	dir.Close()
	requireOnlyRootAndThese(t, filepath.Join(tree, "x"), readableAccess())
	requireOnlyRootAndThese(t, filepath.Join(tree, "x", "y"), readableAccess())
	requireOnlyRootAndThese(t, filepath.Join(tree, "x", "y", "z"), privateAccess())
}

// The agent's state directory is made with the list that keeps it private at once,
// not with what its parent gives and then closed a moment later.
func TestAPrivateDirectoryIsMadeWithItsOwnersListAtOnce(t *testing.T) {
	tree := ownTree(t)
	user := currentUserSID(t)
	state := filepath.Join(tree, "state")
	if err := makePrivateDirectory(state); err != nil {
		t.Fatal(err)
	}
	requirePrivateToItsOwner(t, state, user)
	// One that is there is left as it is, and a file in its place is refused.
	if err := makePrivateDirectory(state); err != nil {
		t.Errorf("a second call: %v", err)
	}
	writeText(t, filepath.Join(tree, "file"), "x")
	if err := makePrivateDirectory(filepath.Join(tree, "file")); !errors.Is(err, syscall.ENOTDIR) {
		t.Errorf("a file where the directory should be: %v", err)
	}
	// PrivateDir makes what is above it with what its parent passes on, and the
	// directory as above; protect, which it runs afterwards, changes nothing.
	nested := filepath.Join(tree, "above", "private")
	if err := PrivateDir(nested); err != nil {
		t.Fatal(err)
	}
	requirePrivateToItsOwner(t, nested, user)
	if found := readDescriptor(t, filepath.Join(tree, "above")); found.protected {
		t.Errorf("a directory above a private one was closed: %+v", found)
	}
}

// requirePrivateToItsOwner checks the list of a directory made private to the account
// that made it: that account owns it, and it, SYSTEM and the Administrators are the
// only accounts with entries, each full control that passes to what is made in it,
// with nothing inherited.
func requirePrivateToItsOwner(t *testing.T, path, user string) {
	t.Helper()
	found := readDescriptor(t, path)
	if found.owner != user || !found.protected {
		t.Errorf("%s belongs to %s (protected: %v), want %s and a protected list", path, accountName(found.owner), found.protected, accountName(user))
	}
	got := map[string]aclEntry{}
	for _, entry := range found.entries {
		got[entry.SID] = entry
	}
	if len(got) != 3 {
		t.Errorf("%s: access entries %+v, want SYSTEM, the Administrators and its owner", path, found.entries)
	}
	for _, sid := range []string{sidSystem, sidAdministrators, user} {
		if e := got[sid]; e.Mask != fullControl || e.Flags&windows.INHERITED_ACE != 0 || e.Flags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE {
			t.Errorf("%s: the entry of %s is %+v, want full control that passes on to what is made in it", path, accountName(sid), e)
		}
	}
}

// The directory the agent is installed in, and the file that becomes the installed
// agent by a rename, are made with the lists of what root keeps programs in and the
// Administrators as owner, and what was made passes the path check as it ships.
func TestTheInstallDirectoryAndTheExecutableAreMadeWithTheListsOfWhatRootKeeps(t *testing.T) {
	requireRootOwnedWriter(t)
	base, err := finalDirectoryPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := rootOwnedTrust
	rootOwnedTrust = ownerTrust{anchor: base}
	t.Cleanup(func() { rootOwnedTrust = old })

	dir := filepath.Join(base, "Vectory")
	if err := makeInstallDirectory(dir); err != nil {
		t.Fatal(err)
	}
	requireOnlyRootAndThese(t, dir, executableAccess())
	temp, err := createInstallTemp(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := temp.WriteString("the agent"); err != nil {
		t.Fatal(err)
	}
	if err := temp.Close(); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.Base(temp.Name()), ".vectory-install-") {
		t.Errorf("the temporary file is called %s", temp.Name())
	}
	requireOnlyRootAndThese(t, temp.Name(), executableAccess())
	target := filepath.Join(dir, "vectory.exe")
	if err := replaceFile(temp.Name(), target); err != nil {
		t.Fatal(err)
	}
	requireOnlyRootAndThese(t, target, executableAccess())
	// The step trusts it: every component below the directory the test made passes with
	// nobody trusted but root.
	held := mustOpen(t, target, rootOwnedFile)
	if data, err := held.ReadFile(64); err != nil || string(data) != "the agent" {
		t.Errorf("read %q, %v", data, err)
	}
	// A directory that is there is left as it is, a file in its place is refused, and
	// what is missing above a new one is made.
	if err := makeInstallDirectory(dir); err != nil {
		t.Errorf("a directory that is there: %v", err)
	}
	if err := makeInstallDirectory(target); !errors.Is(err, syscall.ENOTDIR) {
		t.Errorf("a file where the directory should be: %v", err)
	}
	deeper := filepath.Join(base, "Acme", "Tools", "Vectory")
	if err := makeInstallDirectory(deeper); err != nil {
		t.Fatal(err)
	}
	requireOnlyRootAndThese(t, deeper, executableAccess())
}
