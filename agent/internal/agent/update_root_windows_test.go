//go:build windows

package agent

import (
	"errors"
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

// The update root is judged as strictly as what is below it: a path that reaches the
// policy or the step's files through a directory that the Users may add entries to is
// refused, because that is the directory a squatter makes the step's directories in
// first. Setup's first look lets it pass, because the walk that makes the directories
// closes it, and once it is closed the path passes.
func TestAPathThroughAnUpdateRootThatOthersCanAddToIsRefusedUntilItIsClosed(t *testing.T) {
	programData := programDataOfItsOwn(t)
	root := filepath.Join(programData, "Vectory")
	paths := UpdateLocations()
	made, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	made.Close()
	writeText(t, paths.Policy, "{}")
	// What ProgramData gives a new folder: the Users may create files and folders in it.
	setDACL(t, root, ownDACL(t, true, "(A;;0x116;;;BU)"))
	want := root + " can be changed by " + accountName(sidUsers) + " (write)"
	for _, path := range []string{paths.PolicyDir, paths.StepDir, paths.Private} {
		_, err := openRootOwned(path, rootOwnedDirectory)
		if refusal := refusedAs(t, err); refusal.Detail != want {
			t.Errorf("%s through an update root open to the Users: %q, want %q", path, refusal.Detail, want)
		}
	}
	_, err = openRootOwned(paths.Policy, rootOwnedFile)
	if refusal := refusedAs(t, err); refusal.Detail != want {
		t.Errorf("the policy through an update root open to the Users: %q, want %q", refusal.Detail, want)
	}
	if err := untrustedPrefix(paths.StepDir); err != nil {
		t.Errorf("setup's first look at an update root that is root's and open to the Users: %v", err)
	}
	again, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatalf("what makes the directories doesn't close the update root: %v", err)
	}
	again.Close()
	requireClosedRoot(t, root)
	mustOpen(t, paths.Policy, rootOwnedFile)
}

// Whatever makes %ProgramData%\Vectory first makes it closed. The agent's state
// directory and its managed configuration are made in it, before the policy and the
// step's directories, so a root that was made with what ProgramData gives a new folder
// would be open to a squatter until the policy was written.
func TestTheStateDirectoryMakesTheUpdateRootClosedWhenItIsTheFirstToMakeIt(t *testing.T) {
	programData := programDataOfItsOwn(t)
	root := filepath.Join(programData, "Vectory")
	state := filepath.Join(root, "agent")
	if err := PrivateDir(state); err != nil {
		t.Fatal(err)
	}
	requireClosedRoot(t, root)
	if owner := readDescriptor(t, root).owner; owner != sidAdministrators {
		t.Errorf("the update root that the state directory made belongs to %s, want the Administrators", accountName(owner))
	}
	requirePrivateToItsOwner(t, state, currentUserSID(t))
	managed := filepath.Join(root, "managed")
	if err := PrivateDir(managed); err != nil {
		t.Fatal(err)
	}
	requireClosedRoot(t, root)
	requirePrivateToItsOwner(t, managed, currentUserSID(t))
	// The step's directories are made below it, and everything passes the path check.
	dir, err := ensureRootOwnedDir(UpdateLocations().Private, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	dir.Close()
	mustOpen(t, UpdateLocations().Private, rootOwnedDirectory)
	// A directory that isn't the update root is made with what its parent passes on.
	other := filepath.Join(programData, "Elsewhere")
	if err := PrivateDir(filepath.Join(other, "agent")); err != nil {
		t.Fatal(err)
	}
	if found := readDescriptor(t, other); found.protected {
		t.Errorf("a directory above a private one that isn't the update root was closed: %+v", found)
	}
}

// The directory the agent's state directory is kept in is judged by whatever makes the
// state directory, for every install (state_root.go). The tests below make it the ways
// a host can have it: not there, root's and open to others, and another account's. A
// test can't make SYSTEM or the Administrators own a tree it builds, and it can't make a
// second user, so "another account" is the account that runs the test, which these
// tests tell the check not to trust: it is another account as far as the check goes.
// What a real second account sees is the Windows job's to show.

// waysToMakeTheStateDirectory is each entry point that makes something the agent keeps
// in the update root, for a root as the test names it.
var waysToMakeTheStateDirectory = map[string]func(root string) error{
	"PrivateDir for the state directory":       func(root string) error { return PrivateDir(filepath.Join(root, "agent")) },
	"createFreshStateDirectory":                func(root string) error { return createFreshStateDirectory(filepath.Join(root, "agent")) },
	"PrivateDir for the managed configuration": func(root string) error { return PrivateDir(filepath.Join(root, "managed")) },
	"PrivateDir below the state directory":     func(root string) error { return PrivateDir(filepath.Join(root, "agent", "updates", "incoming")) },
}

// programDataWhereNoOneIsRoot gives the test a ProgramData of its own where the account
// that runs it is not root. The process is elevated, as it has to be for the code to
// judge a directory at all: a process that isn't leaves it alone.
func programDataWhereNoOneIsRoot(t *testing.T) string {
	t.Helper()
	requireRootOwnedWriter(t)
	if rootAccount(currentUserSID(t), "") {
		t.Skip("the account that runs the test is SYSTEM, the Administrators or TrustedInstaller, so no directory it owns is another account's")
	}
	programData, err := finalDirectoryPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := rootOwnedTrust
	rootOwnedTrust = ownerTrust{anchor: programData}
	t.Cleanup(func() { rootOwnedTrust = old })
	t.Setenv("ProgramData", programData)
	return programData
}

// makeSquattedRoot makes %ProgramData%\Vectory as an account that isn't root would: the
// account that runs the test owns it, with the entries of SYSTEM and the Administrators
// and its own.
func makeSquattedRoot(t *testing.T, programData string) string {
	t.Helper()
	root := filepath.Join(programData, "Vectory")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := protect(root, true); err != nil {
		t.Fatal(err)
	}
	return root
}

// factsOfDirectory reads a directory the way the code under test does, for an
// elevated process, so that a test can hold the decision to what is on the disk.
func factsOfDirectory(t *testing.T, root string) stateRootFacts {
	t.Helper()
	found := readDescriptor(t, root)
	return stateRootFacts{Kept: true, Elevated: true, Exists: true, Owner: found.owner, HasACL: true, Entries: found.entries, Extra: rootOwnedTrust.sid}
}

// An update root that root owns and that another account can add to (what ProgramData
// gives a new folder) is closed by whatever makes the state directory, with updates on
// or not, and the agent's service keeps the right to list it.
func TestMakingTheStateDirectoryClosesAnUpdateRootThatIsRootsAndOpenToOthers(t *testing.T) {
	for name, act := range waysToMakeTheStateDirectory {
		t.Run(name, func(t *testing.T) {
			programData := programDataOfItsOwn(t)
			root := filepath.Join(programData, "Vectory")
			if err := os.Mkdir(root, 0o755); err != nil {
				t.Fatal(err)
			}
			setDACL(t, root, ownDACL(t, true, "(A;;0x1301bf;;;BU)"))
			if got := factsOfDirectory(t, root).decide(); got != stateRootClose {
				t.Fatalf("the directory the test made is judged %d, want it closed (%d)", got, stateRootClose)
			}
			if err := act(root); err != nil {
				t.Fatal(err)
			}
			requireClosedRoot(t, root)
			if got := factsOfDirectory(t, root).decide(); got != stateRootKeep {
				t.Errorf("what was closed is judged %d, want it kept (%d)", got, stateRootKeep)
			}
		})
	}
}

// An update root that isn't there is made closed, owned by the Administrators, by each
// way of making the state directory.
func TestMakingTheStateDirectoryMakesTheUpdateRootClosedWhateverMakesIt(t *testing.T) {
	for name, act := range waysToMakeTheStateDirectory {
		t.Run(name, func(t *testing.T) {
			programData := programDataOfItsOwn(t)
			root := filepath.Join(programData, "Vectory")
			if err := act(root); err != nil {
				t.Fatal(err)
			}
			requireClosedRoot(t, root)
			if owner := readDescriptor(t, root).owner; owner != sidAdministrators {
				t.Errorf("the update root belongs to %s, want the Administrators", accountName(owner))
			}
		})
	}
}

// An update root that another account owns is refused by name, by every way of making
// the state directory, and nothing is made in it and nothing about it is changed.
func TestMakingTheStateDirectoryRefusesAnUpdateRootThatAnotherAccountOwns(t *testing.T) {
	programData := programDataWhereNoOneIsRoot(t)
	root := makeSquattedRoot(t, programData)
	if got := factsOfDirectory(t, root).decide(); got != stateRootRefuse {
		t.Fatalf("the directory the test made is judged %d, want it refused (%d)", got, stateRootRefuse)
	}
	before := readDescriptor(t, root)
	owner := accountName(currentUserSID(t))
	for name, act := range waysToMakeTheStateDirectory {
		err := act(root)
		var refusal *stateRootError
		if !errors.As(err, &refusal) || refusal.Path != root || refusal.Owner != owner {
			t.Errorf("%s: %v, want a refusal of %s that names %s", name, err, root, owner)
			continue
		}
		if detail, _ := refusal.words(); !strings.Contains(detail, root+" belongs to "+owner+", not to SYSTEM or the Administrators") {
			t.Errorf("%s: the refusal says %q", name, detail)
		}
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Errorf("something was made in the directory another account owns: %v, %v", entries, err)
	}
	after := readDescriptor(t, root)
	if after.owner != before.owner || after.protected != before.protected || len(after.entries) != len(before.entries) {
		t.Errorf("the directory another account owns was changed: %+v, then %+v", before, after)
	}
	for i := range before.entries {
		if before.entries[i] != after.entries[i] {
			t.Errorf("entry %d changed from %+v to %+v", i, before.entries[i], after.entries[i])
		}
	}
}

// A state directory that isn't kept in the update root needs none of it: a custom
// --state-dir is made as it always was, however the update root stands.
func TestAStateDirectoryOutsideTheUpdateRootNeedsNoneOfIt(t *testing.T) {
	programData := programDataWhereNoOneIsRoot(t)
	root := makeSquattedRoot(t, programData)
	before := readDescriptor(t, root)
	for _, state := range []string{
		filepath.Join(programData, "Elsewhere", "agent"),
		filepath.Join(programData, "VectoryState", "agent"),
	} {
		if err := PrivateDir(state); err != nil {
			t.Errorf("%s: %v", state, err)
		}
		if err := createFreshStateDirectory(filepath.Join(filepath.Dir(state), "fresh")); err != nil {
			t.Errorf("a fresh state directory beside %s: %v", state, err)
		}
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Errorf("something was made in the update root: %v, %v", entries, err)
	}
	if after := readDescriptor(t, root); after.owner != before.owner || len(after.entries) != len(before.entries) {
		t.Errorf("the update root was changed: %+v, then %+v", before, after)
	}
}

// An earlier layout kept the agent's state in %ProgramData%\Vectory itself, which is
// private to the account that owns it, and is left alone.
func TestAnUpdateRootThatIsAnInstalledStateDirectoryIsLeftAlone(t *testing.T) {
	programData := programDataWhereNoOneIsRoot(t)
	root := makeSquattedRoot(t, programData)
	writeText(t, filepath.Join(root, "settings.json"), "{}")
	before := readDescriptor(t, root)
	if err := PrivateDir(filepath.Join(root, "validation")); err != nil {
		t.Fatal(err)
	}
	if err := stateRootProblem(filepath.Join(root, "validation"), true); err != nil {
		t.Errorf("setup's first look at a state directory that is the update root: %v", err)
	}
	if after := readDescriptor(t, root); after.owner != before.owner || after.protected != before.protected || len(after.entries) != len(before.entries) {
		t.Errorf("an installed state directory was changed: %+v, then %+v", before, after)
	}
}

// Setup's first look says what the change would refuse, and changes nothing. A process
// that can't write what root owns refuses nothing.
func TestSetupsFirstLookNamesAnUpdateRootThatAnotherAccountOwnsAndChangesNothing(t *testing.T) {
	programData := programDataWhereNoOneIsRoot(t)
	state := filepath.Join(programData, "Vectory", "agent")
	if err := stateRootProblem(state, true); err != nil {
		t.Errorf("an update root that isn't there: %v", err)
	}
	root := makeSquattedRoot(t, programData)
	before := readDescriptor(t, root)
	owner := accountName(currentUserSID(t))
	err := stateRootProblem(state, true)
	var refusal *stateRootError
	if !errors.As(err, &refusal) || refusal.Path != root || refusal.Owner != owner {
		t.Fatalf("%v, want a refusal of %s that names %s", err, root, owner)
	}
	if err := stateRootProblem(state, false); err != nil {
		t.Errorf("a process that can't write what root owns: %v", err)
	}
	if err := stateRootProblem(filepath.Join(programData, "Elsewhere", "agent"), true); err != nil {
		t.Errorf("a custom state directory: %v", err)
	}
	// What setup asks of the host, the way the host answers it.
	host := serviceHost{elevated: func() bool { return true }}
	for _, change := range []bool{false, true} {
		if err := host.checkStateRoot(state, change); !errors.As(err, &refusal) || refusal.Owner != owner {
			t.Errorf("setup's host, change %v: %v", change, err)
		}
	}
	if err := (serviceHost{elevated: func() bool { return false }}).checkStateRoot(state, false); err != nil {
		t.Errorf("setup's look from a process that isn't elevated: %v", err)
	}
	if after := readDescriptor(t, root); after.owner != before.owner || len(after.entries) != len(before.entries) {
		t.Errorf("the look changed the directory: %+v, then %+v", before, after)
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Errorf("something was made in the directory: %v, %v", entries, err)
	}
}

// Root's directory that is open to others is no problem for the first look: setup closes it.
func TestSetupsFirstLookLetsAnUpdateRootThatIsRootsAndOpenPass(t *testing.T) {
	programData := programDataOfItsOwn(t)
	root := filepath.Join(programData, "Vectory")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	setDACL(t, root, ownDACL(t, true, "(A;;0x1301bf;;;BU)"))
	before := readDescriptor(t, root)
	if err := stateRootProblem(filepath.Join(root, "agent"), true); err != nil {
		t.Errorf("an update root that is root's and open: %v", err)
	}
	if after := readDescriptor(t, root); len(after.entries) != len(before.entries) {
		t.Errorf("the look changed the directory: %+v, then %+v", before, after)
	}
}
