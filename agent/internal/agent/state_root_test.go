package agent

import (
	"strings"
	"testing"
)

// What is done with %ProgramData%\Vectory when the agent's state directory is made
// in it is decided on plain values, so that every platform judges it: the directory
// that holds the agent's own directories is made closed when it isn't there, closed
// when it is root's and open, refused when another account owns it, and left to the
// path check when the state directory is somewhere else. The lists below are written
// as the text Windows prints for them (SDDL).

const (
	stateRootPath = `C:\ProgramData\Vectory`
	// windowsServiceName is the name of the agent's service on Windows. ServiceName is
	// the running system's own, which only a Windows build names this.
	windowsServiceName = "Vectory"
)

// windowsParent is the directory above a Windows path, written with the separator
// Windows uses whatever the host that runs the test.
func windowsParent(path string) string { return path[:strings.LastIndex(path, `\`)] }

func TestTheUpdateRootIsWhereTheAgentKeepsItsOwnDirectories(t *testing.T) {
	if windowsUpdateRoot("") != stateRootPath {
		t.Errorf("the update root of a host with no ProgramData variable is %q", windowsUpdateRoot(""))
	}
	for _, programData := range []string{"", `C:\ProgramData`, `C:\ProgramData\`, `D:\Data\`, `D:/Data/`} {
		root := windowsUpdateRoot(programData)
		paths := defaultPathsFor("windows", programData, "")
		update := updateLocationsFor("windows", programData)
		for name, path := range map[string]string{
			"the state directory":                 paths.StateDir,
			"the directory of the managed config": windowsParent(paths.ManagedConfig),
			"the update policy's directory":       update.PolicyDir,
			"the update step's directory":         update.StepDir,
		} {
			if got := windowsParent(path); got != root {
				t.Errorf("ProgramData %q: %s is in %q, not in the update root %q", programData, name, got, root)
			}
		}
	}
}

func TestWhichStatePathsAreKeptInTheUpdateRoot(t *testing.T) {
	for _, tc := range []struct {
		name string
		path string
		kept bool
	}{
		{"the default state directory", stateRootPath + `\agent`, true},
		{"the directory of the default managed configuration", stateRootPath + `\managed`, true},
		{"a directory below the state directory", stateRootPath + `\agent\updates\incoming\x`, true},
		{"the same path spelled in other letters", `c:\programdata\VECTORY\Agent`, true},
		{"something directly below the root, whatever else is in the root", stateRootPath + `\validation`, true},
		{"a custom state directory elsewhere on the drive", `C:\Agent\state`, false},
		{"a custom state directory in ProgramData but not in the update root", `C:\ProgramData\Acme\agent`, false},
		{"a folder whose name only starts like the update root's", `C:\ProgramData\VectoryState\agent`, false},
		{"another drive's ProgramData", `D:\ProgramData\Vectory\agent`, false},
		{"a person's own folder", `C:\Users\alice\AppData\Local\Vectory\agent`, false},
		{"the update root itself, as the state directory", stateRootPath, false},
	} {
		if got := stateRootKept(tc.path, stateRootPath); got != tc.kept {
			t.Errorf("%s: kept in the update root is %v, want %v", tc.name, got, tc.kept)
		}
	}
}

func TestWhichAccountsAreRoot(t *testing.T) {
	for sid, want := range map[string]bool{
		sidSystem: true, sidAdministrators: true, sidTrustedInstaller: true,
		sidUsers: false, sidEveryone: false, sidAuthenticatedUsers: false, serviceSID(windowsServiceName): false, sidSomeUser: false, "": false,
	} {
		if got := rootAccount(sid, ""); got != want {
			t.Errorf("rootAccount(%q) = %v", sid, got)
		}
	}
	if !rootAccount(sidSomeUser, sidSomeUser) || rootAccount("", "") || rootAccount("", sidSomeUser) {
		t.Error("the one more account a test trusts isn't the account it named, or an empty owner passed")
	}
}

// factsOf reads a descriptor the way the path check reads one from a handle.
func factsOf(t *testing.T, sddl string, base stateRootFacts) stateRootFacts {
	t.Helper()
	base.Exists = true
	base.Owner, base.HasACL, base.Entries = parseSDDL(t, sddl)
	return base
}

func TestTheDecisionForTheDirectoryThatHoldsTheStateDirectory(t *testing.T) {
	const adminAccount = "BA"
	quiet := "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	serviceOwner := "O:" + serviceSID(windowsServiceName) + quiet
	type testCase struct {
		name  string
		facts stateRootFacts
		want  stateRootAction
	}
	elevated := stateRootFacts{Kept: true, Elevated: true}
	var cases []testCase
	add := func(name, sddl string, base stateRootFacts, want stateRootAction) {
		cases = append(cases, testCase{name, factsOf(t, sddl, base), want})
	}
	// A folder an elevated administrator makes in ProgramData and an unprivileged user
	// makes there inherit what ProgramData passes on: the Users may create in it, and
	// whoever made it has full control (CREATOR OWNER becomes that account).
	rootsInherited := "O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;CIID;LC;;;BU)(A;CIID;DC;;;BU)(A;OICIIOID;FA;;;CO)"
	squatted := "O:" + sidSomeUser + "D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;" + sidSomeUser + ")(A;OICIID;0x1200a9;;;BU)(A;CIID;LC;;;BU)(A;CIID;DC;;;BU)"

	// What the step's own directories are made in, as it makes it: nothing to do.
	add("closed, as setup makes it", updateRootSDDL(windowsServiceName), elevated, stateRootKeep)
	add("closed and owned by SYSTEM", "O:SY"+quiet, elevated, stateRootKeep)
	add("closed and owned by TrustedInstaller", "O:"+sidTrustedInstaller+quiet, elevated, stateRootKeep)
	add("closed, and the Users may read and run it", "O:"+adminAccount+quiet+"(A;;0x1200a9;;;BU)", elevated, stateRootKeep)
	// Root's, and another account can add to it or change it: its list is replaced.
	add("root's, with what ProgramData gives a new folder", rootsInherited, elevated, stateRootClose)
	add("root's, and the Users may modify it", "O:"+adminAccount+quiet+"(A;;0x1301bf;;;BU)", elevated, stateRootClose)
	add("root's, and the Users may create files in it", "O:"+adminAccount+quiet+"(A;;0x2;;;BU)", elevated, stateRootClose)
	add("root's, and Everyone may delete what is in it", "O:"+adminAccount+quiet+"(A;;0x40;;;WD)", elevated, stateRootClose)
	add("root's, with no access list", "O:BAD:NO_ACCESS_CONTROL", elevated, stateRootClose)
	// Another account's: refused, whatever its list says, because the owner holds the
	// right to change the list.
	add("another account's, with what ProgramData gives a folder an account makes", squatted, elevated, stateRootRefuse)
	add("another account's, with a list that looks closed", "O:"+sidSomeUser+quiet, elevated, stateRootRefuse)
	add("the Users'", "O:BU"+quiet, elevated, stateRootRefuse)
	add("Everyone's", "O:WD"+quiet, elevated, stateRootRefuse)
	add("the agent's own service's", serviceOwner, elevated, stateRootRefuse)
	add("nobody's", quiet, elevated, stateRootRefuse)
	// The one more account a test trusts counts as root, for ownership and for entries.
	trusting := stateRootFacts{Kept: true, Elevated: true, Extra: sidSomeUser}
	add("a trusted account's, closed", "O:"+sidSomeUser+"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;"+sidSomeUser+")", trusting, stateRootKeep)
	add("a trusted account's, with what ProgramData gives it", squatted, trusting, stateRootClose)

	for _, tc := range cases {
		if got := tc.facts.decide(); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}

	// It isn't there: it is made closed.
	if got := elevated.decide(); got != stateRootMake {
		t.Errorf("a root that isn't there: %d, want it made", got)
	}
	// A state directory that isn't kept there needs none of it, whatever stands in the
	// way and whether or not the directory is there.
	for name, facts := range map[string]stateRootFacts{
		"a custom state directory, with another account's directory there": factsOf(t, squatted, stateRootFacts{Elevated: true}),
		"a custom state directory, with root's open directory there":       factsOf(t, rootsInherited, stateRootFacts{Elevated: true}),
		"a custom state directory, with no directory":                      {Elevated: true},
	} {
		if got := facts.decide(); got != stateRootUntouched {
			t.Errorf("%s: %d, want it left alone", name, got)
		}
	}
	// A process that isn't elevated can't make the Administrators the owner or change
	// what root owns, and may be a person's foreground agent that keeps its own directory
	// there: it does what it did before, and leaves every answer to the path check.
	notElevated := stateRootFacts{Kept: true}
	for name, facts := range map[string]stateRootFacts{
		"no directory":                        notElevated,
		"root's closed directory":             factsOf(t, updateRootSDDL(windowsServiceName), notElevated),
		"root's open directory":               factsOf(t, rootsInherited, notElevated),
		"a directory another account owns":    factsOf(t, squatted, notElevated),
		"a directory the process itself owns": factsOf(t, squatted, stateRootFacts{Kept: true, Extra: sidSomeUser}),
	} {
		if got := facts.decide(); got != stateRootUntouched {
			t.Errorf("a process that isn't elevated, %s: %d, want it left alone", name, got)
		}
	}
}

// The list that closes the directory keeps the agent's service able to list and read
// it: the service can't change a list, and it reaches its own directories through this
// one. Nothing the service is given passes on, and nothing it is given writes.
func TestTheListThatClosesTheUpdateRootKeepsTheAgentsServiceAbleToListIt(t *testing.T) {
	owner, hasACL, entries := parseSDDL(t, updateRootSDDL(windowsServiceName))
	if owner != sidAdministrators || !hasACL {
		t.Fatalf("owner %q, access list %v", owner, hasACL)
	}
	if !strings.Contains(updateRootSDDL(windowsServiceName), "D:P(") {
		t.Error("the list isn't protected from what ProgramData passes on")
	}
	got := map[string]aclEntry{}
	for _, entry := range entries {
		got[entry.SID] = entry
	}
	if len(got) != 3 {
		t.Fatalf("entries %+v, want SYSTEM, the Administrators and the agent's service", entries)
	}
	for _, sid := range []string{sidSystem, sidAdministrators} {
		if want := (aclEntry{SID: sid, Type: aclAccessAllowed, Flags: inheritObject | inheritContainer, Mask: maskFull}); got[sid] != want {
			t.Errorf("the entry of %s is %+v, want %+v", sid, got[sid], want)
		}
	}
	service := got[serviceSID(windowsServiceName)]
	if service.Mask != maskReadRun || service.Flags != 0 || service.Type != aclAccessAllowed {
		t.Errorf("the agent's service has %+v, want read and run on the directory alone", service)
	}
	if aclProblem(owner, hasACL, entries, windowsHolds, "", nil) != "" || judgeRoot(owner, hasACL, entries, "") != rootClosed {
		t.Error("the list that closes the directory doesn't pass as closed")
	}
}

// What a person reads when another account owns the directory: the directory, the
// account, what it can do, and what to do about it. The refusal is not a warning and
// names no one else's fix.
func TestTheRefusalForAStateRootThatAnotherAccountOwnsNamesItAndTheWayOut(t *testing.T) {
	refusal := &stateRootError{Path: stateRootPath, Owner: `PC\alice`}
	detail, fix := refusal.words()
	if want := `C:\ProgramData\Vectory belongs to PC\alice, not to SYSTEM or the Administrators, so that account can replace what the agent keeps in it.`; detail != want {
		t.Errorf("detail: %q", detail)
	}
	if want := "Look at what it holds, then remove it or make the Administrators its owner, and run setup again."; fix != want {
		t.Errorf("fix: %q", fix)
	}
	if refusal.Error() != detail+" "+fix {
		t.Errorf("Error() is %q", refusal.Error())
	}
	for _, word := range []string{"ignore", "continue", "safe", "harmless", "anyway", "optional", "warning", "ask "} {
		if strings.Contains(strings.ToLower(refusal.Error()), word) {
			t.Errorf("the refusal says %q: %s", word, refusal.Error())
		}
	}
	for _, sentence := range []string{detail, fix} {
		if !strings.HasSuffix(sentence, ".") || strings.Count(sentence, ". ") != 0 {
			t.Errorf("%q isn't one sentence", sentence)
		}
	}
	if anonymous, _ := (&stateRootError{Path: stateRootPath}).words(); !strings.Contains(anonymous, "belongs to an account the system doesn't name,") {
		t.Errorf("an owner the system doesn't name: %q", anonymous)
	}
}
