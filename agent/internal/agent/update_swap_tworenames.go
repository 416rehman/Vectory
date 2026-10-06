package agent

import (
	"errors"
	"fmt"
)

// The swap of a platform whose mapped executable can't be the target of a rename
// that replaces it: Windows. A running image can be renamed but not overwritten or
// deleted, and a service that has just stopped may not have let go of it yet, so
// the build that is installed steps aside under the name that keeps the previous
// build, and the staged file takes its place with a second rename. The journal
// names both files before the first rename, so a run that finds the journal
// between the two (the one moment the directory holds no executable) knows
// where the old build is and puts it back.
//
// The sequence is written once here, over two small operations, so that the same
// code runs on the Windows primitives (MoveFileEx) and, in the step's tests, on the
// Unix ones, where the reconciler's recovery from every interruption is exercised.

// twoRenames is the install directory as the two-rename swap sees it.
type twoRenames struct {
	// executable is the executable's name in the directory.
	executable string
	// rename moves from over to, both names in the directory, replacing to when it
	// is there, and doesn't return until the move is on disk.
	rename func(from, to string) error
	// present says whether a name is in the directory.
	present func(name string) (bool, error)
}

// swap makes the staged file the executable and keeps the executable it replaces
// as previous. Until the second rename the directory has no executable: when it
// fails, the first is undone at once, and when that fails too the error says so,
// and the step's next run, which reads the journal, puts the previous build back.
func (s twoRenames) swap(staged, previous string) error {
	if staged == previous {
		return errors.New("the staged file and the previous build can't be one name")
	}
	if err := s.rename(s.executable, previous); err != nil {
		return err
	}
	faultPoint("swap:previous_kept")
	if err := s.rename(staged, s.executable); err != nil {
		if undone := s.rename(previous, s.executable); undone != nil {
			return fmt.Errorf("%w (and putting the previous build back failed: %v)", err, undone)
		}
		return err
	}
	faultPoint("swap:renamed")
	return nil
}

// restore puts the previous build back in the executable's place. A build that is
// in that place (the one under trial) steps aside first, under the name the step
// removes with the rest of what a request leaves: previous with .new. Each rename
// can be done again, so a crash between them is resumed by the next run.
func (s twoRenames) restore(previous string) error {
	kept, err := s.present(previous)
	if err != nil {
		return err
	}
	if !kept {
		return fmt.Errorf("the previous build %s isn't there to put back", previous)
	}
	here, err := s.present(s.executable)
	if err != nil {
		return err
	}
	if here {
		if err := s.rename(s.executable, previous+".new"); err != nil {
			return err
		}
		faultPoint("restore:aside")
	}
	if err := s.rename(previous, s.executable); err != nil {
		return err
	}
	faultPoint("restore:renamed")
	return nil
}
