package agent

import (
	"strings"
	"testing"
)

// What the flags of a file or a directory mean to the update step is decided on plain
// numbers, so that the values of every system are tested wherever the tests run.

func flagNames(flags []fileFlag) string {
	names := make([]string, len(flags))
	for i, flag := range flags {
		names[i] = flag.Name
	}
	return strings.Join(names, "|")
}

func TestOnlyTheImmutableAndAppendOnlyAttributesOfALinuxInodeStopTheStep(t *testing.T) {
	const (
		secureDelete = 0x00000001
		sync         = 0x00000008
		noAtime      = 0x00000080
		extents      = 0x00080000
		eaInode      = 0x00200000
		casefold     = 0x40000000
	)
	for name, c := range map[string]struct {
		flags uint32
		want  string
	}{
		"no flag":                          {0, ""},
		"immutable":                        {linuxImmutableFlag, "the immutable attribute (chattr +i)"},
		"append-only":                      {linuxAppendFlag, "the append-only attribute (chattr +a)"},
		"both":                             {linuxImmutableFlag | linuxAppendFlag, "the immutable attribute (chattr +i)|the append-only attribute (chattr +a)"},
		"flags that stop nothing":          {secureDelete | sync | noAtime | extents | eaInode | casefold, ""},
		"immutable among flags that don't": {secureDelete | sync | linuxImmutableFlag | noAtime | extents, "the immutable attribute (chattr +i)"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := flagNames(linuxFileFlags(c.flags)); got != c.want {
				t.Errorf("flags %#x name %q, want %q", c.flags, got, c.want)
			}
		})
	}
	// The values are the kernel's: FS_IMMUTABLE_FL and FS_APPEND_FL of linux/fs.h.
	if linuxImmutableFlag != 0x10 || linuxAppendFlag != 0x20 {
		t.Errorf("the flags are %#x and %#x", linuxImmutableFlag, linuxAppendFlag)
	}
}

func TestOnlyTheFourFlagsThatForbidAChangeOnAMacStopTheStep(t *testing.T) {
	const (
		noDump     = 0x00000001 // UF_NODUMP
		opaque     = 0x00000008 // UF_OPAQUE
		compressed = 0x00000020 // UF_COMPRESSED
		hidden     = 0x00008000 // UF_HIDDEN
		archived   = 0x00010000 // SF_ARCHIVED
		restricted = 0x00080000 // SF_RESTRICTED
		dataless   = 0x40000000 // SF_DATALESS
	)
	for name, c := range map[string]struct {
		flags uint32
		want  string
	}{
		"no flag":                       {0, ""},
		"uchg":                          {darwinUserImmutable, "the user immutable flag (chflags uchg)"},
		"uappnd":                        {darwinUserAppend, "the user append-only flag (chflags uappnd)"},
		"schg":                          {darwinSystemImmutable, "the system immutable flag (chflags schg)"},
		"sappnd":                        {darwinSystemAppend, "the system append-only flag (chflags sappnd)"},
		"uchg and schg":                 {darwinUserImmutable | darwinSystemImmutable, "the user immutable flag (chflags uchg)|the system immutable flag (chflags schg)"},
		"all four":                      {darwinUserImmutable | darwinUserAppend | darwinSystemImmutable | darwinSystemAppend, "the user immutable flag (chflags uchg)|the user append-only flag (chflags uappnd)|the system immutable flag (chflags schg)|the system append-only flag (chflags sappnd)"},
		"flags that stop nothing":       {noDump | opaque | compressed | hidden | archived | restricted | dataless, ""},
		"schg among flags that don't":   {noDump | hidden | darwinSystemImmutable | archived, "the system immutable flag (chflags schg)"},
		"uappnd among flags that don't": {opaque | darwinUserAppend | compressed, "the user append-only flag (chflags uappnd)"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := flagNames(darwinFileFlags(c.flags)); got != c.want {
				t.Errorf("flags %#x name %q, want %q", c.flags, got, c.want)
			}
		})
	}
	// The values are the system's: UF_IMMUTABLE, UF_APPEND, SF_IMMUTABLE and SF_APPEND of
	// sys/stat.h.
	if darwinUserImmutable != 0x2 || darwinUserAppend != 0x4 || darwinSystemImmutable != 0x20000 || darwinSystemAppend != 0x40000 {
		t.Errorf("the flags are %#x, %#x, %#x and %#x", darwinUserImmutable, darwinUserAppend, darwinSystemImmutable, darwinSystemAppend)
	}
}

func TestTheWordsForAFlaggedPathNameThePathTheFlagWhatTheStepCantDoAndHowToClearIt(t *testing.T) {
	if got := immutableWords("/usr/local/bin/vectory", "replace it", nil); got != "" {
		t.Errorf("no flag: %q", got)
	}
	got := immutableWords("/usr/local/bin/vectory", "replace it", linuxFileFlags(linuxImmutableFlag))
	want := "/usr/local/bin/vectory has the immutable attribute (chattr +i), so the update step can't replace it. Clear it first: sudo chattr -i /usr/local/bin/vectory"
	if got != want {
		t.Errorf("one flag:\n%q\nwant\n%q", got, want)
	}
	got = immutableWords("/Library/Application Support/Vectory/bin", "add or remove files in it", darwinFileFlags(darwinUserImmutable|darwinSystemAppend))
	want = "/Library/Application Support/Vectory/bin has the user immutable flag (chflags uchg) and the system append-only flag (chflags sappnd), so the update step can't add or remove files in it. " +
		"Clear it first: sudo chflags nouchg '/Library/Application Support/Vectory/bin'; sudo chflags nosappnd '/Library/Application Support/Vectory/bin'"
	if got != want {
		t.Errorf("two flags and a path with spaces:\n%q\nwant\n%q", got, want)
	}
}
