//go:build !windows

package agent

import (
	"errors"
	"testing"
	"time"
)

// Whether turning updates off can go through is looked at before anything changes, and a real run
// looks at a rollback through the step's lock: a rollback whose run is under way isn't waiting for a
// start, and the lock is what tells. It waits for the run that is trying to start the previous build,
// up to the longest the removal waits. A dry run must change nothing and wait for nothing, so it
// reads the step's files as they are.
func TestAnUpdateInProgressIsReadWithoutTheStepsLockAndWithoutWaitingWhenTheCallerWillNotWait(t *testing.T) {
	f, _, _, _ := heldRollback(t)
	start := f.clock.Now()
	holdTheLockFor(f, 1000*time.Hour)

	// Not waiting, it reads the journal as it is: the previous build is in place and only its start
	// is missing, which the removal would end, so there is nothing in progress that refuses.
	if err := updateInProgress(false); err != nil {
		t.Errorf("a reading of a rollback that only waits for a start: %v", err)
	}
	if waited := f.clock.Now().Sub(start); waited != 0 {
		t.Errorf("a reading waited %s for the run that holds the step's lock", waited)
	}

	// Waiting, the same call waits for that run, and when it doesn't end says the rollback is under way.
	err := updateInProgress(true)
	var busy *UpdateBusyError
	if !errors.As(err, &busy) || busy.Message != rollbackBusyWords {
		t.Fatalf("a call that waits, with the lock held for the whole wait: %v", err)
	}
	if waited := f.clock.Now().Sub(start); waited < removalLockWait {
		t.Errorf("a call that waits gave up after %s", waited)
	}
}
