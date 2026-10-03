//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Squatting: C:\ProgramData lets every account make entries, so the directory the
// update directories are made in is closed to everyone but root before either is
// made. These tests do it in a ProgramData of their own; the ones that make what only
// root may use run elevated, as the Windows job does.

func TestTheUpdateRootIsTheDirectoryBothUpdateDirectoriesAreMadeIn(t *testing.T) {
	programData := `C:\ProgramData`
	t.Setenv("ProgramData", programData)
	for path, want := range map[string]bool{
		`C:\ProgramData\Vectory`:                             true,
		`C:\ProgramData\Vectory\updates`:                     true,
		`C:\ProgramData\Vectory\update-state`:                true,
		`C:\ProgramData\Vectory\update-state\private\helper`: true,
		`c:\programdata\vectory\UPDATES\policy.json`:         true,
		// the agent's own state directory is the agent's, not the step's
		`C:\ProgramData\VectoryState`:       false,
		`C:\ProgramData\Vectory-other`:      false,
		`C:\ProgramData`:                    false,
		`C:\Program Files\Vectory`:          false,
		`D:\ProgramData\Vectory\updates`:    false,
		`C:\ProgramData\Other\update-state`: false,
		``:                                  false,
	} {
		root, ok := updateRootFor(path)
		if ok != want || (ok && !strings.EqualFold(root, `C:\ProgramData\Vectory`)) {
			t.Errorf("updateRootFor(%q) = %q, %v; want %v", path, root, ok, want)
		}
	}
	// A test that moves the locations builds a tree of its own, and the root is not closed.
	moved := newUpdatePaths(`C:\somewhere\policy`, `C:\somewhere\step`, true)
	old := updateLocationsOverride
	updateLocationsOverride = &moved
	t.Cleanup(func() { updateLocationsOverride = old })
	if root, ok := updateRootFor(`C:\somewhere\step`); ok {
		t.Errorf("a moved location was taken for the update root: %q", root)
	}
}

func TestRootAccountIsSYSTEMTheAdministratorsAndTrustedInstaller(t *testing.T) {
	for sid, want := range map[string]bool{
		sidSystem: true, sidAdministrators: true, sidTrustedInstaller: true,
		sidUsers: false, sidEveryone: false, serviceSID(ServiceName): false, "": false,
	} {
		if got := rootAccount(sid, ""); got != want {
			t.Errorf("rootAccount(%q) = %v", sid, got)
		}
	}
	if !rootAccount(sidUsers, sidUsers) || rootAccount("", "") {
		t.Error("the one more account a test trusts isn't the account it named")
	}
}

// programDataOfItsOwn gives the test a ProgramData of its own, and trusts the account
// that runs it below it, as the other tests of the path check do.
func programDataOfItsOwn(t *testing.T) string {
	t.Helper()
	requireRootOwnedWriter(t)
	programData, err := finalDirectoryPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	trustTree(t, programData)
	t.Setenv("ProgramData", programData)
	return programData
}

// requireClosedRoot checks the access list of the update root: protected from what
// ProgramData gives, SYSTEM and the Administrators with full control that passes to
// what is made in it, and the agent's service with the right to list and read it
// alone. The owner is root's; the one that setup makes is the Administrators.
func requireClosedRoot(t *testing.T, path string) {
	t.Helper()
	found := readDescriptor(t, path)
	if !rootAccount(found.owner, currentUserSID(t)) || !found.protected {
		t.Errorf("%s belongs to %s (protected: %v), want root and a protected list", path, accountName(found.owner), found.protected)
	}
	got := map[string]aclEntry{}
	for _, entry := range found.entries {
		got[entry.SID] = entry
	}
	if len(got) != 3 {
		t.Errorf("%s: access entries %+v, want SYSTEM, the Administrators and the agent's service", path, found.entries)
	}
	for _, sid := range []string{sidSystem, sidAdministrators} {
		if e := got[sid]; e.Mask != fullControl || e.Flags&windows.INHERITED_ACE != 0 || e.Flags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE) != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE {
			t.Errorf("%s: the entry of %s is %+v, want full control that passes to what is made in it", path, accountName(sid), e)
		}
	}
	// The agent's service may list and read the directory (its own are below it) and
	// nothing it is given passes on.
	if e := got[serviceSID(ServiceName)]; e.Mask != 0x1200a9 || e.Flags != 0 {
		t.Errorf("%s: the entry of the agent's service is %+v, want read and run, applying to the directory alone", path, e)
	}
}

func TestSetupMakesTheUpdateRootClosedBeforeAnythingElse(t *testing.T) {
	programData := programDataOfItsOwn(t)
	root := filepath.Join(programData, "Vectory")
	private := UpdateLocations().Private
	if !strings.EqualFold(filepath.Dir(filepath.Dir(private)), root) {
		t.Fatalf("the private directory %s isn't two below %s", private, root)
	}
	dir, err := ensureRootOwnedDir(private, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	requireClosedRoot(t, root)
	if owner := readDescriptor(t, root).owner; owner != sidAdministrators {
		t.Errorf("the update root that setup made belongs to %s, want the Administrators", accountName(owner))
	}
	// What was made below it is judged as the path check judges it, and passes.
	again, err := openRootOwned(private, rootOwnedDirectory)
	if err != nil {
		t.Fatalf("what setup made doesn't pass the check: %v", err)
	}
	again.Close()
}

// A directory made earlier by whatever ProgramData gives a new folder, which lets
// the Users add entries to it, is closed: it is root's, and it is open to a squatter.
func TestAnUpdateRootThatIsRootsAndOpenToOthersIsClosed(t *testing.T) {
	programData := programDataOfItsOwn(t)
	root := filepath.Join(programData, "Vectory")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	setDACL(t, root, ownDACL(t, true, "(A;;0x1301bf;;;BU)"))
	before := readDescriptor(t, root)
	if len(before.entries) < 4 {
		t.Fatalf("the directory isn't open to the Users: %+v", before.entries)
	}
	dir, err := ensureRootOwnedDir(UpdateLocations().Private, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	requireClosedRoot(t, root)
}

// A directory that is already closed is left as it is, and so is a second call.
func TestAnUpdateRootThatIsClosedIsLeftAlone(t *testing.T) {
	programData := programDataOfItsOwn(t)
	root := filepath.Join(programData, "Vectory")
	if err := closeDirectoryToOthers(root, updateRootSDDL(ServiceName)); err != nil {
		t.Fatal(err)
	}
	requireClosedRoot(t, root)
	before := readDescriptor(t, root)
	if err := closeDirectoryToOthers(root, updateRootSDDL(ServiceName)); err != nil {
		t.Fatal(err)
	}
	after := readDescriptor(t, root)
	if before.owner != after.owner || len(before.entries) != len(after.entries) {
		t.Errorf("a closed directory was changed: %+v, then %+v", before, after)
	}
	for i := range before.entries {
		if before.entries[i] != after.entries[i] {
			t.Errorf("entry %d changed from %+v to %+v", i, before.entries[i], after.entries[i])
		}
	}
}

// Directories that aren't the update root are never changed by the check that closes
// it: what is below the policy directory and the step's directory is judged, not
// closed, so that a directory somebody else made there is refused and not taken over.
func TestOnlyTheUpdateRootIsClosedAndWhatIsBelowItIsJudged(t *testing.T) {
	programData := programDataOfItsOwn(t)
	other := filepath.Join(programData, "Elsewhere")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatal(err)
	}
	setDACL(t, other, ownDACL(t, true, "(A;;0x1301bf;;;BU)"))
	before := readDescriptor(t, other)
	dir, err := ensureRootOwnedDir(filepath.Join(other, "update-state", "private"), rootPrivate)
	if err == nil {
		dir.Close()
		t.Error("a directory that Users can modify was accepted as a place for the step")
	} else {
		refusedAs(t, err)
	}
	after := readDescriptor(t, other)
	if len(before.entries) != len(after.entries) {
		t.Errorf("a directory outside the update root was changed: %+v, then %+v", before.entries, after.entries)
	}
}
