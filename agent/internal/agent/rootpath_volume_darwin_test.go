//go:build darwin

package agent

import (
	"testing"

	"golang.org/x/sys/unix"
)

// The flags the check looks for are the system's own, and what fstatfs says of a real
// handle is what the check reads.

func TestTheVolumeFlagsAreTheSystemsOwn(t *testing.T) {
	if mountLocal != unix.MNT_LOCAL || mountIgnoreOwnership != unix.MNT_IGNORE_OWNERSHIP {
		t.Errorf("the flags are %#x and %#x, the system's are %#x and %#x", mountLocal, mountIgnoreOwnership, unix.MNT_LOCAL, unix.MNT_IGNORE_OWNERSHIP)
	}
}

func TestThePlatformReadsTheVolumeOfARealHandleFromFstatfs(t *testing.T) {
	fd, err := unix.Open(realTempDir(t), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)

	facts, known, err := platformVolume(fd)

	if err != nil || !known {
		t.Fatalf("the volume of a temporary directory: %+v, known %v, %v", facts, known, err)
	}
	if facts.flags&mountLocal == 0 {
		t.Errorf("the volume of a temporary directory isn't local: flags %#x", facts.flags)
	}
	if facts.mountedOn == "" {
		t.Error("the volume says nowhere that it is mounted")
	}
	// A temporary directory is on the system's own volume, which keeps owners.
	if problem := facts.problem(); problem != "" {
		t.Errorf("the volume of a temporary directory: %s", problem)
	}
}

func TestAHandleThatIsNotOpenIsAnErrorAndNeverACleanVolume(t *testing.T) {
	if _, known, err := platformVolume(-1); err == nil || known {
		t.Errorf("a descriptor that isn't open: known %v, %v", known, err)
	}
}
