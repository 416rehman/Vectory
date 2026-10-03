//go:build !windows

package agent

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// The path check reads the volume of every handle it judges. Here the read is replaced by
// a table, so that the check's answer for a volume that ignores ownership or isn't local
// is shown on any system, with the real handles of a real tree.

type inode struct{ dev, ino uint64 }

func inodeOf(t *testing.T, path string) inode {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	return inode{uint64(st.Dev), uint64(st.Ino)}
}

// volumeTable is a reader of volumes that gives the facts of the handles of the given
// paths from the table, and an ordinary local volume for every other handle. It counts
// the handles it was asked about.
func volumeTable(t *testing.T, facts map[string]volumeFacts) (reader *volumeReader, asked *int) {
	t.Helper()
	special := map[inode]volumeFacts{}
	for path, f := range facts {
		special[inodeOf(t, path)] = f
	}
	count := 0
	return &volumeReader{read: func(fd int) (volumeFacts, bool, error) {
		count++
		var st unix.Stat_t
		if err := unix.Fstat(fd, &st); err != nil {
			return volumeFacts{}, false, err
		}
		if f, ok := special[inode{uint64(st.Dev), uint64(st.Ino)}]; ok {
			return f, true, nil
		}
		return volumeFacts{flags: mountLocal, mountedOn: "/"}, true, nil
	}}, &count
}

// useVolumes makes the path check read volumes from the table until the test ends; it
// builds on the trust the test's tree set (ownTree).
func useVolumes(t *testing.T, facts map[string]volumeFacts) (asked *int) {
	t.Helper()
	reader, asked := volumeTable(t, facts)
	trust := rootOwnedTrust
	trust.volume = reader
	rootOwnedTrust = trust
	return asked
}

func TestOpenRootOwnedRefusesAnyComponentOnAVolumeThatIgnoresOwnershipAtEachDepth(t *testing.T) {
	root, file := policyTree(t)
	for _, depth := range []string{"a", "a/b", "a/b/c", "a/b/c/file"} {
		component := filepath.Join(root, filepath.FromSlash(depth))
		useVolumes(t, map[string]volumeFacts{component: {flags: mountLocal | mountIgnoreOwnership, mountedOn: "/Volumes/Tools"}})
		for _, kind := range []struct {
			path string
			kind rootOwnedKind
		}{{file, rootOwnedFile}, {filepath.Dir(file), rootOwnedDirectory}} {
			if depth == "a/b/c/file" && kind.kind == rootOwnedDirectory {
				continue
			}
			_, err := openRootOwned(kind.path, kind.kind)
			refusal := refusedAs(t, err)
			want := component + " is on the volume mounted at /Volumes/Tools, which doesn't keep file owners"
			if !strings.HasPrefix(refusal.Detail, want) || !strings.Contains(refusal.Detail, "sudo diskutil enableOwnership /Volumes/Tools") {
				t.Errorf("a volume that ignores ownership at %s, opening %s: %q", depth, kind.path, refusal.Detail)
			}
		}
	}
}

func TestOpenRootOwnedRefusesAComponentOnAVolumeThatIsNotLocal(t *testing.T) {
	root, file := policyTree(t)
	share := filepath.Join(root, "a", "b")
	useVolumes(t, map[string]volumeFacts{share: {flags: 0, mountedOn: "/Volumes/Share"}})

	_, err := openRootOwned(file, rootOwnedFile)

	refusal := refusedAs(t, err)
	if want := share + " is on the volume mounted at /Volumes/Share, which isn't stored on this Mac"; !strings.HasPrefix(refusal.Detail, want) {
		t.Errorf("a volume that isn't local: %q", refusal.Detail)
	}
}

// A file or a directory on an ordinary volume is as it was, and the volume of every judged
// component is asked: the directories below the anchor and the file.
func TestOpenRootOwnedOnALocalVolumeThatKeepsOwnersIsAsItWasAndAsksAboutEveryJudgedComponent(t *testing.T) {
	_, file := policyTree(t)
	asked := useVolumes(t, nil)

	mustOpen(t, file, rootOwnedFile)

	// a, a/b, a/b/c and the file: the anchor and what is above it aren't judged.
	if *asked != 4 {
		t.Errorf("the volume was read for %d handles, want the 4 that are judged", *asked)
	}
}

// A check that can't read the volume doesn't take the path for clean: it fails, and the
// error says what it couldn't read.
func TestOpenRootOwnedDoesNotTakeAPathForCleanWhenItCantReadItsVolume(t *testing.T) {
	_, file := policyTree(t)
	failure := errors.New("fstatfs: input/output error")
	trust := rootOwnedTrust
	trust.volume = &volumeReader{read: func(int) (volumeFacts, bool, error) { return volumeFacts{}, false, failure }}
	rootOwnedTrust = trust

	_, err := openRootOwned(file, rootOwnedFile)

	var pathErr *fs.PathError
	if !errors.As(err, &pathErr) || pathErr.Op != "read the volume of" || !errors.Is(err, failure) {
		t.Fatalf("a volume that can't be read: %v", err)
	}
}

// A volume that says nothing (the reader of a system with no such flags) judges nothing,
// and a file's owner and mode still decide.
func TestAnUnknownVolumeJudgesNothingAndTheOwnerAndTheModeStillDecide(t *testing.T) {
	_, file := policyTree(t)
	trust := rootOwnedTrust
	trust.volume = &volumeReader{read: func(int) (volumeFacts, bool, error) { return volumeFacts{}, false, nil }}
	rootOwnedTrust = trust
	mustOpen(t, file, rootOwnedFile)

	if err := os.Chmod(file, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := openRootOwned(file, rootOwnedFile); err == nil {
		t.Error("a file everyone can write was opened")
	}
}

// A walk that judges nothing (the reader of a file that is read and not trusted) never
// reads the volume either.
func TestAWalkThatJudgesNothingNeverReadsTheVolume(t *testing.T) {
	_, file := policyTree(t)
	reader, asked := volumeTable(t, map[string]volumeFacts{file: {flags: mountIgnoreOwnership}})
	trust := rootOwnedTrust
	trust.volume, trust.unjudged = reader, true

	held, err := walkOwned(file, rootOwnedFile, trust, nil)
	if err != nil {
		t.Fatalf("a file on a volume that ignores ownership, in a walk that judges nothing: %v", err)
	}
	held.Close()
	if *asked != 0 {
		t.Errorf("the volume was read %d times in a walk that judges nothing", *asked)
	}

	trust.unjudged = false
	if _, err := walkOwned(file, rootOwnedFile, trust, nil); err == nil {
		t.Error("the same file was opened in a walk that judges")
	}
}
