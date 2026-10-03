//go:build windows

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The job the probe runs in, on real processes. Programs that start programs are copies
// of the test binary under the name of what they do (update_windows_children_test.go);
// what they start stays running until something ends it, so a program that is still
// there afterwards is one the job didn't end.

// The flags the probe's job asks for are the values the system defines.
func TestTheFlagsOfTheProbesJobAreTheValuesTheSystemDefines(t *testing.T) {
	for name, pair := range map[string][2]uint32{
		"JOB_OBJECT_LIMIT_ACTIVE_PROCESS":    {jobLimitActiveProcess, windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS},
		"JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE": {jobLimitKillOnJobClose, windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s is %#x here and %#x in the system's header", name, pair[0], pair[1])
		}
	}
}

// A job made with the probe's limits has them: the system reads back what was asked.
func TestTheProbesJobIsMadeWithTheLimitsTheProbeAsksFor(t *testing.T) {
	limits := probeJobLimits()
	made, err := newJob(limits)
	if err != nil {
		t.Fatal(err)
	}
	defer made.close()
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(made.handle, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		t.Fatal(err)
	}
	if info.BasicLimitInformation.LimitFlags != limits.Flags || info.BasicLimitInformation.ActiveProcessLimit != limits.ActiveProcesses {
		t.Errorf("the job has flags %#x and %d processes, want %#x and %d", info.BasicLimitInformation.LimitFlags, info.BasicLimitInformation.ActiveProcessLimit, limits.Flags, limits.ActiveProcesses)
	}
}

// startedPIDs are the processes the program in dir says it started.
func startedPIDs(dir string) []uint32 {
	data, err := os.ReadFile(filepath.Join(dir, childrenFile))
	if err != nil {
		return nil
	}
	var pids []uint32
	for _, line := range strings.Fields(string(data)) {
		if pid, err := strconv.ParseUint(line, 10, 32); err == nil {
			pids = append(pids, uint32(pid))
		}
	}
	return pids
}

// processRunning reports whether a process exists and hasn't ended.
func processRunning(pid uint32) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(process) }()
	event, err := windows.WaitForSingleObject(process, 0)
	return err == nil && event == uint32(windows.WAIT_TIMEOUT)
}

// endProcess ends a process, for a test that must not leave one running.
func endProcess(pid uint32) {
	process, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return
	}
	defer func() { _ = windows.CloseHandle(process) }()
	_ = windows.TerminateProcess(process, 1)
}

// aBuildThatStartsPrograms is a directory with a copy of the test binary as the build
// called name and one as the program it starts. Whatever the build started is ended when
// the test ends, so that a failed test leaves nothing running on the machine.
func aBuildThatStartsPrograms(t *testing.T, name string) (program, dir string) {
	t.Helper()
	dir = ownTree(t)
	copyTestBinary(t, filepath.Join(dir, "probe-lingers.exe"))
	program = filepath.Join(dir, name)
	copyTestBinary(t, program)
	t.Cleanup(func() {
		for _, pid := range startedPIDs(dir) {
			endProcess(pid)
		}
	})
	return program, dir
}

func requireEnds(t *testing.T, pid uint32, what string) {
	t.Helper()
	if !becomes(10*time.Second, func() bool { return !processRunning(pid) }) {
		t.Errorf("%s (process %d) is still running", what, pid)
	}
}

// The probe's time is up, and the build that never answers is ended with the program it
// started: before this, only the build itself ended and its program went on.
func TestAProbeThatStartedAProgramEndsItWhenTheTimeIsUp(t *testing.T) {
	program, dir := aBuildThatStartsPrograms(t, "probe-spawns.exe")
	started := time.Now()
	_, err := runProbe(context.Background(), program, 3*time.Second)
	if err == nil || !strings.Contains(err.Error(), "didn't finish") {
		t.Fatalf("a build that never answered: %v", err)
	}
	if took := time.Since(started); took > 12*time.Second {
		t.Errorf("the probe took %s for a limit of 3s", took)
	}
	pids := startedPIDs(dir)
	if len(pids) != 1 {
		t.Fatalf("the build started %d programs (%v), want one", len(pids), pids)
	}
	requireEnds(t, pids[0], "the program the build started, at the probe's time limit")
}

// The step is stopped while it waits for the probe: the same ends.
func TestAProbeThatStartedAProgramEndsItWhenTheStepIsStopped(t *testing.T) {
	program, dir := aBuildThatStartsPrograms(t, "probe-spawns.exe")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		becomes(15*time.Second, func() bool { return len(startedPIDs(dir)) == 1 })
		cancel()
	}()
	if _, err := runProbe(ctx, program, time.Minute); !errors.Is(err, context.Canceled) {
		t.Fatalf("a probe the step stopped: %v", err)
	}
	pids := startedPIDs(dir)
	if len(pids) != 1 {
		t.Fatalf("the build started %d programs (%v), want one", len(pids), pids)
	}
	requireEnds(t, pids[0], "the program the build started, when the step was stopped")
}

// A build that answers and ends, and leaves a program running, leaves nothing running
// once the probe has returned: the job is closed with the probe.
func TestAProbeThatEndsLeavesNothingItStartedRunning(t *testing.T) {
	program, dir := aBuildThatStartsPrograms(t, "probe-leaves.exe")
	output, err := runProbe(context.Background(), program, 20*time.Second)
	if err != nil {
		t.Fatalf("a build that printed what a good build prints and left a program running: %v", err)
	}
	if refusal := checkProbeOutput(output, "0.1.0"); refusal != nil {
		t.Errorf("what the build printed: %v", refusal)
	}
	pids := startedPIDs(dir)
	if len(pids) != 1 {
		t.Fatalf("the build started %d programs (%v), want one", len(pids), pids)
	}
	requireEnds(t, pids[0], "the program a build left running when it ended")
}

// A build that starts more programs than the job allows is refused the extra ones by the
// system, as they are made.
func TestAProbeCannotStartMoreProgramsThanItsJobAllows(t *testing.T) {
	program, dir := aBuildThatStartsPrograms(t, "probe-fans-out.exe")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := runProbe(ctx, program, time.Minute)
		done <- err
	}()
	if !becomes(30*time.Second, func() bool { _, err := os.Stat(filepath.Join(dir, fannedOutFile)); return err == nil }) {
		t.Fatal("the build never finished trying its programs")
	}
	attempts := probeActiveProcesses + 4
	// What the system ended as it was made may take a moment to show as ended. The build
	// is one of the processes the job holds.
	alive := func() int {
		count := 0
		for _, pid := range startedPIDs(dir) {
			if processRunning(pid) {
				count++
			}
		}
		return count
	}
	if !becomes(10*time.Second, func() bool { return alive() <= probeActiveProcesses-1 }) {
		t.Errorf("%d of the programs the build started are running, and the job holds %d with the build itself", alive(), probeActiveProcesses)
	}
	if running := alive(); running >= attempts || running < 1 {
		t.Errorf("%d of %d programs are running: the job should refuse some of them and not all", running, attempts)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Errorf("the probe ended with %v", err)
	}
	for _, pid := range startedPIDs(dir) {
		requireEnds(t, pid, "a program the build started")
	}
}

// The build is in its job before it runs: asked as the first thing it does, the job it
// is in is the probe's, with the probe's limits. The step makes the process suspended and
// lets it run only once it is in the job.
func TestAProbeIsInItsJobBeforeItRunsItsFirstInstruction(t *testing.T) {
	dir := ownTree(t)
	program := filepath.Join(dir, "probe-reports-its-job.exe")
	copyTestBinary(t, program)
	output, err := runProbe(context.Background(), program, 20*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		JobError  string `json:"job_error"`
		JobFlags  uint32 `json:"job_flags"`
		JobActive uint32 `json:"job_active"`
	}
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	limits := probeJobLimits()
	if report.JobError != "" || report.JobFlags != limits.Flags || report.JobActive != limits.ActiveProcesses {
		t.Errorf("the build found its job: error %q, flags %#x, %d processes; want no error, %#x and %d", report.JobError, report.JobFlags, report.JobActive, limits.Flags, limits.ActiveProcesses)
	}
	if refusal := checkProbeOutput(output, "0.1.0"); refusal != nil {
		t.Errorf("what the build printed: %v", refusal)
	}
}
