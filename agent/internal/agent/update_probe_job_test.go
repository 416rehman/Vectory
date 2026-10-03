package agent

import "testing"

// The limits of the job the probe runs in on Windows are values every platform can
// judge. The Windows tests read them back from a job the system made, and check that the
// values here are the ones the system defines.

func TestTheProbesJobEndsEverythingItHoldsWhenItIsClosedAndAllowsAFewProcesses(t *testing.T) {
	limits := probeJobLimits()
	if limits.Flags&jobLimitKillOnJobClose == 0 {
		t.Error("closing the job doesn't end the processes in it: a build that outlives the probe, or the step, would go on")
	}
	if limits.Flags&jobLimitActiveProcess == 0 {
		t.Error("the job has no limit on the processes it holds")
	}
	// Nothing lets a process leave the job: not the breakaway flags (0x800 and 0x1000),
	// and no flag the probe doesn't ask for.
	if limits.Flags != jobLimitKillOnJobClose|jobLimitActiveProcess {
		t.Errorf("the job's flags are %#x, want exactly the two limits it asks for", limits.Flags)
	}
	// The probe runs one program, and the system may give it a console host: a small number.
	if limits.ActiveProcesses < 2 || limits.ActiveProcesses > 8 || limits.ActiveProcesses != probeActiveProcesses {
		t.Errorf("the job holds %d processes at once, want a small number (%d)", limits.ActiveProcesses, probeActiveProcesses)
	}
}
