//go:build windows

package agent

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
		_, err := openRootOwned(file, rootOwnedFile)
		if tc.problem == "" {
			if err != nil {
				t.Errorf("%s: %v", tc.name, err)
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
	for _, name := range []string{"", ".", "..", `..\file`, "a/b", "a:stream", "a.", "a ", "a*b", strings.Repeat("n", 256)} {
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

// The directories of a held path can't be renamed while the value is open: the
// handles are held without delete sharing.
func TestOpenRootOwnedHeldDirectoryCannotBeRenamedOrReplaced(t *testing.T) {
	tree, file := policyTree(t)
	holder := filepath.Dir(file)
	r := mustOpen(t, file, rootOwnedFile)
	if err := os.Rename(holder, holder+"-moved"); err == nil {
		t.Error("the held directory was renamed")
	}
	if err := os.Rename(filepath.Join(tree, "a", "b"), filepath.Join(tree, "a", "b-moved")); err == nil {
		t.Log("a directory above the held one was renamed; the handle still refers to what was checked")
	}
	if data, err := r.ReadFile(16); err != nil || string(data) != "good" {
		t.Errorf("read after the attempts: %q, %v", data, err)
	}
}

func TestRootOwnedWriteFileMakesFilesOnlyRootChanges(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("what root makes is closed to everyone but SYSTEM and the Administrators, so this test runs elevated")
	}
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
