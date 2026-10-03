package agent

import (
	"encoding/binary"
	"fmt"
	"math/bits"
	"strings"
	"testing"
)

// The access list decision against what the kernel itself does with an entry. The model
// below is spelled from the kernel's sources, bsd/sys/kauth.h and
// kauth_acl_evaluate in bsd/kern/kern_authorization.c, and from nothing in the reader,
// so that a disagreement between the two is the reader's: kauth.h gives the values of
// the rights, and kauth_acl_evaluate expands the generic bits of an entry's rights word
// into the rights a request names before it compares them (vfs_subr.c passes
// KAUTH_VNODE_GENERIC_ALL_BITS, ..._READ_BITS, ..._WRITE_BITS and ..._EXECUTE_BITS for
// them).

// What kauth.h defines for the rights word of an entry.
const (
	kernelReadData        = 1 << 1
	kernelWriteData       = 1 << 2
	kernelExecute         = 1 << 3
	kernelDelete          = 1 << 4
	kernelAppendData      = 1 << 5
	kernelDeleteChild     = 1 << 6
	kernelReadAttributes  = 1 << 7
	kernelWriteAttributes = 1 << 8
	kernelReadExtattrs    = 1 << 9
	kernelWriteExtattrs   = 1 << 10
	kernelReadSecurity    = 1 << 11
	kernelWriteSecurity   = 1 << 12
	kernelTakeOwnership   = 1 << 13
	kernelSynchronize     = 1 << 20
	kernelGenericAll      = 1 << 21
	kernelGenericExecute  = 1 << 22
	kernelGenericWrite    = 1 << 23
	kernelGenericRead     = 1 << 24

	// KAUTH_VNODE_GENERIC_READ_BITS, _WRITE_BITS, _EXECUTE_BITS and _ALL_BITS.
	kernelReadBits    = kernelReadData | kernelReadAttributes | kernelReadExtattrs | kernelReadSecurity
	kernelWriteBits   = kernelWriteData | kernelAppendData | kernelDelete | kernelDeleteChild | kernelWriteAttributes | kernelWriteExtattrs | kernelWriteSecurity
	kernelExecuteBits = kernelExecute
	kernelAllBits     = kernelReadBits | kernelWriteBits | kernelExecuteBits

	// Every bit the header defines for an entry. The kernel never matches any other
	// (the header says of the generic bits that they "may be present in an ACL", and of
	// the actions that aren't rights bits, such as LINKTARGET and CHECKIMMUTABLE, that
	// they aren't expressed as rights).
	kernelDefinedRights = kernelAllBits | kernelTakeOwnership | kernelSynchronize | kernelGenericAll | kernelGenericExecute | kernelGenericWrite | kernelGenericRead

	// What lets an account that matches an entry change what the object holds, what the
	// directory holds, its list or its owner. writeattr and writeextattr are the two
	// that change none of them, which the check tolerates on purpose.
	kernelChangeRights = kernelWriteData | kernelAppendData | kernelDelete | kernelDeleteChild | kernelWriteSecurity | kernelTakeOwnership
)

// kernelExpand is kauth_acl_evaluate's expansion of the generic bits.
func kernelExpand(rights uint32) uint32 {
	if rights&kernelGenericAll != 0 {
		rights |= kernelAllBits
	}
	if rights&kernelGenericRead != 0 {
		rights |= kernelReadBits
	}
	if rights&kernelGenericWrite != 0 {
		rights |= kernelWriteBits
	}
	if rights&kernelGenericExecute != 0 {
		rights |= kernelExecuteBits
	}
	return rights
}

// kernelLetsChange says the kernel lets an account the entry applies to change the
// object, or what is made in it.
func kernelLetsChange(e extEntry) bool {
	return e.kind == extACEPermit && e.principal != extRoot && kernelExpand(e.rights)&kernelChangeRights != 0
}

// mustRefuse is what the check must say of a list, by the model: refused when an entry
// for an account other than root permits a right the kernel lets change something, or a
// bit the header doesn't define, which no check of the kernel's compares and so nothing
// says what it grants.
func mustRefuse(entries []extEntry) bool {
	for _, e := range entries {
		if e.kind != extACEPermit || e.principal == extRoot {
			continue
		}
		if kernelLetsChange(e) || e.rights&^kernelDefinedRights != 0 {
			return true
		}
	}
	return false
}

// The generic rights an entry for another account carries are refused, for each way an
// entry reaches an object: its own, inherited, and inherit-only (the step makes files
// in the directories it checks, and such an entry decides who may rewrite them), for a
// directory and for a file, and for each kind of principal. The kernel expands
// KAUTH_ACE_GENERIC_WRITE and KAUTH_ACE_GENERIC_ALL into write, append, delete,
// delete_child, writeattr, writeextattr and writesecurity, and nothing rejects such an
// entry when it is set: chmod(1) can't make one, and the access list functions, device
// management, an SMB share and a parent's inheritable entry can.
func TestAnEntryWithAGenericRightForAnotherAccountIsRefused(t *testing.T) {
	principals := map[string]extPrincipal{"a service account (uid 450)": kauthUser(450), "everyone": kauthGroup(12), "admin": kauthGroup(80)}
	flagsets := map[string]uint32{
		"its own":                extACEPermit,
		"inherited":              extACEPermit | kauthInherited,
		"inherit-only, children": extACEPermit | kauthFileInherit | kauthDirInherit | kauthOnlyInherit,
	}
	rightsets := map[string]struct {
		rights uint32
		named  string
	}{
		"generic_write":        {kernelGenericWrite, "generic_write"},
		"generic_all":          {kernelGenericAll, "generic_all"},
		"generic_write | read": {kernelGenericWrite | kernelReadData, "generic_write"},
	}
	combinations := 0
	for who, principal := range principals {
		for how, flags := range flagsets {
			for what, set := range rightsets {
				for _, directory := range []bool{true, false} {
					combinations++
					blob := kauthBlob(kauthEntry{principal, flags, set.rights})
					entries, err := parseExtendedACL(blob)
					if err != nil || len(entries) != 1 {
						t.Fatalf("%v %v", entries, err)
					}
					if !kernelLetsChange(entries[0]) {
						t.Fatalf("the model says the kernel doesn't let %s change anything with %s", who, what)
					}
					problem, err := extendedACLProblem(blob, directory)
					if err != nil {
						t.Fatal(err)
					}
					if want := "has an access list entry that allows " + set.named + " to " + principal.String(); problem != want {
						t.Errorf("%s entry (%s) for %s, directory=%v: %q, want %q", what, how, who, directory, problem, want)
					}
				}
			}
		}
	}
	if combinations != 54 {
		t.Fatalf("%d combinations", combinations)
	}
}

// The list the fuzzer found: its entry carries rights 0x3030410a, which holds read,
// execute, writeattr, synchronize and the generic all right (which the kernel expands
// into write, delete and writesecurity), bits the header doesn't define, and a kind of
// 1 (permit) with the principal of a GUID of its own.
func TestTheListTheFuzzerFoundIsRefused(t *testing.T) {
	zeros := extPrincipal{}
	for i := range zeros {
		zeros[i] = '0'
	}
	blob := kauthBlob(kauthEntry{zeros, 0x30303031, 0x3030410a}, kauthEntry{zeros, 0x30303030, 0x30303030})
	problem, err := extendedACLProblem(blob, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := "has an access list entry that allows generic_all and an unknown right (0x30004000) to the account with the GUID 30303030-3030-3030-3030-303030303030"; problem != want {
		t.Errorf("%q, want %q", problem, want)
	}
}

// Only reading, listing, searching and executing, and what changes neither the content,
// the mode, the flags, the list nor a file's owner, pass for an account other than root. Each
// bit of the rights word is tried alone, defined or not, against the kernel's header.
func TestEachBitOfAnEntryForAnotherAccountPassesOnlyIfItIsOneOfTheToleratedRights(t *testing.T) {
	tolerated := uint32(kernelReadData | kernelExecute | kernelReadAttributes | kernelWriteAttributes | kernelReadExtattrs | kernelWriteExtattrs |
		kernelReadSecurity | kernelSynchronize | kernelGenericExecute | kernelGenericRead)
	for bit := 0; bit < 32; bit++ {
		rights := uint32(1) << bit
		for _, directory := range []bool{true, false} {
			problem, err := extendedACLProblem(kauthBlob(kauthPermit(kauthUser(501), rights)), directory)
			if err != nil {
				t.Fatal(err)
			}
			if passes := rights&tolerated != 0; passes != (problem == "") {
				t.Errorf("bit %d (%#x): the entry passes: %v, and it should: %v (said %q)", bit, rights, problem == "", passes, problem)
			}
			// The model agrees: nothing tolerated lets the kernel change anything, and nothing
			// else is both defined and harmless.
			if rights&tolerated != 0 && kernelLetsChange(extEntry{principal: kauthUser(501), kind: extACEPermit, rights: rights}) {
				t.Errorf("bit %d is tolerated and the kernel lets an account that holds it change the object", bit)
			}
		}
	}
	// Together too: every tolerated right at once passes, and any one refused bit refuses
	// the whole entry.
	if problem, _ := extendedACLProblem(kauthBlob(kauthPermit(kauthGroup(12), tolerated)), false); problem != "" {
		t.Errorf("every tolerated right at once: %q", problem)
	}
	for bit := 0; bit < 32; bit++ {
		if rights := uint32(1) << bit; rights&tolerated == 0 {
			if problem, _ := extendedACLProblem(kauthBlob(kauthPermit(kauthGroup(12), tolerated|rights)), false); problem == "" {
				t.Errorf("a refused bit (%d) next to every tolerated one passed", bit)
			}
		}
	}
}

// What the message says of the bits chmod has no name for: the generic rights by their
// names in the header, and the bits the header doesn't define together, in hex.
func TestTheMessageNamesTheGenericRightsAndTheBitsNoRightOfTheKernelsIs(t *testing.T) {
	for name, c := range map[string]struct {
		rights uint32
		want   string
	}{
		"generic write":                            {kernelGenericWrite, "generic_write"},
		"generic all":                              {kernelGenericAll, "generic_all"},
		"both, and a right of the list":            {kernelGenericAll | kernelGenericWrite | kernelDelete, "delete, generic_write and generic_all"},
		"one undefined bit":                        {1 << 14, "an unknown right (0x4000)"},
		"two undefined bits":                       {1<<14 | 1<<30, "an unknown right (0x40004000)"},
		"a right of the list and an undefined bit": {kernelWriteData | 1<<19, "write and an unknown right (0x80000)"},
		"the bit the header gives no right":        {1 << 0, "an unknown right (0x1)"},
		"an action that isn't a right":             {1 << 25, "an unknown right (0x2000000)"},
	} {
		problem, err := extendedACLProblem(kauthBlob(kauthPermit(kauthUser(7), c.rights)), false)
		if want := "has an access list entry that allows " + c.want + " to uid 7"; err != nil || problem != want {
			t.Errorf("%s: %q, %v; want %q", name, problem, err, want)
		}
	}
}

// What the kernel never reads, and a denial, take nothing from root: an entry that is not
// a permit passes with any rights, and root's own entry passes with all of them.
func TestEntriesThatPermitNothingOrAreRootsPassWhateverTheirRights(t *testing.T) {
	everything := ^uint32(0)
	for name, blob := range map[string][]byte{
		"a denial of every bit":      kauthBlob(kauthEntry{kauthGroup(12), kauthDeny, everything}),
		"kinds that give nothing":    kauthBlob(kauthEntry{kauthGroup(12), 0, everything}, kauthEntry{kauthGroup(12), 3, everything}, kauthEntry{kauthGroup(12), 4, everything}, kauthEntry{kauthGroup(12), 15, everything}),
		"every bit, for root":        kauthBlob(kauthPermit(extRoot, everything)),
		"every bit, for root, again": kauthBlob(kauthEntry{extRoot, extACEPermit | kauthInherited, everything}),
	} {
		for _, directory := range []bool{true, false} {
			if problem, err := extendedACLProblem(blob, directory); problem != "" || err != nil {
				t.Errorf("%s: %q, %v", name, problem, err)
			}
		}
	}
}

// A header that claims the largest count allocates nothing in proportion to it, and the
// largest list the kernel can return costs one allocation for its entries.
func TestAHostileCountOfEntriesAllocatesNothingInProportion(t *testing.T) {
	blob := kauthBlob()
	binary.LittleEndian.PutUint32(blob[36:40], 0xfffffffe)
	if allocs := testing.AllocsPerRun(1000, func() { _, _ = parseExtendedACL(blob) }); allocs > 2 {
		t.Errorf("%v allocations for a count of 2^32-2", allocs)
	}
	big := make([]byte, extACLHeader+extACLEntry*extACLMaxEntries)
	copy(big, kauthBlob())
	binary.LittleEndian.PutUint32(big[36:40], extACLMaxEntries)
	if allocs := testing.AllocsPerRun(1000, func() { _, _ = parseExtendedACL(big) }); allocs > 2 {
		t.Errorf("%v allocations for the largest list the kernel can return", allocs)
	}
}

// accessListSeeds are lists the fuzz targets start from: none, empty, ordinary entries,
// and entries with the bits that are hard to get right.
func accessListSeeds(f *testing.F) {
	none := kauthBlob()
	binary.LittleEndian.PutUint32(none[36:40], extACLNone)
	zeros := extPrincipal{}
	for i := range zeros {
		zeros[i] = '0'
	}
	for _, seed := range [][]byte{
		nil, {}, kauthBlob(), none,
		kauthBlob(kauthPermit(kauthGroup(12), rightRead)),
		kauthBlob(kauthPermit(kauthUser(450), rightRead|rightExecute), kauthEntry{kauthGroup(12), kauthDeny, kernelDelete}),
		kauthBlob(kauthPermit(extRoot, kernelChangeRights), kauthPermit(kauthGroup(80), rightReadSec)),
		kauthBlob(kauthPermit(kauthUser(450), kernelGenericWrite)),
		kauthBlob(kauthPermit(kauthUser(450), kernelGenericAll|kernelReadData)),
		kauthBlob(kauthEntry{zeros, 0x30303031, 0x3030410a}, kauthEntry{zeros, 0x30303030, 0x30303030}),
	} {
		f.Add(seed, true)
		f.Add(seed, false)
	}
}

// The reader never panics, allocates in proportion to what it was given or loops, an
// unreadable list never passes, and a list that parses has exactly the kernel's layout.
func FuzzTheAccessListReaderOnAnyBytes(f *testing.F) {
	accessListSeeds(f)
	f.Fuzz(func(t *testing.T, blob []byte, directory bool) {
		entries, err := parseExtendedACL(blob)
		problem, problemErr := extendedACLProblem(blob, directory)
		if (err == nil) != (problemErr == nil) {
			t.Fatalf("the parser says %v and the decision %v", err, problemErr)
		}
		if err != nil {
			if problem != "" || entries != nil {
				t.Fatalf("an unreadable list said %q / %v", problem, entries)
			}
			return
		}
		if len(entries) > extACLMaxEntries {
			t.Fatalf("%d entries", len(entries))
		}
		if len(blob) == 0 {
			return
		}
		count := binary.LittleEndian.Uint32(blob[36:40])
		if binary.LittleEndian.Uint32(blob[0:4]) != extACLMagic {
			t.Fatal("a list without the magic parsed")
		}
		if count != extACLNone && len(blob) != extACLHeader+extACLEntry*int(count) {
			t.Fatalf("size %d and count %d disagree and it parsed", len(blob), count)
		}
	})
}

// The verdict against the kernel's expansion: a list is refused exactly when an entry
// for an account other than root permits a right the kernel lets change something, or a
// bit the header doesn't define. Over and under: a list the model passes is passed, so a
// right the check tolerates isn't refused, and a list the kernel lets someone change
// something with is never passed.
func FuzzTheAccessListVerdictAgainstTheKernelsExpansion(f *testing.F) {
	accessListSeeds(f)
	f.Fuzz(func(t *testing.T, blob []byte, directory bool) {
		entries, err := parseExtendedACL(blob)
		if err != nil {
			return
		}
		problem, problemErr := extendedACLProblem(blob, directory)
		if problemErr != nil {
			t.Fatalf("a list that parses gave %v", problemErr)
		}
		if refused := problem != ""; refused != mustRefuse(entries) {
			t.Fatalf("the check says %q for %s, and by the kernel's expansion it should refuse: %v", problem, describeList(entries), mustRefuse(entries))
		}
	})
}

// describeList writes a list for a failure message.
func describeList(entries []extEntry) string {
	var parts []string
	for _, e := range entries {
		parts = append(parts, fmt.Sprintf("{kind %d, rights %#x (expanded %#x), %s}", e.kind, e.rights, kernelExpand(e.rights), e.principal))
	}
	return "[" + strings.Join(parts, " ") + "]"
}

// The model's own arithmetic, so that a mistake in it doesn't pass for the reader's.
func TestTheKernelModelExpandsTheGenericRightsAsTheHeaderSays(t *testing.T) {
	if bits.OnesCount32(kernelDefinedRights) != 18 {
		t.Errorf("the model defines %d bits, and the header has 14 rights and 4 generic ones", bits.OnesCount32(kernelDefinedRights))
	}
	for rights, want := range map[uint32]uint32{
		kernelGenericRead:    kernelGenericRead | kernelReadData | kernelReadAttributes | kernelReadExtattrs | kernelReadSecurity,
		kernelGenericExecute: kernelGenericExecute | kernelExecute,
		kernelGenericWrite:   kernelGenericWrite | kernelWriteData | kernelAppendData | kernelDelete | kernelDeleteChild | kernelWriteAttributes | kernelWriteExtattrs | kernelWriteSecurity,
		kernelGenericAll:     kernelGenericAll | kernelAllBits, // every right of the three groups, and not take_ownership
		kernelWriteData:      kernelWriteData,
	} {
		if got := kernelExpand(rights); got != want {
			t.Errorf("%#x expands to %#x, want %#x", rights, got, want)
		}
	}
	if kernelExpand(kernelGenericAll)&kernelTakeOwnership != 0 {
		t.Error("the generic all right expands to take_ownership; the kernel's expansion has no such bit")
	}
}
