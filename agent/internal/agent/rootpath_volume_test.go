package agent

import (
	"strings"
	"testing"
)

// What the path check does with the volume that holds a file is decided on plain values:
// the flags fstatfs reports and where the volume is mounted. A Mac has volumes that
// ignore ownership, and ones that aren't local; the systems the tests run on don't have to
// have any.

func TestAVolumeThatKeepsOwnersAndIsLocalIsTrustedWhateverElseItIsMountedWith(t *testing.T) {
	const (
		readOnly   = 0x00000001 // MNT_RDONLY
		noExec     = 0x00000004 // MNT_NOEXEC
		noSuid     = 0x00000008 // MNT_NOSUID
		noDev      = 0x00000010 // MNT_NODEV
		quarantine = 0x00000400 // MNT_QUARANTINE
		rootFS     = 0x00004000 // MNT_ROOTFS
		volumeFS   = 0x00400000 // MNT_DOVOLFS
		journaled  = 0x00800000 // MNT_JOURNALED
		multilabel = 0x04000000 // MNT_MULTILABEL
		noAtime    = 0x10000000 // MNT_NOATIME
		snapshot   = 0x40000000 // MNT_SNAPSHOT
	)
	for name, flags := range map[string]uint32{
		"a local volume":                       mountLocal,
		"the system volume":                    mountLocal | readOnly | rootFS | volumeFS | journaled | multilabel | snapshot,
		"a data volume":                        mountLocal | noDev | volumeFS | journaled | multilabel | noAtime,
		"a volume with the options of a share": mountLocal | noExec | noSuid | noDev | quarantine,
	} {
		for _, mountedOn := range []string{"", "/", "/System/Volumes/Data", "/Volumes/Tools"} {
			if problem := (volumeFacts{flags: flags, mountedOn: mountedOn}).problem(); problem != "" {
				t.Errorf("%s mounted at %q: %s", name, mountedOn, problem)
			}
		}
	}
}

func TestAVolumeThatIgnoresOwnershipIsRefusedWithWhyAndHowToFixIt(t *testing.T) {
	for name, c := range map[string]struct {
		facts volumeFacts
		wants []string
	}{
		"mounted at a path": {
			volumeFacts{flags: mountLocal | mountIgnoreOwnership, mountedOn: "/Volumes/Tools"},
			[]string{"is on the volume mounted at /Volumes/Tools", "doesn't keep file owners", "mounted with ownership ignored", "every account as an owner of every file", "sudo diskutil enableOwnership /Volumes/Tools"},
		},
		"mounted at a path with a space": {
			volumeFacts{flags: mountLocal | mountIgnoreOwnership, mountedOn: "/Volumes/My Tools"},
			[]string{"the volume mounted at /Volumes/My Tools", "sudo diskutil enableOwnership '/Volumes/My Tools'"},
		},
		"mounted at an unknown place": {
			volumeFacts{flags: mountLocal | mountIgnoreOwnership},
			[]string{"is on a volume, which doesn't keep file owners", "sudo diskutil enableOwnership <the volume's mount point>"},
		},
		"a volume that is not local as well": {
			volumeFacts{flags: mountIgnoreOwnership, mountedOn: "/Volumes/Share"},
			[]string{"doesn't keep file owners"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			got := c.facts.problem()
			for _, want := range c.wants {
				if !strings.Contains(got, want) {
					t.Errorf("the words for %+v don't say %q:\n%s", c.facts, want, got)
				}
			}
			if !strings.Contains(got, "Put it on the system volume") {
				t.Errorf("the words don't say where else to put it:\n%s", got)
			}
		})
	}
}

func TestAVolumeThatIsNotLocalIsRefusedWithWhy(t *testing.T) {
	for _, mountedOn := range []string{"/Volumes/Share", ""} {
		got := volumeFacts{flags: 0, mountedOn: mountedOn}.problem()
		if !strings.Contains(got, "isn't stored on this Mac") || !strings.Contains(got, "changed behind this host's back") || !strings.Contains(got, "Put it on the system volume") {
			t.Errorf("a volume that isn't local, mounted at %q: %s", mountedOn, got)
		}
		if mountedOn != "" && !strings.Contains(got, "the volume mounted at "+mountedOn) {
			t.Errorf("the words don't name %s: %s", mountedOn, got)
		}
		if strings.Contains(got, "diskutil") {
			t.Errorf("owners are no fix for a volume that isn't local: %s", got)
		}
	}
}

// The values are the system's: MNT_LOCAL and MNT_IGNORE_OWNERSHIP of sys/mount.h.
func TestTheVolumeFlagsAreTheValuesOfTheSystemHeader(t *testing.T) {
	if mountLocal != 0x1000 || mountIgnoreOwnership != 0x00200000 {
		t.Errorf("the flags are %#x and %#x", mountLocal, mountIgnoreOwnership)
	}
}
