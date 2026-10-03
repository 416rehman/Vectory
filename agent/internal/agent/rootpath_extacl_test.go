package agent

import (
	"encoding/binary"
	"math/rand"
	"strings"
	"testing"
)

// The decision about a macOS access list, on the bytes the kernel returns for one,
// on every platform. rootpath_extacl_darwin_test.go makes real lists with chmod +a
// and runs the check on them.

// kauthEntry is an entry as a test writes it.
type kauthEntry struct {
	principal extPrincipal
	flags     uint32 // the kind in the low four bits, then the inheritance flags
	rights    uint32
}

const (
	kauthDeny        = 2
	kauthInherited   = 1 << 4
	kauthFileInherit = 1 << 5
	kauthDirInherit  = 1 << 6
	kauthOnlyInherit = 1 << 8

	rightRead        = 1 << 1  // read; list
	rightExecute     = 1 << 3  // execute; search
	rightReadAttr    = 1 << 7  // readattr
	rightWriteAttr   = 1 << 8  // writeattr
	rightReadExtAttr = 1 << 9  // readextattr
	rightWriteExtatt = 1 << 10 // writeextattr
	rightReadSec     = 1 << 11 // readsecurity
)

func kauthUser(uid uint32) extPrincipal {
	var p extPrincipal
	copy(p[:12], extUserPrefix[:])
	binary.BigEndian.PutUint32(p[12:], uid)
	return p
}

func kauthGroup(gid uint32) extPrincipal {
	var p extPrincipal
	copy(p[:12], extGroupPrefix[:])
	binary.BigEndian.PutUint32(p[12:], gid)
	return p
}

// kauthBlob is a list as fgetattrlist returns it: the header, with no owner and no
// group GUID, then the entries.
func kauthBlob(entries ...kauthEntry) []byte {
	blob := make([]byte, extACLHeader, extACLHeader+extACLEntry*len(entries))
	binary.LittleEndian.PutUint32(blob[0:4], extACLMagic)
	binary.LittleEndian.PutUint32(blob[36:40], uint32(len(entries)))
	for _, entry := range entries {
		raw := make([]byte, extACLEntry)
		copy(raw[:16], entry.principal[:])
		binary.LittleEndian.PutUint32(raw[16:20], entry.flags)
		binary.LittleEndian.PutUint32(raw[20:24], entry.rights)
		blob = append(blob, raw...)
	}
	return blob
}

func kauthPermit(principal extPrincipal, rights uint32) kauthEntry {
	return kauthEntry{principal: principal, flags: extACEPermit, rights: rights}
}

func TestAnAbsentOrEmptyAccessListHasNothingToSay(t *testing.T) {
	none := kauthBlob()
	binary.LittleEndian.PutUint32(none[36:40], extACLNone)
	for name, blob := range map[string][]byte{"no value": nil, "an empty value": {}, "no entries": kauthBlob(), "marked as none": none} {
		for _, directory := range []bool{true, false} {
			if problem, err := extendedACLProblem(blob, directory); problem != "" || err != nil {
				t.Errorf("%s: %q, %v", name, problem, err)
			}
		}
	}
}

// Each right that lets an account other than root change what a path holds is
// refused, under the name chmod uses for it, and for any account at all.
func TestAnEntryThatAllowsAnAccountOtherThanRootToChangeThePathIsRefusedByTheNameOfTheRight(t *testing.T) {
	rights := []struct {
		bit             uint32
		file, directory string
	}{
		{extRightWriteData, "write", "add_file"},
		{extRightAppendData, "append", "add_subdirectory"},
		{extRightDelete, "delete", "delete"},
		{extRightDeleteChild, "delete_child", "delete_child"},
		{extRightWriteSecurity, "writesecurity", "writesecurity"},
		{extRightTakeOwner, "chown", "chown"},
	}
	principals := map[string]extPrincipal{
		"a user": kauthUser(501), "the service account's group": kauthGroup(450), "everyone": kauthGroup(12), "wheel": kauthGroup(0),
		"a user next to root":               kauthUser(1),
		"an account with a GUID of its own": {0x4e, 0x6f, 0x74, 0x20, 0x61, 0x20, 0x63, 0x6f, 0x6d, 0x70, 0x61, 0x74, 0x20, 0x69, 0x64, 0x21},
	}
	for who, principal := range principals {
		for _, right := range rights {
			for directory, name := range map[bool]string{false: right.file, true: right.directory} {
				problem, err := extendedACLProblem(kauthBlob(kauthPermit(principal, right.bit)), directory)
				if err != nil {
					t.Fatalf("%s, %s: %v", who, name, err)
				}
				want := "has an access list entry that allows " + name + " to " + principal.String()
				if problem != want {
					t.Errorf("%s, %s: %q, want %q", who, name, problem, want)
				}
			}
		}
	}
}

func TestTheMessageNamesTheRightsAndTheAccountTheWayAPersonReadsThem(t *testing.T) {
	both := kauthBlob(kauthPermit(kauthGroup(12), extRightWriteData|extRightDeleteChild))
	if problem, _ := extendedACLProblem(both, true); problem != "has an access list entry that allows add_file and delete_child to gid 12" {
		t.Errorf("%q", problem)
	}
	three := kauthBlob(kauthPermit(kauthUser(501), extRightWriteData|extRightAppendData|extRightDelete))
	if problem, _ := extendedACLProblem(three, false); problem != "has an access list entry that allows write, append and delete to uid 501" {
		t.Errorf("%q", problem)
	}
	// An account the system gave a GUID of its own is named by it, as a UUID reads.
	odd := extPrincipal{0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06}
	if problem, _ := extendedACLProblem(kauthBlob(kauthPermit(odd, extRightWriteSecurity)), true); problem != "has an access list entry that allows writesecurity to the account with the GUID DEADBEEF-0001-0002-0003-000400050006" {
		t.Errorf("%q", problem)
	}
	// Only the rights that are refused are named, not everything the entry gives.
	all := kauthBlob(kauthPermit(kauthUser(501), rightRead|rightExecute|extRightWriteData))
	if problem, _ := extendedACLProblem(all, false); problem != "has an access list entry that allows write to uid 501" {
		t.Errorf("%q", problem)
	}
}

// What takes nothing from root passes: entries that deny, entries that allow only
// what reading and looking need, root's own, and kinds that give nothing.
func TestEntriesThatTakeNothingFromRootPass(t *testing.T) {
	everything := uint32(extRightsRefused)
	for name, blob := range map[string][]byte{
		"a denial of every right":                                              kauthBlob(kauthEntry{kauthGroup(12), kauthDeny, everything}),
		"a denial of delete, as a home folder has":                             kauthBlob(kauthEntry{kauthGroup(12), kauthDeny, extRightDelete}),
		"reading, listing and searching":                                       kauthBlob(kauthPermit(kauthGroup(12), rightRead|rightExecute)),
		"reading attributes, extended attributes and the list itself":          kauthBlob(kauthPermit(kauthUser(501), rightReadAttr|rightReadExtAttr|rightReadSec)),
		"changing attributes and extended attributes, which change no content": kauthBlob(kauthPermit(kauthUser(501), rightWriteAttr|rightWriteExtatt)),
		"every right, for root":                                                kauthBlob(kauthPermit(extRoot, everything)),
		"a kind that is neither": kauthBlob(kauthEntry{kauthGroup(12), 0, everything}, kauthEntry{kauthGroup(12), 3, everything},
			kauthEntry{kauthGroup(12), 4, everything}),
		"an entry for nobody the kernel names": kauthBlob(kauthPermit(extPrincipal{}, rightRead)),
	} {
		for _, directory := range []bool{true, false} {
			if problem, err := extendedACLProblem(blob, directory); problem != "" || err != nil {
				t.Errorf("%s: %q, %v", name, problem, err)
			}
		}
	}
}

// An entry that only the files a directory makes inherit, or that is itself
// inherited, is the entry of its path as much as any other: the step makes files in
// the directories it checks.
func TestAnInheritedOrInheritOnlyEntryCountsAsMuchAsAnyOther(t *testing.T) {
	for name, flags := range map[string]uint32{
		"inherited":                      extACEPermit | kauthInherited,
		"inherited by files only":        extACEPermit | kauthFileInherit | kauthOnlyInherit,
		"inherited by directories only":  extACEPermit | kauthDirInherit | kauthOnlyInherit,
		"inherited by both":              extACEPermit | kauthFileInherit | kauthDirInherit,
		"an unknown flag next to permit": extACEPermit | 1<<12,
	} {
		blob := kauthBlob(kauthEntry{kauthGroup(12), flags, extRightWriteData})
		if problem, err := extendedACLProblem(blob, true); problem == "" || err != nil {
			t.Errorf("%s: %q, %v", name, problem, err)
		}
	}
}

// The check doesn't evaluate the list the way the kernel does: a denial that comes
// first, for the same account, doesn't clear a permit that follows. What the list
// could give someone is what is refused, whoever is asking.
func TestADenialBeforeAPermitDoesNotClearIt(t *testing.T) {
	blob := kauthBlob(kauthEntry{kauthUser(501), kauthDeny, extRightWriteData}, kauthPermit(kauthGroup(12), extRightWriteData))
	if problem, _ := extendedACLProblem(blob, true); problem == "" {
		t.Error("a permit after a denial passed")
	}
	// The first refused entry is the one named.
	blob = kauthBlob(kauthPermit(kauthGroup(12), rightRead), kauthPermit(kauthUser(7), extRightDelete), kauthPermit(kauthUser(8), extRightWriteData))
	if problem, _ := extendedACLProblem(blob, true); !strings.HasSuffix(problem, "allows delete to uid 7") {
		t.Errorf("%q", problem)
	}
}

func TestRootsOwnEntryPassesAndNoOtherGUIDDoes(t *testing.T) {
	if extRoot != kauthUser(0) {
		t.Fatalf("root is %v, and the GUID derived from user 0 is %v", extRoot, kauthUser(0))
	}
	if problem, _ := extendedACLProblem(kauthBlob(kauthPermit(kauthUser(0), extRightWriteData)), true); problem != "" {
		t.Errorf("root's entry: %q", problem)
	}
	// Group 0 is wheel, whose members aren't only root.
	for name, principal := range map[string]extPrincipal{"wheel": kauthGroup(0), "user 1": kauthUser(1), "user 2^32-1": kauthUser(1<<32 - 1)} {
		if problem, _ := extendedACLProblem(kauthBlob(kauthPermit(principal, extRightWriteData)), true); problem == "" {
			t.Errorf("%s passed", name)
		}
	}
	// A GUID that differs from root's in one byte is not root.
	lookalike := extRoot
	lookalike[0] = 0xfe
	if problem, _ := extendedACLProblem(kauthBlob(kauthPermit(lookalike, extRightWriteData)), true); problem == "" {
		t.Error("a GUID that differs from root's in one byte passed")
	}
}

func TestAccessListsThatDontHaveTheKernelsFormatAreErrorsAndNeverClean(t *testing.T) {
	good := kauthBlob(kauthPermit(kauthGroup(12), rightRead))
	badMagic := append([]byte(nil), good...)
	badMagic[0] ^= 0xff
	tooMany := kauthBlob()
	binary.LittleEndian.PutUint32(tooMany[36:40], extACLMaxEntries+1)
	countDisagrees := append([]byte(nil), good...)
	binary.LittleEndian.PutUint32(countDisagrees[36:40], 2)
	for name, blob := range map[string][]byte{
		"shorter than the header":           good[:extACLHeader-1],
		"one byte":                          {1},
		"another magic":                     badMagic,
		"more entries than a list may have": tooMany,
		"a count its size doesn't have":     countDisagrees,
		"a size its count doesn't have":     append(append([]byte(nil), good...), 0),
		"half an entry":                     good[:len(good)-12],
	} {
		if problem, err := extendedACLProblem(blob, true); err == nil || problem != "" {
			t.Errorf("%s: %q, %v", name, problem, err)
		}
	}
}

// Whatever the bytes are, the decision comes back: it never reads past what it was
// given.
func TestTheAccessListReaderNeverPanicsOnAnyBytes(t *testing.T) {
	random := rand.New(rand.NewSource(7))
	good := kauthBlob(kauthPermit(kauthGroup(12), extRightWriteData), kauthPermit(kauthUser(1), rightRead))
	for i := 0; i < 20000; i++ {
		blob := make([]byte, random.Intn(len(good)+40))
		switch i % 3 {
		case 0:
			random.Read(blob)
		case 1:
			copy(blob, good)
			if len(blob) > 0 {
				blob[random.Intn(len(blob))] = byte(random.Intn(256))
			}
		default:
			copy(blob, good)
			if len(blob) >= 40 {
				binary.LittleEndian.PutUint32(blob[36:40], random.Uint32())
			}
		}
		_, _ = extendedACLProblem(blob, i%2 == 0)
	}
}
