//go:build !windows

package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The whole step through the macOS host. The simulated machine of the step's other
// tests keeps the agent's service in files; here launchctl is a fake over those
// files, and the step reaches the service only as it does on a Mac: it reads
// `launchctl print`, boots the job out and bootstraps it again. What the shared
// reconciler decides is tested once, with the machine itself; these tests show that
// what the macOS host says to it, and what it says back to launchd, lets it decide
// the same way: a good build commits, a build that can't start is taken back as
// launchd shows it (runs that count up, or a job it doesn't know), a build that
// never checks in is taken back at the deadline, and the step's own definition is
// loaded and unloaded with its files.

// launchdOverMachine is launchctl over the fixture's simulated service.
type launchdOverMachine struct {
	f     *stepFixture
	calls []string
}

const (
	machineAgentTarget = "system/io.vectory.agent"
	machineStepTarget  = "system/io.vectory.update"
)

func (m *launchdOverMachine) run(ctx context.Context, args ...string) launchctlResult {
	m.calls = append(m.calls, strings.Join(args, " "))
	switch args[0] {
	case "print":
		if args[1] != machineAgentTarget {
			return notLoaded
		}
		state, err := m.f.host.ServiceState(ctx)
		if err != nil {
			return launchctlResult{status: 5, stderr: err.Error()}
		}
		return renderLaunchdPrint(state)
	case "bootout":
		if args[1] == machineAgentTarget {
			if err := m.f.host.StopService(ctx); err != nil {
				return launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"}
			}
		}
	case "bootstrap", "kickstart":
		if args[len(args)-1] == machineAgentTarget || strings.HasSuffix(args[len(args)-1], "io.vectory.agent.plist") {
			if err := m.f.host.StartService(ctx); err != nil {
				return launchctlResult{status: 5, stderr: err.Error()}
			}
		}
	}
	return launchctlResult{}
}

// renderLaunchdPrint is what launchd prints for a job in the state the simulated
// service is in: a job that is running has a process, a job waiting out its throttle
// has none and says so, and a job that is gone isn't known. launchd keeps a job
// that has KeepAlive, so a service the simulation calls failed is only waiting.
func renderLaunchdPrint(state updateServiceState) launchctlResult {
	switch state.State {
	case "inactive":
		return notLoaded
	case "active":
		return launchctlResult{stdout: fmt.Sprintf("system/io.vectory.agent = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /usr/local/bin/vectory\n\truns = %d\n\tpid = %d\n\tforks = 0\n}\n", state.Restarts+1, state.PID)}
	}
	return launchctlResult{stdout: fmt.Sprintf("system/io.vectory.agent = {\n\tactive count = 0\n\tstate = spawn scheduled\n\n\truns = %d\n\tlast exit code = 1\n}\n", state.Restarts+1)}
}

// launchdHost is the fixture's host with the service manager and the step's own
// definition replaced by the macOS host's.
type launchdHost struct {
	*fakeHost
	mac *macosUpdateHost
}

func (h *launchdHost) ServiceState(ctx context.Context) (updateServiceState, error) {
	return h.mac.ServiceState(ctx)
}
func (h *launchdHost) StopService(ctx context.Context) error  { return h.mac.StopService(ctx) }
func (h *launchdHost) StartService(ctx context.Context) error { return h.mac.StartService(ctx) }
func (h *launchdHost) InstallUnits(spec updateUnitSpec) error { return h.mac.InstallUnits(spec) }
func (h *launchdHost) RemoveUnits() (string, bool, error)     { return h.mac.RemoveUnits() }

// useLaunchd makes the fixture's step reach its service through launchd.
func (f *stepFixture) useLaunchd() (*launchdOverMachine, *macosUpdateHost) {
	f.t.Helper()
	root := filepath.Dir(filepath.Dir(filepath.Dir(f.paths.PolicyDir)))
	daemons := filepath.Join(root, "Library", "LaunchDaemons")
	mkdirMode(f.t, daemons, 0o755)
	machine := &launchdOverMachine{f: f}
	mac := newMacOSUpdateHost(machine.run)
	mac.daemonDir = daemons
	mac.receipt = filepath.Join(root, "receipts", "com.vectory.agent.bom")
	mac.agent = mac.job("", machine.run)
	mac.step = mac.job(updateLaunchdLabel, machine.run)
	// The agent's definition is there, as setup left it, and a pause between two
	// tries of a bootstrap is time that passes on the machine's clock.
	if err := os.WriteFile(mac.agent.definition, []byte(launchdPlist(f.exe, f.stateDir, "_vectory")), 0o644); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chmod(mac.agent.definition, 0o644); err != nil {
		f.t.Fatal(err)
	}
	for _, job := range []*launchdJob{&mac.agent, &mac.step} {
		job.sleep = func(d time.Duration) { f.clock.advance(d) }
		job.now = f.clock.Now
	}
	updateHostOverride = &launchdHost{fakeHost: f.host, mac: mac}
	return machine, mac
}

// launchctlChanges are the calls that changed something, in order.
func (m *launchdOverMachine) changes() []string {
	var changes []string
	for _, call := range m.calls {
		if !strings.HasPrefix(call, "print ") {
			changes = append(changes, call)
		}
	}
	return changes
}

func TestAGoodBuildIsTriedAndCommittedThroughLaunchd(t *testing.T) {
	f := newStepFixture(t)
	machine, mac := f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)

	f.mustRun()

	if got := f.executableDigest(); got != release.buildSHA() {
		t.Fatalf("the executable is %s, want the new build %s", got, release.buildSHA())
	}
	if f.status().Last == nil || f.status().Last.Outcome != UpdateOutcomeCommitted || f.status().Last.FromVersion != "0.1.0" || f.status().Last.ToVersion != "0.1.1" {
		t.Errorf("the result: %+v", f.status().Last)
	}
	if got := fileDigest(t, filepath.Join(f.installDir, ".vectory-previous")); got != oldDigest {
		t.Errorf("the previous build kept beside the executable is %s, want %s", got, oldDigest)
	}
	// launchd was asked to unload the agent's job once and to load it once, and
	// nothing else of the agent's was changed.
	want := []string{"bootout " + machineAgentTarget, "bootstrap system " + mac.agent.definition}
	if got := machine.changes(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("launchd was asked %v, want %v", got, want)
	}
	if got := strings.Join(f.service().History, ","); got != "start 0.1.0,stop,start 0.1.1" {
		t.Errorf("the service's history: %s", got)
	}
}

func TestABuildThatCannotStartIsTakenBackAsLaunchdShowsItAndNotAtTheDeadline(t *testing.T) {
	for behavior, c := range map[string]struct {
		limit   time.Duration
		history string
	}{
		// launchd keeps starting it: the runs count up, and three more than the first end
		// the trial. The job is loaded, so it is booted out before the previous build is
		// put back.
		"crash": {30 * time.Second, "start 0.1.0,stop,start 0.1.2,stop,start 0.1.0"},
		// launchd doesn't know the job any more, so there is nothing to boot out.
		"exit": {10 * time.Second, "start 0.1.0,stop,start 0.1.2,start 0.1.0"},
	} {
		t.Run(behavior, func(t *testing.T) {
			f := newStepFixture(t)
			f.useLaunchd()
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", behavior, releaseOptions{})
			f.stage(release)
			started := f.clock.Now()
			f.mustRun()
			f.requireTakenBack(oldDigest, release, "START_FAILED")
			if elapsed := f.clock.Now().Sub(started); elapsed > c.limit {
				t.Errorf("the rollback took %s of the five minutes", elapsed)
			}
			if got := strings.Join(f.service().History, ","); got != c.history {
				t.Errorf("the service's history: %s, want %s", got, c.history)
			}
		})
	}
}

// What the step writes to its log says what launchd showed when it ended the trial of a
// build that couldn't start: a job that keeps being started and ending, or a job that
// launchd doesn't know. The agent's own standard error goes nowhere, so this is what a
// person reading the step's log has.
func TestTheStepsLogSaysWhatLaunchdShowedWhenABuildCouldNotStart(t *testing.T) {
	for behavior, want := range map[string]string{
		"crash": `the service manager shows the agent's service activating after 3 restart(s) since the watch began: launchd says the job is "spawn scheduled"`,
		"exit":  `the service manager shows the agent's service inactive after 0 restart(s) since the watch began: launchd doesn't know the job (launchctl print exited 113`,
	} {
		t.Run(behavior, func(t *testing.T) {
			f := newStepFixture(t)
			f.useLaunchd()
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", behavior, releaseOptions{})
			f.stage(release)
			log := captureStepLog(t, f.mustRun)
			f.requireTakenBack(oldDigest, release, "START_FAILED")
			if !strings.Contains(log, want) {
				t.Errorf("the step's log:\n%s\nwant it to say %q", log, want)
			}
		})
	}
}

// captureStepLog runs run and returns what the step wrote to standard error meanwhile.
func captureStepLog(t *testing.T, run func()) string {
	t.Helper()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = write
	text := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(read)
		text <- string(data)
	}()
	func() {
		defer func() {
			os.Stderr = saved
			write.Close()
		}()
		run()
	}()
	return <-text
}

// A build that runs and never checks in is the deadline's, not the run counter's: its
// job is running with a process, launchd has started it once, and the step waits the five
// minutes.
func TestABuildThatNeverChecksInIsTakenBackAtTheDeadlineThroughLaunchd(t *testing.T) {
	f := newStepFixture(t)
	f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.3", "silent", releaseOptions{})
	f.stage(release)
	f.mustRun()
	started := f.status().Last.At
	f.requireTakenBack(oldDigest, release, "NO_CHECK_IN")
	if journal, _ := f.journal(); started.Sub(journal.StartedAt) < updateTrialDuration {
		t.Errorf("the step gave up after %s of a trial that lasts %s", started.Sub(journal.StartedAt), updateTrialDuration)
	}
}

// A build that checks in and was started again by launchd once is not healthy: "no
// restart since the trial began" is read from the runs.
func TestABuildLaunchdStartedAgainIsNotHealthyThroughLaunchd(t *testing.T) {
	f := newStepFixture(t)
	f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.4", "restarted", releaseOptions{})
	f.stage(release)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "UNHEALTHY")
}

// A job that launchd won't boot out is the step's INTERRUPTED, as a service that
// won't stop is anywhere: the executable isn't replaced, and the request ends.
func TestAJobThatWontBeBootedOutLeavesTheExecutableAsItWasThroughLaunchd(t *testing.T) {
	f := newStepFixture(t)
	f.useLaunchd()
	f.host.cfg.StopFails = true
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	f.mustRun()
	if got := f.executableDigest(); got != oldDigest {
		t.Errorf("the executable changed to %s", got)
	}
	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
}

func TestInstallingAndRemovingTheStepRegistersAndUnregistersItsLaunchDaemonWithItsFiles(t *testing.T) {
	f := freshHost(t)
	machine, mac := f.useLaunchd()
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	definition := mac.step.definition
	wantText, err := launchdUpdatePlist(updateUnitSpec{StateDir: f.stateDir, InstallDir: f.installDir, Helper: f.paths.HelperExecutable}, f.paths)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(definition); err != nil || string(got) != wantText {
		t.Errorf("the definition: %q, %v", got, err)
	}
	if got := modeOf(t, definition); got != 0o644 {
		t.Errorf("the definition is %04o", got)
	}
	if got := machine.changes(); strings.Join(got, "|") != "enable "+machineStepTarget+"|bootstrap system "+definition {
		t.Errorf("launchd was asked %v", got)
	}

	// The build the step kept beside the executable, and a half-made copy, go with it.
	for _, name := range []string{updatePreviousName, updatePreviousName + ".new"} {
		if err := os.WriteFile(filepath.Join(f.installDir, name), []byte("an older build"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	machine.calls = nil
	if err := RemoveUpdateHelper(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(definition); !os.IsNotExist(err) {
		t.Errorf("the definition is still there: %v", err)
	}
	if _, err := os.Lstat(f.paths.StepDir); !os.IsNotExist(err) {
		t.Errorf("the step's directory is still there: %v", err)
	}
	if names := f.beside(); len(names) != 0 {
		t.Errorf("what the step left beside the executable stays: %v", names)
	}
	// The executable is the one thing that stays.
	if _, err := os.Stat(f.exe); err != nil {
		t.Errorf("the executable went with the step: %v", err)
	}
}
