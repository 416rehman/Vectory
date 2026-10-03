package agent

import "testing"

// The Windows step's service starts its log again when it opens a file that is longer
// than a megabyte, and keeps one that is exactly that long.
func TestTheWindowsStepLogStartsAgainOnlyWhenItIsLongerThanAMegabyte(t *testing.T) {
	if maxUpdateStepLog != 1<<20 {
		t.Errorf("the step's log is allowed %d bytes", maxUpdateStepLog)
	}
	for size, want := range map[int64]bool{
		0: false, 1: false, maxUpdateStepLog - 1: false, maxUpdateStepLog: false,
		maxUpdateStepLog + 1: true, 10 * maxUpdateStepLog: true,
	} {
		if got := stepLogStartsAgain(size); got != want {
			t.Errorf("a log of %d bytes starts again: %v, want %v", size, got, want)
		}
	}
}
