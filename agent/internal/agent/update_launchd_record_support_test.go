//go:build !windows

package agent

import (
	"testing"
	"time"
)

// What the tests of the record of a job the step told launchd to remove need to know of how the
// step keeps it: the boot session and the awake time the host reads from the simulated Mac, the
// record as the step's own file says it, and how long it holds.

// wireMachineClock gives the step's macOS host the boot session and the time awake of the
// simulated Mac, which the machine's restart makes new.
func wireMachineClock(mac *macosUpdateHost, machine *launchdOverMachine) {
	mac.bootSession = func() string { return machine.boot }
	mac.uptime = func() (time.Duration, bool) { return machine.awake(), true }
}

// wireRecorderClock gives a host over a launchctl recorder the same.
func wireRecorderClock(host *macosUpdateHost, recorder *launchctlRecorder) {
	host.bootSession = func() string { return recorder.boot }
	host.uptime = func() (time.Duration, bool) { return recorder.clock.Sub(recorder.booted), true }
}

// recordNames is whether the step kept a record of the job it told launchd to remove, and the
// process the record names (0 when it names none: "unknown"), as the step reads its own file.
func recordNames(t *testing.T, host *macosUpdateHost) (pid int, kept bool) {
	t.Helper()
	if leavingRecord(t, host) == "" {
		return 0, false
	}
	record, ok := readLeavingJob(host.leavingPath())
	if !ok {
		t.Fatalf("%s isn't a record the step reads: %q", host.leavingPath(), leavingRecord(t, host))
	}
	if record.PID != nil {
		pid = *record.PID
	}
	return pid, true
}

// rememberRecord has the host write a record for the process pid (0 for none), as it does when
// it is about to tell launchd to remove the job.
func rememberRecord(t *testing.T, host *macosUpdateHost, pid int) {
	t.Helper()
	if err := host.rememberLeaving(pid); err != nil {
		t.Fatal(err)
	}
}

// recordLife is how long a record of a job the step told launchd to remove holds, counted in
// the time the Mac has been awake.
func recordLife() time.Duration { return leavingLife }
