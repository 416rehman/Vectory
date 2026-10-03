package agent

import (
	"strings"
	"testing"
)

// The decision about a Windows access list runs on every platform. The lists
// here are the ones a default Windows install has on the directories an update
// path crosses (as icacls prints them), and the lists setup makes.

const (
	sidUsers              = "S-1-5-32-545"
	sidAuthenticatedUsers = "S-1-5-11"
	sidEveryone           = "S-1-1-0"
	sidAllAppPackages     = "S-1-15-2-1"
	sidSomeUser           = "S-1-5-21-1004336348-1177238915-682003330-1001"

	inheritObject    = 0x01
	inheritContainer = 0x02
	inheritOnly      = 0x08

	maskFull    uint32 = 0x001f01ff
	maskModify  uint32 = 0x001301bf
	maskReadRun uint32 = 0x001200a9
	maskRead    uint32 = 0x00120089
	// (WD,AD,WEA,WA): create files, create folders, write extended attributes
	// and attributes.
	maskCreate uint32 = rightWriteData | rightAppendData | rightWriteEA | rightWriteAttributes
)

func allow(sid string, mask uint32, flags uint8) aclEntry {
	return aclEntry{SID: sid, Type: aclAccessAllowed, Flags: flags, Mask: mask}
}

var (
	// icacls C:\
	defaultDriveRoot = []aclEntry{
		allow(sidAdministrators, maskFull, inheritObject|inheritContainer),
		allow(sidSystem, maskFull, inheritObject|inheritContainer),
		allow(sidUsers, maskReadRun, inheritObject|inheritContainer),
		allow(sidAuthenticatedUsers, maskModify, inheritObject|inheritContainer|inheritOnly),
		allow(sidAuthenticatedUsers, rightAppendData, 0),
	}
	// icacls C:\ProgramData
	defaultProgramData = []aclEntry{
		allow(sidSystem, maskFull, inheritObject|inheritContainer),
		allow(sidAdministrators, maskFull, inheritObject|inheritContainer),
		allow(sidCreatorOwner, maskFull, inheritObject|inheritContainer|inheritOnly),
		allow(sidUsers, maskReadRun, inheritObject|inheritContainer),
		allow(sidUsers, maskCreate, inheritContainer),
	}
	// icacls "C:\Program Files"
	defaultProgramFiles = []aclEntry{
		allow(sidTrustedInstaller, maskFull, 0),
		allow(sidTrustedInstaller, maskFull, inheritContainer|inheritOnly),
		allow(sidSystem, maskModify, 0),
		allow(sidSystem, maskFull, inheritObject|inheritContainer|inheritOnly),
		allow(sidAdministrators, maskModify, 0),
		allow(sidAdministrators, maskFull, inheritObject|inheritContainer|inheritOnly),
		allow(sidUsers, maskReadRun, 0),
		allow(sidUsers, 0xa0000000, inheritObject|inheritContainer|inheritOnly),
		allow(sidCreatorOwner, maskFull, inheritObject|inheritContainer|inheritOnly),
		allow(sidAllAppPackages, maskReadRun, 0),
	}
	// What setup gives the update policy's directory: SYSTEM and the
	// Administrators full control, the agent's service read.
	setupPolicyDirectory = []aclEntry{
		allow(sidSystem, maskFull, inheritObject|inheritContainer),
		allow(sidAdministrators, maskFull, inheritObject|inheritContainer),
		allow(serviceSID("Vectory"), maskRead, inheritObject|inheritContainer),
	}
	// A folder made inside ProgramData by an administrator, with what it inherits.
	folderInProgramData = []aclEntry{
		allow(sidSystem, maskFull, inheritObject|inheritContainer),
		allow(sidAdministrators, maskFull, inheritObject|inheritContainer),
		allow(sidUsers, maskReadRun, inheritObject|inheritContainer),
		allow(sidUsers, maskCreate, inheritContainer),
	}
)

func TestWindowsDefaultDirectoriesPassAboveTheDirectoryThatHoldsTheObject(t *testing.T) {
	for name, tc := range map[string]struct {
		owner   string
		entries []aclEntry
	}{
		`C:\`:                       {sidSystem, defaultDriveRoot},
		`C:\ProgramData`:            {sidSystem, defaultProgramData},
		`C:\Program Files`:          {sidTrustedInstaller, defaultProgramFiles},
		`C:\ProgramData\<a folder>`: {sidAdministrators, folderInProgramData},
	} {
		if got := aclProblem(tc.owner, true, tc.entries, windowsAbove, "", nil); got != "" {
			t.Errorf("%s: %q", name, got)
		}
	}
}

func TestWindowsAFolderThatAllowsCreatingIsNotTrustedToHoldTheObject(t *testing.T) {
	for name, tc := range map[string]struct {
		owner   string
		entries []aclEntry
		who     string
	}{
		`C:\`:                       {sidSystem, defaultDriveRoot, sidAuthenticatedUsers},
		`C:\ProgramData`:            {sidSystem, defaultProgramData, sidUsers},
		`C:\ProgramData\<a folder>`: {sidAdministrators, folderInProgramData, sidUsers},
	} {
		for _, role := range []windowsRole{windowsHolds, windowsObject} {
			got := aclProblem(tc.owner, true, tc.entries, role, "", nil)
			if !strings.HasPrefix(got, "can be changed by "+tc.who+" (") {
				t.Errorf("%s as role %d: %q", name, role, got)
			}
		}
	}
}

func TestWindowsDirectoriesAndFilesThatOnlyRootCanChangePassInEveryRole(t *testing.T) {
	for _, role := range []windowsRole{windowsAbove, windowsHolds, windowsObject} {
		if got := aclProblem(sidTrustedInstaller, true, defaultProgramFiles, role, "", nil); got != "" {
			t.Errorf(`C:\Program Files as role %d: %q`, role, got)
		}
		if got := aclProblem(sidAdministrators, true, setupPolicyDirectory, role, "", nil); got != "" {
			t.Errorf("the policy directory as role %d: %q", role, got)
		}
	}
}

func TestWindowsRefusesWhatLetsAnotherAccountReplaceOrChange(t *testing.T) {
	// above is the problem for a directory above the one that holds the object,
	// which only the rights to replace or take over refuse; holds is the problem
	// for the directory that holds it and for the object, which every right to
	// change refuses. "" means the entry is no problem there.
	const users, user = "can be changed by S-1-5-32-545 (", "can be changed by " + sidSomeUser + " ("
	for _, tc := range []struct {
		name         string
		entry        aclEntry
		above, holds string
	}{
		{"Users modify", allow(sidUsers, maskModify, inheritObject|inheritContainer), users + "delete)", users + "write, delete)"},
		{"Everyone full control", allow(sidEveryone, maskFull, 0), "can be changed by S-1-1-0 (delete, change permissions)", "can be changed by S-1-1-0 (write, delete, change permissions)"},
		{"generic all", allow(sidUsers, rightGenericAll, 0), users + "full control)", users + "full control)"},
		{"generic write", allow(sidUsers, rightGenericWrite, 0), users + "write)", users + "write)"},
		{"delete only", allow(sidUsers, rightDelete, 0), users + "delete)", users + "delete)"},
		{"delete a child", allow(sidUsers, rightDeleteChild, 0), users + "delete)", users + "delete)"},
		{"change permissions", allow(sidUsers, rightWriteDAC, 0), users + "change permissions)", users + "change permissions)"},
		{"take ownership", allow(sidUsers, rightWriteOwner, 0), users + "change permissions)", users + "change permissions)"},
		{"write data only", allow(sidSomeUser, rightWriteData, 0), "", user + "write)"},
		{"append only", allow(sidSomeUser, rightAppendData, 0), "", user + "write)"},
		{"write attributes only", allow(sidSomeUser, rightWriteAttributes, 0), "", user + "write)"},
		{"create files, folders and attributes", allow(sidUsers, maskCreate, inheritContainer), "", users + "write)"},
		{"read and run", allow(sidUsers, maskReadRun, 0), "", ""},
		{"generic read and execute", allow(sidUsers, 0xa0000000, 0), "", ""},
		{"inherit only, so not this object", allow(sidUsers, maskModify, inheritObject|inheritContainer|inheritOnly), "", ""},
		{"the entry for whichever account owns it", allow(sidCreatorOwner, maskFull, 0), "", ""},
		{"a refusal", aclEntry{SID: sidUsers, Type: aclAccessDenied, Mask: maskFull}, "", ""},
	} {
		entries := []aclEntry{allow(sidSystem, maskFull, 0), allow(sidAdministrators, maskFull, 0), tc.entry}
		for role, want := range map[windowsRole]string{windowsAbove: tc.above, windowsHolds: tc.holds, windowsObject: tc.holds} {
			if got := aclProblem(sidAdministrators, true, entries, role, "", nil); got != want {
				t.Errorf("%s, role %d: %q, want %q", tc.name, role, got, want)
			}
		}
	}
}

func TestWindowsOwnerNoAccessListAndEntriesThisCheckDoesNotRead(t *testing.T) {
	system := []aclEntry{allow(sidSystem, maskFull, 0)}
	if got := aclProblem(sidSomeUser, true, system, windowsObject, "", nil); got != "belongs to "+sidSomeUser+", not to SYSTEM or the Administrators" {
		t.Errorf("an owner that isn't root: %q", got)
	}
	if got := aclProblem(sidUsers, true, system, windowsAbove, "", func(sid string) string { return `BUILTIN\Users` }); got != `belongs to BUILTIN\Users, not to SYSTEM or the Administrators` {
		t.Errorf("an owner named for a person: %q", got)
	}
	if got := aclProblem(sidSystem, false, nil, windowsObject, "", nil); got != "has no access list, so everyone can change it" {
		t.Errorf("no access list: %q", got)
	}
	// An empty list gives nobody access, which is as closed as a list can be.
	if got := aclProblem(sidSystem, true, nil, windowsObject, "", nil); got != "" {
		t.Errorf("an empty access list: %q", got)
	}
	odd := []aclEntry{allow(sidSystem, maskFull, 0), {SID: "", Type: 9, Mask: maskFull}}
	if got := aclProblem(sidSystem, true, odd, windowsObject, "", nil); got != "has an access entry of a kind this check doesn't read (type 9)" {
		t.Errorf("an entry of another kind: %q", got)
	}
	// One more trusted account, as a test builds trees under its own.
	both := []aclEntry{allow(sidSystem, maskFull, 0), allow(sidSomeUser, maskFull, 0)}
	if got := aclProblem(sidSomeUser, true, both, windowsObject, sidSomeUser, nil); got != "" {
		t.Errorf("the extra account: %q", got)
	}
	if got := aclProblem(sidSomeUser, true, both, windowsObject, "", nil); got == "" {
		t.Error("the extra account was trusted without being named")
	}
}

func TestTheServiceSIDIsDerivedTheWayWindowsDerivesIt(t *testing.T) {
	// TrustedInstaller is a service, so its SID is the derivation of its name:
	// a published value, which proves the derivation.
	if got := serviceSID("TrustedInstaller"); got != sidTrustedInstaller {
		t.Errorf("TrustedInstaller: %s, want %s", got, sidTrustedInstaller)
	}
	// The name is upper-cased first, so the spelling doesn't matter.
	if serviceSID("trustedinstaller") != sidTrustedInstaller {
		t.Error("the spelling of the name changed its SID")
	}
	if got := serviceSID("Vectory"); got != "S-1-5-80-706499921-4073424311-170640362-3342322694-3009795177" {
		t.Errorf("Vectory: %s", got)
	}
}

func TestWindowsSecurityDescriptorsForWhatRootMakes(t *testing.T) {
	service := serviceSID("Vectory")
	readAndRun := "0x1200a9"
	for _, tc := range []struct {
		perm      rootFilePerm
		directory bool
		want      string
	}{
		{rootPrivate, true, "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"},
		{rootPrivate, false, "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"},
		{rootReadable, true, "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;" + service + ")"},
		{rootReadable, false, "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;" + service + ")"},
		// A file made beside the executable has a list of its own: SYSTEM, the
		// Administrators and TrustedInstaller write it, and the Users and the agent's
		// service read and run it, whatever the directory would have given it.
		{rootExecutable, false, "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + sidTrustedInstaller + ")(A;;" + readAndRun + ";;;BU)(A;;" + readAndRun + ";;;" + service + ")"},
		{rootExecutable, true, "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + sidTrustedInstaller + ")(A;OICI;" + readAndRun + ";;;BU)(A;OICI;" + readAndRun + ";;;" + service + ")"},
	} {
		if got := windowsSDDL(tc.perm, tc.directory, "Vectory"); got != tc.want {
			t.Errorf("perm %d, directory %v: %q, want %q", tc.perm, tc.directory, got, tc.want)
		}
	}
	if got := windowsSDDL(rootFilePerm(0), false, "Vectory"); got != "" {
		t.Errorf("an access nobody asked for has the descriptor %q", got)
	}
}

// The directory the policy's and the step's directories are made in lets nobody
// but root add an entry: that is what makes a squatter's directory impossible, and
// the agent's service may list it because its own directories are below it.
func TestTheUpdateRootAddsNoEntriesForAnyoneButRoot(t *testing.T) {
	service := serviceSID("Vectory")
	want := "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;" + service + ")"
	if got := updateRootSDDL("Vectory"); got != want {
		t.Fatalf("%q, want %q", got, want)
	}
	// As the check reads it: root's alone to change, in every role.
	entries := []aclEntry{allow(sidSystem, maskFull, inheritObject|inheritContainer), allow(sidAdministrators, maskFull, inheritObject|inheritContainer), allow(service, maskReadRun, 0)}
	for _, role := range []windowsRole{windowsAbove, windowsHolds, windowsObject} {
		if got := aclProblem(sidAdministrators, true, entries, role, "", nil); got != "" {
			t.Errorf("role %d: %q", role, got)
		}
	}
}

func cloneEntries(entries []aclEntry) []aclEntry { return append([]aclEntry(nil), entries...) }

func TestADirectoryOnlyRootMayEnterIsOneNobodyElseCanSee(t *testing.T) {
	private := []aclEntry{allow(sidSystem, maskFull, inheritObject|inheritContainer), allow(sidAdministrators, maskFull, inheritObject|inheritContainer)}
	if got := privateDirectoryProblem(sidAdministrators, true, private, "", nil); got != "" {
		t.Errorf("what setup makes: %q", got)
	}
	service := serviceSID("Vectory")
	for _, tc := range []struct {
		name    string
		owner   string
		hasACL  bool
		entries []aclEntry
		want    string
	}{
		{"read by the agent's service", sidAdministrators, true, append(cloneEntries(private), allow(service, maskRead, 0)), "can be entered by " + service},
		{"read by Users", sidAdministrators, true, append(cloneEntries(private), allow(sidUsers, maskReadRun, 0)), "can be entered by " + sidUsers},
		{"a right that only passes to what is made later", sidAdministrators, true, append(cloneEntries(private), allow(sidUsers, maskRead, inheritObject|inheritContainer|inheritOnly)), "can be entered by " + sidUsers},
		{"an owner that isn't root", sidSomeUser, true, private, "belongs to " + sidSomeUser + ", not to SYSTEM or the Administrators"},
		{"no access list", sidAdministrators, false, nil, "has no access list, so everyone can enter it"},
		{"an entry of another kind", sidAdministrators, true, append(cloneEntries(private), aclEntry{Type: 9, Mask: maskFull}), "has an access entry of a kind this check doesn't read (type 9)"},
	} {
		if got := privateDirectoryProblem(tc.owner, tc.hasACL, tc.entries, "", nil); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
	// Entries that give nobody anything: a refusal, an empty right, the owner's own
	// entry, and TrustedInstaller.
	quiet := append(cloneEntries(private),
		aclEntry{SID: sidUsers, Type: aclAccessDenied, Mask: maskFull},
		allow(sidUsers, 0, 0),
		allow(sidCreatorOwner, maskFull, inheritObject|inheritContainer|inheritOnly),
		allow(sidTrustedInstaller, maskFull, 0))
	if got := privateDirectoryProblem(sidSystem, true, quiet, "", nil); got != "" {
		t.Errorf("entries that grant nothing to anyone else: %q", got)
	}
	// One more trusted account, as a test builds trees under its own.
	own := append(cloneEntries(private), allow(sidSomeUser, maskFull, 0))
	if got := privateDirectoryProblem(sidSomeUser, true, own, sidSomeUser, nil); got != "" {
		t.Errorf("the extra account: %q", got)
	}
}

func TestEntryNamesOnWindowsArePlainNamesAndNeverDevices(t *testing.T) {
	for _, name := range []string{
		"policy.json", "status.json", "release.json.sig", "vectory.exe", ".policy.json.tmp-0123456789abcdef",
		"COM0", "COM10", "lpt", "nul-x", "console.txt", "auxiliary", "a_b-c.d",
	} {
		if err := checkWindowsEntryName(name); err != nil {
			t.Errorf("%q: %v", name, err)
		}
	}
	for _, name := range []string{
		"", ".", "..", "a.", "a b", "a:b", `a\b`, "a/b", "a*b", "a?b", "a<b", "a|b", `a"b`, "a~1", "POLICY~1.JSO", "é", "a\x00b", "a\nb",
		"NUL", "nul", "Nul.txt", "CON", "con.json", "PRN", "aux", "AUX.x", "COM1", "com9.log", "Com3", "LPT1", "lpt9.txt", "CONIN$",
		strings.Repeat("n", 256),
	} {
		if err := checkWindowsEntryName(name); err == nil {
			t.Errorf("%q was accepted", name)
		}
	}
}
