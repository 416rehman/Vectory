package agent

import (
	"strconv"
	"strings"
	"testing"
)

// The path check judges access lists as plain values, so a list a Windows install
// has can be written here as the text Windows prints for it (SDDL) and judged on any
// platform. The lists are the ones the directories above the update step's have on a
// default install of Windows, the one the step makes, and what an account or an
// administrator could change in them.

// sddlAccounts are the aliases SDDL writes for the accounts the lists here name.
var sddlAccounts = map[string]string{
	"SY": sidSystem, "BA": sidAdministrators, "BU": sidUsers, "AU": sidAuthenticatedUsers,
	"WD": sidEveryone, "CO": sidCreatorOwner, "CG": "S-1-3-1", "OW": "S-1-3-4", "AC": sidAllAppPackages,
	"LS": "S-1-5-19", "NS": "S-1-5-20", "IU": "S-1-5-4", "PU": "S-1-5-32-547", "RC": "S-1-5-12",
}

// sddlRights are the rights SDDL names with two letters.
var sddlRights = map[string]uint32{
	"GA": 0x10000000, "GR": 0x80000000, "GW": 0x40000000, "GX": 0x20000000,
	"RC": 0x00020000, "SD": 0x00010000, "WD": 0x00040000, "WO": 0x00080000,
	"FA": 0x001f01ff, "FR": 0x00120089, "FW": 0x00120116, "FX": 0x001200a0,
	"CC": 0x1, "DC": 0x2, "LC": 0x4, "SW": 0x8, "RP": 0x10, "WP": 0x20, "DT": 0x40, "LO": 0x80, "CR": 0x100,
}

// sddlFlags are the entry flags SDDL names.
var sddlFlags = map[string]uint8{"OI": 0x01, "CI": 0x02, "NP": 0x04, "IO": 0x08, "ID": 0x10}

// sddlTypes are the entry types SDDL names that the check reads or refuses.
var sddlTypes = map[string]uint8{"A": aclAccessAllowed, "D": aclAccessDenied, "OA": 5, "OD": 6, "XA": 9, "XD": 10}

// sddlParts splits a descriptor into its O, G, D and S parts: the text after each
// marker up to the next one outside the parentheses of an entry.
func sddlParts(sddl string) map[byte]string {
	parts := map[byte]string{}
	depth, start, key := 0, 0, byte(0)
	flush := func(end int) {
		if key != 0 {
			parts[key] = sddl[start:end]
		}
	}
	for i := 0; i < len(sddl); i++ {
		c := sddl[i]
		switch {
		case c == '(':
			depth++
		case c == ')':
			depth--
		case depth == 0 && i+1 < len(sddl) && sddl[i+1] == ':' && strings.IndexByte("OGDS", c) >= 0:
			flush(i)
			key, start = c, i+2
			i++
		}
	}
	flush(len(sddl))
	return parts
}

// sddlAccount is the SID an account in a descriptor names, by alias or as written.
func sddlAccount(t *testing.T, text string) string {
	t.Helper()
	if strings.HasPrefix(text, "S-1-") {
		return text
	}
	sid, ok := sddlAccounts[text]
	if !ok {
		t.Fatalf("the descriptor names an account %q this reader doesn't know", text)
	}
	return sid
}

// sddlCodes reads a run of two-letter codes through a table.
func sddlCodes[V uint8 | uint32](t *testing.T, text string, table map[string]V) V {
	t.Helper()
	var total V
	for ; text != ""; text = text[2:] {
		if len(text) < 2 {
			t.Fatalf("%q isn't a run of two-letter codes", text)
		}
		value, ok := table[text[:2]]
		if !ok {
			t.Fatalf("the code %q isn't one this reader knows", text[:2])
		}
		total |= value
	}
	return total
}

// parseSDDL reads the owner and the access list of a descriptor the way the path
// check reads them from a handle: the owner's SID, whether there is an access list at
// all, and each entry.
func parseSDDL(t *testing.T, sddl string) (owner string, hasACL bool, entries []aclEntry) {
	t.Helper()
	parts := sddlParts(sddl)
	if text, ok := parts['O']; ok {
		owner = sddlAccount(t, text)
	}
	dacl, ok := parts['D']
	if !ok || dacl == "NO_ACCESS_CONTROL" {
		return owner, false, nil
	}
	hasACL = true
	for rest := dacl[strings.IndexByte(dacl+"(", '('):]; rest != ""; {
		end := strings.IndexByte(rest, ')')
		if rest[0] != '(' || end < 0 {
			t.Fatalf("%q isn't a list of entries", dacl)
		}
		fields := strings.Split(rest[1:end], ";")
		rest = rest[end+1:]
		if len(fields) < 6 {
			t.Fatalf("the entry (%s) has %d fields", strings.Join(fields, ";"), len(fields))
		}
		kind, known := sddlTypes[fields[0]]
		if !known {
			t.Fatalf("the entry type %q isn't one this reader knows", fields[0])
		}
		var mask uint32
		if strings.HasPrefix(fields[2], "0x") {
			value, err := strconv.ParseUint(fields[2][2:], 16, 32)
			if err != nil {
				t.Fatalf("the rights %q: %v", fields[2], err)
			}
			mask = uint32(value)
		} else {
			mask = sddlCodes(t, fields[2], sddlRights)
		}
		entries = append(entries, aclEntry{SID: sddlAccount(t, fields[5]), Type: kind, Flags: sddlCodes(t, fields[1], sddlFlags), Mask: mask})
	}
	return owner, hasACL, entries
}

// sddlProblem is what the path check says about a descriptor for a component with
// the role, with SIDs left as they are.
func sddlProblem(t *testing.T, sddl string, role windowsRole) string {
	t.Helper()
	owner, hasACL, entries := parseSDDL(t, sddl)
	return aclProblem(owner, hasACL, entries, role, "", nil)
}

const (
	// icacls C:\ on Windows Server: the Administrators and SYSTEM have full control,
	// the Users read and run, and the Authenticated Users add folders to it; what
	// passes on to what is made in it is inherit-only (IO).
	stockDriveRootSDDL = "O:SYG:SYD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICIIO;0x1301bf;;;AU)(A;;LC;;;AU)"
	// The same drive root where the Authenticated Users' entries are the right to
	// create folders ((CI)(AD)) and files in subfolders ((CI)(IO)(WD)).
	stockDriveRootCreateOnlySDDL = "O:SYG:SYD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;CI;LC;;;AU)(A;CIIO;DC;;;AU)"
	// icacls C:\ProgramData: SYSTEM and the Administrators have full control, CREATOR
	// OWNER full control of what an account makes in it (inherit-only), the Users read
	// and run, and create files and folders in it and in the folders below it.
	stockProgramDataSDDL = "O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;FA;;;CO)(A;OICI;0x1200a9;;;BU)(A;CI;LC;;;BU)(A;CI;DC;;;BU)"
	// The same, where the Users' right is one entry: (CI)(WD,AD,WEA,WA).
	stockProgramDataOneEntrySDDL = "O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;FA;;;CO)(A;OICI;0x1200a9;;;BU)(A;CI;0x116;;;BU)"
	// icacls "C:\Program Files": TrustedInstaller owns it and has full control, SYSTEM
	// and the Administrators modify it, the Users and the application packages read and
	// run it.
	stockProgramFilesSDDL = "O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464D:PAI" +
		"(A;;FA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(A;CIIO;FA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)" +
		"(A;;0x1301bf;;;SY)(A;OICIIO;FA;;;SY)(A;;0x1301bf;;;BA)(A;OICIIO;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;OICIIO;GA;;;CO)" +
		"(A;;0x1200a9;;;AC)(A;OICIIO;GXGR;;;AC)(A;;0x1200a9;;;S-1-15-2-2)(A;OICIIO;GXGR;;;S-1-15-2-2)"
)

// stockLists are the lists above, by the directory that has them.
var stockLists = map[string]string{
	`C:\`:                                   stockDriveRootSDDL,
	`C:\ (folders and files for the Users)`: stockDriveRootCreateOnlySDDL,
	`C:\ProgramData`:                        stockProgramDataSDDL,
	`C:\ProgramData (one entry for the Users)`: stockProgramDataOneEntrySDDL,
	`C:\Program Files`:                         stockProgramFilesSDDL,
}

func TestTheReaderOfDescriptorTextReadsWhatThePathCheckReads(t *testing.T) {
	owner, hasACL, entries := parseSDDL(t, stockProgramDataSDDL)
	if owner != sidSystem || !hasACL || len(entries) != 6 {
		t.Fatalf("owner %q, access list %v, %d entries", owner, hasACL, len(entries))
	}
	want := []aclEntry{
		{sidSystem, aclAccessAllowed, 0x03, 0x1f01ff},
		{sidAdministrators, aclAccessAllowed, 0x03, 0x1f01ff},
		{sidCreatorOwner, aclAccessAllowed, 0x0b, 0x1f01ff},
		{sidUsers, aclAccessAllowed, 0x03, 0x1200a9},
		{sidUsers, aclAccessAllowed, 0x02, rightAppendData},
		{sidUsers, aclAccessAllowed, 0x02, rightWriteData},
	}
	for i := range want {
		if entries[i] != want[i] {
			t.Errorf("entry %d is %+v, want %+v", i, entries[i], want[i])
		}
	}
	if owner, hasACL, _ := parseSDDL(t, "O:BAD:NO_ACCESS_CONTROL"); owner != sidAdministrators || hasACL {
		t.Errorf("a descriptor with no access list: owner %q, access list %v", owner, hasACL)
	}
	if _, hasACL, entries := parseSDDL(t, "O:BAD:P"); !hasACL || len(entries) != 0 {
		t.Errorf("an empty access list: %v, %d entries", hasACL, len(entries))
	}
	if _, _, entries := parseSDDL(t, "O:BAD:P(D;;SD;;;BU)(OA;;0x2;;;BU)(A;;GWGA;;;WD)"); len(entries) != 3 || entries[0].Type != aclAccessDenied || entries[1].Type != 5 || entries[2].Mask != rightGenericWrite|rightGenericAll {
		t.Errorf("a refusal, an object entry and generic rights: %+v", entries)
	}
}

// What a default Windows install has above the step's directories must pass, or no
// machine could take an update: they let Users and Authenticated Users create entries
// and nothing that replaces one. The same lists are refused as the holder of the
// object, which is why a directory that exists but is only on the way to a path that
// doesn't exist yet must be judged as what is above it and not as the holder.
func TestTheDirectoriesOfAStockWindowsInstallPassAboveTheStepsAndAreRefusedAsTheHolder(t *testing.T) {
	for name, sddl := range stockLists {
		if got := sddlProblem(t, sddl, windowsAbove); got != "" {
			t.Errorf("%s as a directory above the step's: %q", name, got)
		}
		holder := sddlProblem(t, sddl, windowsHolds)
		switch name {
		case `C:\Program Files`:
			// Only root can change it, which is why the agent can live in it.
			if holder != "" {
				t.Errorf("%s as the holder: %q", name, holder)
			}
		default:
			if !strings.HasPrefix(holder, "can be changed by ") {
				t.Errorf("%s as the holder: %q, want a refusal for the account that may create in it", name, holder)
			}
		}
	}
	// What a person reads when a drive root or ProgramData is the holder.
	if got := sddlProblem(t, stockProgramDataOneEntrySDDL, windowsHolds); got != "can be changed by "+sidUsers+" (write)" {
		t.Errorf("ProgramData as the holder: %q", got)
	}
}

// The directory the step makes its own directories in, as the step makes it, is
// root's alone to change, so it passes whatever it is to the path.
func TestTheUpdateRootAsTheStepMakesItIsRootsAloneToChange(t *testing.T) {
	sddl := updateRootSDDL("Vectory")
	for _, role := range []windowsRole{windowsAbove, windowsHolds, windowsObject, windowsClosable} {
		if got := sddlProblem(t, sddl, role); got != "" {
			t.Errorf("role %d: %q", role, got)
		}
	}
	// A directory ProgramData gave to a new folder in the Administrators' name:
	// full control for the one that made it, what ProgramData passes on to the Users,
	// and the right to create in it.
	inherited := "O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;CIID;LC;;;BU)(A;CIID;DC;;;BU)(A;OICIIOID;FA;;;CO)"
	for role, want := range map[windowsRole]string{
		windowsAbove:    "",
		windowsHolds:    "can be changed by " + sidUsers + " (write)",
		windowsClosable: "",
	} {
		if got := sddlProblem(t, inherited, role); got != want {
			t.Errorf("a folder that inherited ProgramData's entries, role %d: %q, want %q", role, got, want)
		}
	}
}

// Lists that let an account other than root replace or take over what is in a
// directory, or that don't belong to root, are refused above the step's directories
// as they are anywhere: what a place on the path is to the path decides which rights
// refuse it, and these are refused for all of them.
func TestWindowsListsThatLetAnAccountReplaceTakeOverOrOwnAreRefusedAboveToo(t *testing.T) {
	const user = "S-1-5-21-1004336348-1177238915-682003330-1001"
	withEntry := func(sddl, entry string) string { return sddl + entry }
	withOwner := func(sddl, owner string) string { return strings.Replace(sddl, "O:SY", "O:"+owner, 1) }
	for _, tc := range []struct {
		name  string
		sddl  string
		start string // what the problem begins with
	}{
		{"Users may delete a child of ProgramData", withEntry(stockProgramDataSDDL, "(A;OICI;0x40;;;BU)"), "can be changed by " + sidUsers + " (delete)"},
		{"Authenticated Users may delete a child of the drive root", withEntry(stockDriveRootSDDL, "(A;;0x40;;;AU)"), "can be changed by " + sidAuthenticatedUsers + " (delete)"},
		{"Users may delete ProgramData itself", withEntry(stockProgramDataSDDL, "(A;;SD;;;BU)"), "can be changed by " + sidUsers + " (delete)"},
		{"Users may change the permissions of ProgramData", withEntry(stockProgramDataSDDL, "(A;;WD;;;BU)"), "can be changed by " + sidUsers + " (change permissions)"},
		{"Users may take ownership of ProgramData", withEntry(stockProgramDataSDDL, "(A;;WO;;;BU)"), "can be changed by " + sidUsers + " (change permissions)"},
		{"Users hold generic write on ProgramData", withEntry(stockProgramDataSDDL, "(A;;GW;;;BU)"), "can be changed by " + sidUsers + " (write)"},
		{"Everyone holds generic all on the drive root", withEntry(stockDriveRootSDDL, "(A;;GA;;;WD)"), "can be changed by " + sidEveryone + " (full control)"},
		{"Everyone has full control of Program Files", withEntry(stockProgramFilesSDDL, "(A;;FA;;;WD)"), "can be changed by " + sidEveryone + " (delete, change permissions)"},
		{"a user owns ProgramData", withOwner(stockProgramDataSDDL, user), "belongs to " + user + ", not to SYSTEM or the Administrators"},
		{"the Users own the drive root", withOwner(stockDriveRootSDDL, "BU"), "belongs to " + sidUsers + ", not to SYSTEM or the Administrators"},
		{"ProgramData has no access list", "O:SYG:SYD:NO_ACCESS_CONTROL", "has no access list, so everyone can change it"},
		{"an entry of a kind the check doesn't read", withEntry(stockProgramDataSDDL, "(OA;;0x2;;;BU)"), "has an access entry of a kind this check doesn't read (type 5)"},
		// The check reads allow entries and ignores the order of a list: a refusal in
		// front of an allow that grants the same right doesn't make the list safe to it.
		{"a refusal before an allow of delete", strings.Replace(withEntry(stockProgramDataSDDL, "(A;;SD;;;BU)"), "D:PAI", "D:PAI(D;;SD;;;BU)", 1), "can be changed by " + sidUsers + " (delete)"},
		{"a refusal of an unrelated right before an allow of delete a child", strings.Replace(withEntry(stockProgramDataSDDL, "(A;;0x40;;;BU)"), "D:PAI", "D:PAI(D;;0x1;;;BU)", 1), "can be changed by " + sidUsers + " (delete)"},
	} {
		if got := sddlProblem(t, tc.sddl, windowsAbove); got != tc.start {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.start)
		}
	}
}

// What the step makes its own directories in is judged for every right to change
// it, so an entry that only lets an account add a name there is refused where the
// same entry on the directory above is not: a folder that Users or Everyone may add
// to is the one a squatter makes the step's directories in first.
func TestAnUpdateRootThatLetsAnotherAccountAddIsRefusedAndTheDirectoryAboveItIsNot(t *testing.T) {
	root := updateRootSDDL("Vectory")
	for _, tc := range []struct {
		name  string
		entry string
		above string
		holds string
	}{
		{"Everyone may add files, in the directory and in what is made in it", "(A;OICI;DC;;;WD)", "", "can be changed by " + sidEveryone + " (write)"},
		{"Everyone may add files to what is made in it", "(A;OICIIO;DC;;;WD)", "", ""},
		{"Users may add folders to the directory", "(A;;LC;;;BU)", "", "can be changed by " + sidUsers + " (write)"},
		{"the agent's service may write attributes", "(A;;0x100;;;" + serviceSID("Vectory") + ")", "", "can be changed by " + serviceSID("Vectory") + " (write)"},
		{"the agent's service may delete", "(A;;SD;;;" + serviceSID("Vectory") + ")", "can be changed by " + serviceSID("Vectory") + " (delete)", "can be changed by " + serviceSID("Vectory") + " (delete)"},
		{"Users may read and run it", "(A;;0x1200a9;;;BU)", "", ""},
	} {
		sddl := root + tc.entry
		if got := sddlProblem(t, sddl, windowsAbove); got != tc.above {
			t.Errorf("%s, above: %q, want %q", tc.name, got, tc.above)
		}
		if got := sddlProblem(t, sddl, windowsHolds); got != tc.holds {
			t.Errorf("%s, as the root or what is below it: %q, want %q", tc.name, got, tc.holds)
		}
	}
}

// The bit set, derived from winnt.h: of the 32 bits an access mask has, the ones that
// refuse a directory above the step's are the four that decide what an existing name
// leads to or who controls it and the two generic rights that stand for them, and the
// ones that refuse what the step writes into add the four that write.
func TestOnlyTheRightsThatDecideANameRefuseADirectoryAboveTheStepsAndTheRightsToWriteRefuseWhatItWritesInto(t *testing.T) {
	sdk := map[string]uint32{
		"FILE_WRITE_DATA (FILE_ADD_FILE)":          0x00000002,
		"FILE_APPEND_DATA (FILE_ADD_SUBDIRECTORY)": 0x00000004,
		"FILE_WRITE_EA":                            0x00000010,
		"FILE_DELETE_CHILD":                        0x00000040,
		"FILE_WRITE_ATTRIBUTES":                    0x00000100,
		"DELETE":                                   0x00010000,
		"WRITE_DAC":                                0x00040000,
		"WRITE_OWNER":                              0x00080000,
		"GENERIC_ALL":                              0x10000000,
		"GENERIC_WRITE":                            0x40000000,
	}
	got := map[string]uint32{
		"FILE_WRITE_DATA (FILE_ADD_FILE)":          rightWriteData,
		"FILE_APPEND_DATA (FILE_ADD_SUBDIRECTORY)": rightAppendData,
		"FILE_WRITE_EA":                            rightWriteEA,
		"FILE_DELETE_CHILD":                        rightDeleteChild,
		"FILE_WRITE_ATTRIBUTES":                    rightWriteAttributes,
		"DELETE":                                   rightDelete,
		"WRITE_DAC":                                rightWriteDAC,
		"WRITE_OWNER":                              rightWriteOwner,
		"GENERIC_ALL":                              rightGenericAll,
		"GENERIC_WRITE":                            rightGenericWrite,
	}
	for name, want := range sdk {
		if got[name] != want {
			t.Errorf("%s is %#x here and %#x in winnt.h", name, got[name], want)
		}
	}
	const replace = uint32(0x00000040 | 0x00010000 | 0x00040000 | 0x00080000 | 0x10000000 | 0x40000000)
	const write = uint32(0x00000002 | 0x00000004 | 0x00000010 | 0x00000100)
	for bit := 0; bit < 32; bit++ {
		mask := uint32(1) << bit
		entries := []aclEntry{{SID: sidUsers, Type: aclAccessAllowed, Mask: mask}}
		wantAbove, wantHolds := mask&replace != 0, mask&(replace|write) != 0
		if refused := aclProblem(sidSystem, true, entries, windowsAbove, "", nil) != ""; refused != wantAbove {
			t.Errorf("bit %#x above the step's directories: refused %v, want %v", mask, refused, wantAbove)
		}
		if refused := aclProblem(sidSystem, true, entries, windowsHolds, "", nil) != ""; refused != wantHolds {
			t.Errorf("bit %#x on what the step writes into: refused %v, want %v", mask, refused, wantHolds)
		}
		if refused := aclProblem(sidSystem, true, entries, windowsObject, "", nil) != ""; refused != wantHolds {
			t.Errorf("bit %#x on the object: refused %v, want %v", mask, refused, wantHolds)
		}
	}
	if rightsToReplace != replace || rightsToModify != replace|write {
		t.Errorf("the two sets are %#x and %#x", uint32(rightsToReplace), uint32(rightsToModify))
	}
}

// The owner of a directory holds WRITE_DAC through ownership alone, so an ancestor
// that belongs to anyone but the three accounts that count as root is refused whatever
// its entries say, and one that belongs to root is judged by its entries.
func TestAnAncestorThatAnotherAccountOwnsIsRefusedWhateverItsEntriesSay(t *testing.T) {
	quiet := "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	for _, owner := range []string{"BU", "AU", "WD", "S-1-5-21-1004336348-1177238915-682003330-1001", serviceSID("Vectory")} {
		for _, role := range []windowsRole{windowsAbove, windowsHolds, windowsObject, windowsClosable} {
			want := "belongs to " + sddlAccount(t, owner) + ", not to SYSTEM or the Administrators"
			if got := sddlProblem(t, "O:"+owner+quiet, role); got != want {
				t.Errorf("owner %s, role %d: %q, want %q", owner, role, got, want)
			}
		}
	}
	for _, owner := range []string{"SY", "BA", sidTrustedInstaller} {
		if got := sddlProblem(t, "O:"+owner+quiet, windowsAbove); got != "" {
			t.Errorf("owner %s: %q", owner, got)
		}
	}
}

// A path's place in the update root and in the install directory decides what each
// component is to the check.
func TestWindowsPathRolesFollowWhereThePathIsInTheUpdateRoot(t *testing.T) {
	const root = `C:\ProgramData\Vectory`
	above, holds, object, closable := windowsAbove, windowsHolds, windowsObject, windowsClosable
	for _, tc := range []struct {
		name      string
		path      string
		kind      rootOwnedKind
		root      string
		preflight bool
		want      []windowsRole
	}{
		{"the policy file", root + `\updates\policy.json`, rootOwnedFile, root, false,
			[]windowsRole{above, above, holds, holds, object}},
		{"the step's directory", root + `\update-state`, rootOwnedDirectory, root, false,
			[]windowsRole{above, above, holds, holds}},
		{"a directory deep in the step's", root + `\update-state\private\helper`, rootOwnedDirectory, root, false,
			[]windowsRole{above, above, holds, holds, holds, holds}},
		{"the update root itself", root, rootOwnedDirectory, root, false,
			[]windowsRole{above, above, holds}},
		{"the step's directory, in setup's first look", root + `\update-state`, rootOwnedDirectory, root, true,
			[]windowsRole{above, above, closable, holds}},
		{"the update root, in setup's first look", root, rootOwnedDirectory, root, true,
			[]windowsRole{above, above, closable}},
		{"a path the system spells in other letters", `C:\PROGRAMDATA\vectory\Updates\policy.json`, rootOwnedFile, root, false,
			[]windowsRole{above, above, holds, holds, object}},
		{"the installed agent", `C:\Program Files\Vectory\vectory.exe`, rootOwnedFile, "", false,
			[]windowsRole{above, above, holds, object}},
		{"the install directory", `C:\Program Files\Vectory`, rootOwnedDirectory, "", false,
			[]windowsRole{above, above, holds}},
		{"an installed agent several directories down", `C:\Program Files\Acme\Tools\Vectory\vectory.exe`, rootOwnedFile, "", false,
			[]windowsRole{above, above, above, above, holds, object}},
		{"an agent installed inside the update root", root + `\bin\vectory.exe`, rootOwnedFile, root, false,
			[]windowsRole{above, above, holds, holds, object}},
		{"a directory that is not in the update root", `C:\ProgramData\Other\updates`, rootOwnedDirectory, "", false,
			[]windowsRole{above, above, above, holds}},
		{"a drive root", `D:\`, rootOwnedDirectory, "", false,
			[]windowsRole{holds}},
	} {
		prefixes := windowsPrefixes(tc.path)
		got := windowsPathRoles(prefixes, tc.kind, tc.root, tc.preflight)
		if len(got) != len(tc.want) {
			t.Errorf("%s: %d roles for %v, want %d", tc.name, len(got), prefixes, len(tc.want))
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%s: %s is role %d, want %d", tc.name, prefixes[i], got[i], tc.want[i])
			}
		}
	}
	if got := windowsPrefixes(`C:\ProgramData\Vectory`); strings.Join(got, "|") != `C:\|C:\ProgramData|C:\ProgramData\Vectory` {
		t.Errorf("the prefixes of a path: %v", got)
	}
}

// The state directory is made with the list that keeps it private at once, the
// account that makes it is the owner, and the Administrators and SYSTEM are the only
// others.
func TestAPrivateDirectoryIsMadeWithItsOwnersListAndNothingInherited(t *testing.T) {
	const user = "S-1-5-21-1004336348-1177238915-682003330-1001"
	owner, hasACL, entries := parseSDDL(t, privateDirectorySDDL(user))
	if owner != user || !hasACL || len(entries) != 3 {
		t.Fatalf("owner %q, access list %v, %d entries", owner, hasACL, len(entries))
	}
	for i, sid := range []string{sidSystem, sidAdministrators, user} {
		want := aclEntry{SID: sid, Type: aclAccessAllowed, Flags: 0x03, Mask: 0x1f01ff}
		if entries[i] != want {
			t.Errorf("entry %d is %+v, want %+v", i, entries[i], want)
		}
	}
	if !strings.Contains(privateDirectorySDDL(user), "D:P(") {
		t.Error("the list isn't protected from what the parent passes on")
	}
}
