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
// tests keeps the agent's service in files; here launchctl is a fake over those files
// that answers as launchd does, and the step reaches the service only as it does on a
// Mac: it reads `launchctl print`, boots the job out and bootstraps it again. What the
// shared reconciler decides is tested once, with the machine itself; these tests show
// that what the macOS host says to it, and what it says back to launchd, lets it decide
// the same way: a good build commits, a build that can't start is taken back as launchd
// shows it (a job that stays loaded with its runs counting up), a build that never
// checks in is taken back at the deadline, and the step's own definition is loaded and
// unloaded with its files.
//
// What the model of launchd keeps from the real one:
//
//   - A job that has KeepAlive and whose process ends or is killed stays loaded: `print`
//     says "spawn scheduled" or "not running", counts a run each time launchd starts it
//     again, no sooner than its ThrottleInterval after the process ended (10 s in the
//     agent's definition), and shows the last exit code. launchd never forgets such a
//     job by itself.
//   - launchctl bootout returns when launchd has begun to remove the job. The process is
//     gone, but print lists the job as running for a while longer, and only then says
//     "Could not find service" (exit 113). While the label is being removed, a bootstrap
//     of it is refused (status 5, "Input/output error") or accepted and dropped with the
//     job, as the test configures.
//   - A bootstrap of a label launchd already has is refused with status 5.

// machineThrottle is the agent's ThrottleInterval, the least time launchd lets pass
// between the end of the job's process and its next start.
const machineThrottle = 10 * time.Second

const (
	machineAgentTarget = "system/io.vectory.agent"
	machineStepTarget  = "system/io.vectory.update"
)

// agentNotLoaded is what print says of the agent's label when launchd has no such job,
// as it does on a Mac: exit 113, and a first line that says the request was bad.
var agentNotLoaded = launchctlResult{status: 113, stderr: "Bad request.\nCould not find service \"io.vectory.agent\" in domain for system\n"}

// launchdListing is what `launchctl print` shows of the agent's job: its state, the process
// it has (none when pid is 0), the count of its runs, and how its process last ended ("" for
// a job that never exited, which launchd prints as "(never exited)").
type launchdListing struct {
	state    string
	pid      int
	runs     int
	lastExit string
}

// launchdOverMachine is launchctl over the fixture's simulated service.
type launchdOverMachine struct {
	f     *stepFixture
	calls []string

	// loaded says launchd knows the agent's job: it was loaded when the agent was
	// installed. removing is how many more prints list a job that has been booted out
	// (its process is gone); departed is what they list.
	loaded   bool
	removing int
	departed launchdListing

	// stepLoaded says launchd knows the step's own job, io.vectory.update, which setup loads
	// and which launchd starts at load and then every 30 seconds; stepRuns counts its runs.
	stepLoaded bool
	stepRuns   int

	// What a test sets.
	//
	// removalPrints is how many prints still list the job after a bootout of it
	// returned. refuseUntil makes launchd refuse every bootstrap before that time, as it
	// does while it tears a job down. acceptWhileRemoving makes a bootstrap of a label
	// that is being removed answer 0 and be dropped with the job, where it is refused
	// otherwise. dropAccepted drops that many bootstraps that were accepted, whatever
	// the state of the label: launchd answers 0, and doesn't have the job afterwards.
	// lingerChecks is how many looks for the process of a job that was booted out still
	// find it there (lingerPID is that process, and lingering how many looks are left).
	removalPrints       int
	refuseUntil         time.Time
	acceptWhileRemoving bool
	dropAccepted        int
	lingerChecks        int
	lingerPID           int
	lingering           int
}

func (m *launchdOverMachine) refused() launchctlResult {
	return launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n"}
}

func (m *launchdOverMachine) run(ctx context.Context, args ...string) launchctlResult {
	m.calls = append(m.calls, strings.Join(args, " "))
	switch args[0] {
	case "print":
		switch args[1] {
		case machineAgentTarget:
			return m.print(ctx)
		case machineStepTarget:
			return m.printStep()
		}
		return notLoaded
	case "bootout":
		switch args[1] {
		case machineAgentTarget:
			return m.bootout(ctx)
		case machineStepTarget:
			return m.bootoutStep()
		}
	case "bootstrap":
		switch {
		case strings.HasSuffix(args[len(args)-1], "io.vectory.agent.plist"):
			return m.bootstrap(ctx)
		case strings.HasSuffix(args[len(args)-1], "io.vectory.update.plist"):
			return m.bootstrapStep()
		}
	case "kickstart":
		if args[len(args)-1] == machineAgentTarget {
			return m.kickstart(ctx)
		}
	}
	return launchctlResult{}
}

// listing is what launchd prints for the job as the machine's process is now: the
// machine plays the process on to the present, and launchd's rules decide what is shown.
func (m *launchdOverMachine) listing(ctx context.Context) launchdListing {
	state, _ := m.f.host.ServiceState(ctx)
	s := m.f.host.loadService()
	switch s.Behavior {
	case "crash", "exit", "fail":
		// A build that ends at once leaves the job loaded: launchd starts it again each
		// time its throttle has run out, and the run count goes up by one.
		exit := map[string]string{"crash": "2", "exit": "0", "fail": "78"}[s.Behavior]
		elapsed := m.f.clock.Now().Sub(time.Unix(0, s.Started))
		return launchdListing{state: "spawn scheduled", runs: 1 + int(elapsed/machineThrottle), lastExit: exit}
	}
	if state.State == "active" {
		running := launchdListing{state: "running", pid: state.PID, runs: state.Restarts + 1}
		if running.runs > 1 {
			// A job launchd has started again has exited before, and says how.
			running.lastExit = "1"
		}
		return running
	}
	return launchdListing{state: "spawn scheduled", runs: state.Restarts + 1, lastExit: "1"}
}

// launchdPrintText is `launchctl print system/io.vectory.agent` for a job, in the words launchd
// uses: the text a Mac printed for the agent's job, started at load and never exited
// (testdata/update/launchctl-print-running.txt), with what depends on the job filled in. A job
// with a process that is running has an active count of 1; a job that never exited says so, and
// any other says the code; launchd gave "speculative" as the reason it started a job that was
// loaded and has never exited; the pid is printed only while the job has a process.
func launchdPrintText(l launchdListing) launchctlResult {
	var b strings.Builder
	active := 0
	if l.state == "running" && l.pid > 0 {
		active = 1
	}
	fmt.Fprintf(&b, "system/io.vectory.agent = {\n\tactive count = %d\n", active)
	b.WriteString("\tpath = /Library/LaunchDaemons/io.vectory.agent.plist\n\ttype = LaunchDaemon\n")
	fmt.Fprintf(&b, "\tstate = %s\n\n", l.state)
	b.WriteString("\tprogram = /usr/local/bin/vectory\n\targuments = {\n\t\t/usr/local/bin/vectory\n\t\trun\n\t\t--state-dir\n\t\t/Library/Application Support/Vectory/agent\n\t}\n\n")
	b.WriteString("\tstdout path = /dev/null\n\tstderr path = /dev/null\n")
	b.WriteString("\tdefault environment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t}\n\n")
	b.WriteString("\tenvironment = {\n\t\tXPC_SERVICE_NAME => io.vectory.agent\n\t}\n\n")
	b.WriteString("\tdomain = system\n\tusername = _vectory\n\n")
	b.WriteString("\tumask = 77\n\tminimum runtime = 10\n\texit timeout = 330\n")
	fmt.Fprintf(&b, "\truns = %d\n", l.runs)
	if l.pid > 0 {
		fmt.Fprintf(&b, "\tpid = %d\n", l.pid)
	}
	if l.runs == 1 && l.lastExit == "" {
		b.WriteString("\timmediate reason = speculative\n")
	}
	b.WriteString("\tforks = 2\n\texecs = 1\n\tinitialized = 1\n\ttrampolined = 1\n\tstarted suspended = 0\n\tproxy started suspended = 0\n")
	if l.lastExit == "" {
		b.WriteString("\tlast exit code = (never exited)\n")
	} else {
		fmt.Fprintf(&b, "\tlast exit code = %s\n", l.lastExit)
	}
	b.WriteString("\n" + launchdJobTail + "\tproperties = keepalive | runatload | inferred program | system service | tle system\n}\n")
	return launchctlResult{stdout: b.String()}
}

// launchdJobTail is the lines launchd prints for every job after the ones that say what it did:
// how it was spawned, its jetsam limits and the block of probabilistic guard malloc settings,
// which has lines of its own that look like the job's.
const launchdJobTail = "\tspawn type = daemon (3)\n\tjetsam priority = 40\n\tjetsam memory limit (active) = (unlimited)\n\tjetsam memory limit (inactive) = (unlimited)\n\tjetsamproperties category = daemon\n\tjetsam thread limit = 32\n\tcpumon = default\n" +
	"\tprobabilistic guard malloc policy = {\n\t\tactivation rate = 1/1000\n\t\tsample rate = 1/0\n\t}\n\n"

// stepPrintText is `launchctl print system/io.vectory.update` for the step's own job as launchd
// printed it on a Mac (testdata/update/launchctl-print-not-running.txt): loaded, not running
// between two runs, started every 30 seconds, with the count of its runs and the code its last
// run ended with filled in.
func stepPrintText(runs int) launchctlResult {
	var b strings.Builder
	b.WriteString("system/io.vectory.update = {\n\tactive count = 0\n\tpath = /Library/LaunchDaemons/io.vectory.update.plist\n\ttype = LaunchDaemon\n\tstate = not running\n\n")
	b.WriteString("\tprogram = /Library/Application Support/Vectory/update-state/private/helper/vectory\n\targuments = {\n\t\t/Library/Application Support/Vectory/update-state/private/helper/vectory\n\t\tupdate-helper\n\t\t--state-dir\n\t\t/Library/Application Support/Vectory/agent\n\t}\n\n")
	b.WriteString("\tstdout path = /dev/null\n\tstderr path = /Library/Application Support/Vectory/update-state/private/step.log\n")
	b.WriteString("\tdefault environment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t}\n\n")
	b.WriteString("\tenvironment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t\tXPC_SERVICE_NAME => io.vectory.update\n\t}\n\n")
	b.WriteString("\tdomain = system\n\tminimum runtime = 10\n\texit timeout = 5\n")
	fmt.Fprintf(&b, "\truns = %d\n", runs)
	if runs > 0 {
		b.WriteString("\tlast exit code = 0\n")
	} else {
		b.WriteString("\tlast exit code = (never exited)\n")
	}
	b.WriteString("\n\tspawn type = daemon (3)\n\tjetsam priority = 40\n\tjetsam memory limit (active) = (unlimited)\n\tjetsam memory limit (inactive) = (unlimited)\n\tjetsamproperties category = daemon\n\tjetsam thread limit = 32\n\tcpumon = default\n")
	b.WriteString("\trun interval = 30 seconds\n\tprobabilistic guard malloc policy = {\n\t\tactivation rate = 1/1000\n\t\tsample rate = 1/0\n\t}\n\n")
	b.WriteString("\tproperties = runatload | inferred program | system service | tle system\n}\n")
	return launchctlResult{stdout: b.String()}
}

// printStep is print of the step's job: launchd knows it from the time setup loads it.
func (m *launchdOverMachine) printStep() launchctlResult {
	if !m.stepLoaded {
		return notLoaded
	}
	return stepPrintText(m.stepRuns)
}

// bootstrapStep loads the step's job, which launchd starts at once (RunAtLoad); a job it
// already has is refused, as the agent's is.
func (m *launchdOverMachine) bootstrapStep() launchctlResult {
	if m.stepLoaded {
		return m.refused()
	}
	m.stepLoaded, m.stepRuns = true, 1
	return launchctlResult{}
}

// bootoutStep unloads the step's job: it has no Vector to drain and no process the tests need,
// so launchd is done at once.
func (m *launchdOverMachine) bootoutStep() launchctlResult {
	if !m.stepLoaded {
		return launchctlResult{status: 3, stderr: "Boot-out failed: 3: No such process"}
	}
	m.stepLoaded = false
	return launchctlResult{}
}

func (m *launchdOverMachine) print(ctx context.Context) launchctlResult {
	if m.removing > 0 {
		m.removing--
		listed := m.departed
		if m.removing == 0 {
			m.loaded = false
		}
		return launchdPrintText(listed)
	}
	if !m.loaded {
		return agentNotLoaded
	}
	return launchdPrintText(m.listing(ctx))
}

func (m *launchdOverMachine) bootout(ctx context.Context) launchctlResult {
	if m.removing > 0 {
		return launchctlResult{}
	}
	if !m.loaded {
		return launchctlResult{status: 3, stderr: "Boot-out failed: 3: No such process"}
	}
	listed := m.listing(ctx)
	if err := m.f.host.StopService(ctx); err != nil {
		return launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"}
	}
	m.lingerPID, m.lingering = listed.pid, m.lingerChecks
	if m.removalPrints == 0 {
		m.loaded = false
		return launchctlResult{}
	}
	// launchd lists the job as it was, running, while it removes it.
	listed.state = "running"
	m.removing, m.departed = m.removalPrints, listed
	return launchctlResult{}
}

func (m *launchdOverMachine) bootstrap(ctx context.Context) launchctlResult {
	switch {
	case m.f.clock.Now().Before(m.refuseUntil):
		return m.refused()
	case m.removing > 0:
		if m.acceptWhileRemoving {
			return launchctlResult{}
		}
		return m.refused()
	case m.loaded:
		return m.refused()
	case m.dropAccepted > 0:
		m.dropAccepted--
		return launchctlResult{}
	}
	if err := m.f.host.StartService(ctx); err != nil {
		return m.refused()
	}
	m.loaded = true
	return launchctlResult{}
}

func (m *launchdOverMachine) kickstart(ctx context.Context) launchctlResult {
	switch {
	case m.removing > 0:
		return launchctlResult{}
	case !m.loaded:
		return agentNotLoaded
	}
	if err := m.f.host.StartService(ctx); err != nil {
		return launchctlResult{status: 5, stderr: err.Error()}
	}
	return launchctlResult{}
}

// processIsThere is the check for the process a job had, after the job was booted out:
// gone at once, unless the test makes it linger for some looks.
func (m *launchdOverMachine) processIsThere(pid int) bool {
	if pid == m.lingerPID && m.lingering > 0 {
		m.lingering--
		return true
	}
	return false
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
func (h *launchdHost) ReloadService(ctx context.Context) (bool, error) {
	return h.mac.ReloadService(ctx)
}
func (h *launchdHost) InstallUnits(spec updateUnitSpec) error { return h.mac.InstallUnits(spec) }
func (h *launchdHost) RemoveUnits() (string, bool, error)     { return h.mac.RemoveUnits() }

// macOSHostOver is the macOS host as one process of the step has it, over a machine's
// launchctl: with nothing in its memory, a pause between two tries of a bootstrap being time
// that passes on the machine's clock.
func (f *stepFixture) macOSHostOver(machine *launchdOverMachine) *macosUpdateHost {
	f.t.Helper()
	root := filepath.Dir(filepath.Dir(filepath.Dir(f.paths.PolicyDir)))
	mac := newMacOSUpdateHost(machine.run)
	mac.daemonDir = filepath.Join(root, "Library", "LaunchDaemons")
	mac.receipt = filepath.Join(root, "receipts", "com.vectory.agent.bom")
	mac.agent = mac.job("", machine.run)
	mac.step = mac.job(updateLaunchdLabel, machine.run)
	mac.alive = machine.processIsThere
	for _, job := range []*launchdJob{&mac.agent, &mac.step} {
		job.sleep = func(d time.Duration) { f.clock.advance(d) }
		job.now = f.clock.Now
	}
	return mac
}

// useLaunchd makes the fixture's step reach its service through launchd.
func (f *stepFixture) useLaunchd() (*launchdOverMachine, *macosUpdateHost) {
	f.t.Helper()
	root := filepath.Dir(filepath.Dir(filepath.Dir(f.paths.PolicyDir)))
	mkdirMode(f.t, filepath.Join(root, "Library", "LaunchDaemons"), 0o755)
	machine := &launchdOverMachine{f: f, loaded: true}
	mac := f.macOSHostOver(machine)
	// The agent's definition is there, as setup left it.
	definition, err := launchdPlist(f.exe, f.stateDir, "_vectory")
	if err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(mac.agent.definition, []byte(definition), 0o644); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chmod(mac.agent.definition, 0o644); err != nil {
		f.t.Fatal(err)
	}
	updateHostOverride = &launchdHost{fakeHost: f.host, mac: mac}
	return machine, mac
}

// anotherStepProcess is the next run of the step: the update step is a new process every
// 30 seconds and at boot, and what the previous one held in memory is gone. The machine, its
// files and launchd are the same.
func (f *stepFixture) anotherStepProcess(machine *launchdOverMachine) *macosUpdateHost {
	f.t.Helper()
	mac := f.macOSHostOver(machine)
	updateHostOverride = &launchdHost{fakeHost: f.host, mac: mac}
	return mac
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

// bootoutByAPerson is what `sudo launchctl bootout system/io.vectory.agent` does.
func (m *launchdOverMachine) bootoutByAPerson(t *testing.T) {
	t.Helper()
	if result := m.run(context.Background(), "bootout", machineAgentTarget); result.status != 0 {
		t.Fatalf("bootout: %+v", result)
	}
}

// ---------------------------------------------------------------- the simulated print

// What the step and the tests read of `launchctl print` is the text launchd printed on a Mac.
// The simulation renders it for the same job and the same state as the text the Mac printed,
// to the byte, and the other states are that text with the lines that depend on the state.
func TestTheSimulatedPrintIsWhatLaunchdPrintedForTheSameJobInTheSameState(t *testing.T) {
	for name, c := range map[string]struct {
		got  string
		file string
	}{
		"the agent's job, started at load":       {launchdPrintText(launchdListing{state: "running", pid: realAgentPID, runs: 1}).stdout, "launchctl-print-running.txt"},
		"the agent's job, started again":         {launchdPrintText(launchdListing{state: "running", pid: 34455, runs: 3, lastExit: "1"}).stdout, "launchctl-print-restarted.txt"},
		"the agent's job, waiting for a restart": {launchdPrintText(launchdListing{state: "spawn scheduled", runs: 2, lastExit: "2"}).stdout, "launchctl-print-waiting.txt"},
		"the step's job, between two runs":       {stepPrintText(13).stdout, "launchctl-print-not-running.txt"},
	} {
		if want := readTestdata(t, c.file); c.got != want {
			t.Errorf("%s: the simulated print differs from %s:\n%s\nwant:\n%s", name, c.file, c.got, want)
		}
	}
	// The lines the step depends on come out as the step reads them, whatever else is printed.
	printed, err := parseLaunchdPrint(launchdPrintText(launchdListing{state: "running", pid: 77, runs: 4, lastExit: "78"}).stdout)
	if err != nil || printed != (launchdPrinted{State: "running", PID: 77, Runs: 4, LastExit: "78"}) {
		t.Errorf("%+v, %v", printed, err)
	}
	// A job that never exited says so, and one that was never started has no process line.
	never := launchdPrintText(launchdListing{state: "spawn scheduled", runs: 0}).stdout
	if !strings.Contains(never, "\tlast exit code = (never exited)\n") || strings.Contains(never, "\tpid = ") || !strings.Contains(never, "\tactive count = 0\n") {
		t.Errorf("a job that never ran:\n%s", never)
	}
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

// A build that can't start doesn't make launchd forget its job: the job stays loaded,
// its process ends at once and launchd starts it again each time the throttle has run
// out, so the runs count up. Three restarts end the trial, thirty seconds after it began
// with a throttle of ten, however the process ended, and the loaded job is booted out
// before the previous build is put back.
func TestABuildThatCannotStartIsTakenBackAsLaunchdShowsItAndNotAtTheDeadline(t *testing.T) {
	for _, behavior := range []string{"crash", "exit"} {
		t.Run(behavior, func(t *testing.T) {
			f := newStepFixture(t)
			f.useLaunchd()
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", behavior, releaseOptions{})
			f.stage(release)
			started := f.clock.Now()
			f.mustRun()
			f.requireTakenBack(oldDigest, release, "START_FAILED")
			elapsed := f.clock.Now().Sub(started)
			if elapsed < 3*machineThrottle {
				t.Errorf("the trial ended after %s, before launchd had started the job three more times", elapsed)
			}
			if elapsed > 45*time.Second {
				t.Errorf("the rollback took %s of the five minutes", elapsed)
			}
			if got, want := strings.Join(f.service().History, ","), "start 0.1.0,stop,start 0.1.2,stop,start 0.1.0"; got != want {
				t.Errorf("the service's history: %s, want %s", got, want)
			}
		})
	}
}

// What the step writes to its log says what launchd showed when it ended the trial of a
// build that couldn't start: a job that keeps being started and ending. The agent's own
// standard error goes nowhere, so this is what a person reading the step's log has.
func TestTheStepsLogSaysWhatLaunchdShowedWhenABuildCouldNotStart(t *testing.T) {
	for behavior, lastExit := range map[string]string{"crash": "2", "exit": "0"} {
		t.Run(behavior, func(t *testing.T) {
			f := newStepFixture(t)
			f.useLaunchd()
			oldDigest := f.executableDigest()
			release := f.newRelease("0.1.2", behavior, releaseOptions{})
			f.stage(release)
			log := captureStepLog(t, f.mustRun)
			f.requireTakenBack(oldDigest, release, "START_FAILED")
			want := `the service manager shows the agent's service activating after 3 restart(s) since the watch began: launchd says the job is "spawn scheduled" with pid 0, 4 run(s), last exit code ` + lastExit
			if !strings.Contains(log, want) {
				t.Errorf("the step's log:\n%s\nwant it to say %q", log, want)
			}
			if strings.Contains(log, "doesn't know the job") {
				t.Errorf("the log says launchd doesn't know a job that stayed loaded:\n%s", log)
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

// ---------------------------------------------------------------- the removal of a job

// launchctl bootout returns before launchd has removed the job, which print keeps listing
// as running for a moment. The step's stop waits until launchd no longer lists it, so the
// start of the new build meets no departing job: it bootstraps, launchd keeps the job, and
// the build commits. Without the wait, the start finds the old job listed as running,
// takes it for the agent and starts nothing, and the trial ends when launchd drops the
// job a moment later, as the build having failed to start.
func TestAGoodBuildStartedRightAfterABootoutThatLaunchdHasNotFinishedIsCommitted(t *testing.T) {
	for _, prints := range []int{1, 2, 5, 9} {
		t.Run(fmt.Sprintf("the job is listed for %d more prints", prints), func(t *testing.T) {
			f := newStepFixture(t)
			machine, mac := f.useLaunchd()
			machine.removalPrints = prints
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)

			log := captureStepLog(t, f.mustRun)

			f.requireAnswered(release, UpdateOutcomeCommitted, "")
			if got := f.executableDigest(); got != release.buildSHA() {
				t.Fatalf("the executable is %s, want the new build %s", got, release.buildSHA())
			}
			want := []string{"bootout " + machineAgentTarget, "bootstrap system " + mac.agent.definition}
			if got := machine.changes(); strings.Join(got, "|") != strings.Join(want, "|") {
				t.Errorf("launchd was asked %v, want %v", got, want)
			}
			if got := strings.Join(f.service().History, ","); got != "start 0.1.0,stop,start 0.1.1" {
				t.Errorf("the service's history: %s", got)
			}
			// The start met no departing job: the trial wasn't saved by loading the job
			// again after launchd dropped it.
			if strings.Contains(log, "loaded it again") || strings.Contains(log, "doesn't know the job") {
				t.Errorf("the start was answered by the job that was leaving, and the trial needed the job loaded again:\n%s", log)
			}
		})
	}
}

// The process of the job that was booted out may outlast launchd's listing of it, and
// the stop waits for it too.
func TestTheStopOfTheAgentWaitsForTheProcessOfTheJobToBeGone(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	machine.removalPrints, machine.lingerChecks = 2, 7
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	var stoppedAfter time.Duration
	began := f.clock.Now()
	updateFault = func(point string) {
		if point == "stopped" {
			stoppedAfter = f.clock.Now().Sub(began)
		}
	}

	f.mustRun()

	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	// Two looks at the listing, and seven at the process, each a quarter of a second
	// after the one before.
	if want := 2*launchdUnloadPoll + 7*launchdUnloadPoll; stoppedAfter < want {
		t.Errorf("the stop returned after %s, before the process was gone (%s)", stoppedAfter, want)
	}
	if machine.lingering != 0 {
		t.Errorf("%d looks for the process were left unused: the stop ended while it was still there", machine.lingering)
	}
}

// launchd needs a while before it takes a label again, and refuses the bootstrap until
// then, though print says it doesn't know the job. Seven seconds is more than the four
// tries two seconds apart that the step once made, and a start retries for a minute.
func TestAGoodBuildIsCommittedWhenLaunchdRefusesTheBootstrapForSevenSeconds(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point == "stopped" {
			machine.refuseUntil = f.clock.Now().Add(7 * time.Second)
		}
	}

	f.mustRun()

	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	if got := f.executableDigest(); got != release.buildSHA() {
		t.Fatalf("the executable is %s, want the new build %s", got, release.buildSHA())
	}
	refusals := 0
	for _, call := range machine.calls {
		if strings.HasPrefix(call, "bootstrap ") {
			refusals++
		}
	}
	if refusals < 4 {
		t.Errorf("launchd was asked to bootstrap %d times; it refused for seven seconds, two apart", refusals)
	}
	if got := strings.Join(f.service().History, ","); got != "start 0.1.0,stop,start 0.1.1" {
		t.Errorf("the service's history: %s", got)
	}
}

// A bootstrap that launchd accepts and then drops (it answered 0, and print says there is
// no such job) is a start that didn't happen: the step looks, finds the job isn't shown,
// and bootstraps again.
func TestABootstrapLaunchdAcceptsAndThenDropsIsBootstrappedAgain(t *testing.T) {
	f := newStepFixture(t)
	machine, mac := f.useLaunchd()
	machine.dropAccepted = 2
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)

	f.mustRun()

	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	want := []string{"bootout " + machineAgentTarget}
	for i := 0; i < 3; i++ {
		want = append(want, "bootstrap system "+mac.agent.definition)
	}
	if got := machine.changes(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("launchd was asked %v, want %v", got, want)
	}
	if got := strings.Join(f.service().History, ","); got != "start 0.1.0,stop,start 0.1.1" {
		t.Errorf("the service's history: %s", got)
	}
}

// A bootstrap accepted while launchd removes the label goes with the job. Started right
// after the stop, the step would take it for a start; it waits for the removal first, so
// the bootstrap it makes is the one that is kept.
func TestABootstrapOfALabelBeingRemovedIsNeverMadeBecauseTheStopWaitsForTheRemoval(t *testing.T) {
	for _, accept := range []bool{false, true} {
		t.Run(fmt.Sprintf("a bootstrap during the removal is accepted: %v", accept), func(t *testing.T) {
			f := newStepFixture(t)
			machine, _ := f.useLaunchd()
			machine.removalPrints, machine.acceptWhileRemoving = 4, accept
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)

			f.mustRun()

			f.requireAnswered(release, UpdateOutcomeCommitted, "")
			bootstraps := 0
			for _, call := range machine.calls {
				if strings.HasPrefix(call, "bootstrap ") {
					bootstraps++
				}
			}
			if bootstraps != 1 {
				t.Errorf("the step made %d bootstraps; it should make one, after launchd had removed the job", bootstraps)
			}
		})
	}
}

// A swap the file system refuses leaves the old build to be started again right after the
// bootout. The stop waited until launchd had removed the job, so the start is a bootstrap
// that launchd keeps: the request ends, and the agent is still there when later runs have
// gone by. Started while the departing job was still listed, the start would have found
// that job, taken it for the agent and started nothing, and nobody would have watched.
func TestAStartAfterARefusedSwapMeetsNoDepartingJobAndLeavesTheAgentRunning(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	machine.removalPrints = 6
	f.host.cfg.SwapFails = "rename: input/output error"
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)

	f.mustRun()

	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	for i := 0; i < 4; i++ {
		f.clock.advance(30 * time.Second)
		f.mustRun()
	}
	if service := f.service(); service.State != "active" || service.Version != "0.1.0" {
		t.Errorf("the agent's service two minutes after the request ended: %+v", service)
	}
	if !machine.loaded {
		t.Error("launchd has no job for the agent")
	}
	bootstraps := 0
	for _, call := range machine.calls {
		if strings.HasPrefix(call, "bootstrap ") {
			bootstraps++
		}
	}
	if bootstraps != 1 {
		t.Errorf("the step made %d bootstraps, want the one that launchd kept", bootstraps)
	}
}

// ---------------------------------------------------------------- the rollback's start

// The rollback's own start can be refused too, and a start launchd doesn't take is not an
// answer about the build: the step leaves the journal saying rolling_back and ends the
// run with an error, the host has no agent until a start works, and the next run, 30
// seconds later, starts the previous build and ends the request. Ending it at the first
// refusal would leave the device dark: later runs find the journal idle and start nothing.
func TestARollbackWhoseStartLaunchdRefusesLeavesTheJournalRollingBackAndTheNextRunStartsThePreviousBuild(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	refusedUntil := time.Time{}
	updateFault = func(point string) {
		if point == "rollback:restored" && refusedUntil.IsZero() {
			// launchd refuses for 200 seconds, longer than two starts try for.
			refusedUntil = f.clock.Now().Add(200 * time.Second)
			machine.refuseUntil = refusedUntil
		}
	}

	err := f.run()
	if err == nil || !strings.Contains(err.Error(), "couldn't start the previous build") || !strings.Contains(err.Error(), "launchd doesn't show the agent's job after 60 s") {
		t.Errorf("the run that couldn't start the previous build: %v", err)
	}

	// Nothing ended: the journal says rolling_back, the status says so with the step's
	// own clock, no result was recorded, and the agent isn't running.
	journal, found := f.journal()
	if !found || journal.Stage != UpdateStageRollingBack || journal.Code != "START_FAILED" {
		t.Fatalf("the journal after a rollback that couldn't start the previous build: %+v (found %v)", journal, found)
	}
	if status := f.status(); status.Stage != UpdateStageRollingBack || status.Last != nil && status.Last.Release == release.manifestSHA() {
		t.Errorf("the status after it: stage %s, last %+v", status.Stage, status.Last)
	}
	if got := f.executableDigest(); got != oldDigest {
		t.Errorf("the executable is %s, the rollback had put the previous build %s back", got, oldDigest)
	}
	if machine.loaded {
		t.Error("launchd has a job although it refused every bootstrap")
	}

	// A run while launchd still refuses fails the same way and changes nothing else.
	f.clock.advance(10 * time.Second)
	if err := f.run(); err == nil || !strings.Contains(err.Error(), "couldn't start the previous build") {
		t.Fatalf("a run while launchd still refuses: %v", err)
	}
	if journal, _ := f.journal(); journal.Stage != UpdateStageRollingBack {
		t.Errorf("the journal after the second run: %+v", journal)
	}

	// launchd takes the label again, and the next run starts the previous build and ends
	// the request as the rollback it is.
	f.clock.set(refusedUntil.Add(30 * time.Second))
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if service := f.service(); service.Version != "0.1.0" || service.State != "active" {
		t.Errorf("the host after the rollback: %+v", service)
	}
	if !machine.loaded {
		t.Error("launchd has no job after the rollback ended")
	}
}

// A previous build that was started and is loaded, and doesn't check in healthy within its
// five minutes, is the one case ROLLBACK_UNHEALTHY says, and it says it after the five
// minutes and not before.
func TestAPreviousBuildThatIsStartedAndNeverChecksInEndsAsUnhealthyAfterItsFiveMinutesAndNotBefore(t *testing.T) {
	f := newStepFixture(t)
	f.useLaunchd()
	f.useSilentPreviousBuild()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	var startedPrevious time.Time
	updateFault = func(point string) {
		if point == "rollback:started" {
			startedPrevious = f.clock.Now()
		}
	}

	f.mustRun()

	if got := f.executableDigest(); got != oldDigest {
		t.Fatalf("the executable is %s, want the previous build", got)
	}
	f.requireAnswered(release, UpdateOutcomeRolledBack, "ROLLBACK_UNHEALTHY")
	if startedPrevious.IsZero() {
		t.Fatal("the previous build was never started")
	}
	watched := f.status().Last.At.Sub(startedPrevious)
	if watched < updateTrialDuration-time.Second || watched > updateTrialDuration+10*time.Second {
		t.Errorf("the previous build was watched for %s, and it gets %s", watched, updateTrialDuration)
	}
	if service := f.service(); service.State != "active" || service.Version != "0.1.0" {
		t.Errorf("the previous build is left running: %+v", service)
	}
}

// ---------------------------------------------------------------- a job that launchd loses during a trial

// An administrator who boots the agent's job out while a build is tried took away the job,
// and said nothing about the build. launchd says "no such job", the step asks it to load
// the job again, and the trial goes on with the build that is now running: it commits.
func TestAnAdministratorsBootoutDuringATrialIsLoadedAgainAndTheTrialGoesOn(t *testing.T) {
	f := newStepFixture(t)
	machine, mac := f.useLaunchd()
	machine.removalPrints = 2
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	once := false
	updateFault = func(point string) {
		if point == "started" && !once {
			once = true
			machine.bootoutByAPerson(t)
		}
	}

	log := captureStepLog(t, f.mustRun)

	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	if got := f.executableDigest(); got != release.buildSHA() {
		t.Fatalf("the executable is %s, want the new build", got)
	}
	want := []string{"bootout " + machineAgentTarget, "bootstrap system " + mac.agent.definition, "bootout " + machineAgentTarget, "bootstrap system " + mac.agent.definition}
	if got := machine.changes(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("launchd was asked %v, want %v", got, want)
	}
	if got := strings.Join(f.service().History, ","); got != "start 0.1.0,stop,start 0.1.1,stop,start 0.1.1" {
		t.Errorf("the service's history: %s", got)
	}
	if !strings.Contains(log, "the step loaded it again (1 of 2)") {
		t.Errorf("the step's log doesn't say it loaded the job again:\n%s", log)
	}
}

// A job that launchd keeps refusing to load again after two tries ends the trial as the
// build not starting, the rollback's own start meets the same refusal, and the request
// goes on only when launchd takes the label: the journal stays rolling_back between.
func TestAJobThatLaunchdWontLoadAgainDuringATrialEndsItAndTheRollbackWaitsForLaunchd(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	var until time.Time
	once := false
	updateFault = func(point string) {
		if point == "started" && !once {
			once = true
			until = f.clock.Now().Add(15 * time.Minute)
			machine.refuseUntil = until
			machine.bootoutByAPerson(t)
		}
	}

	log := captureStepLog(t, func() {
		if err := f.run(); err == nil || !strings.Contains(err.Error(), "couldn't start the previous build") {
			t.Errorf("the run: %v", err)
		}
	})

	for _, want := range []string{
		"loading it again failed (1 of 2)",
		"loading it again failed (2 of 2)",
		"the service manager shows the agent's service inactive after 0 restart(s) since the watch began: launchd doesn't know the job",
		"taking the new build back: START_FAILED",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("the step's log doesn't say %q:\n%s", want, log)
		}
	}
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageRollingBack || journal.Code != "START_FAILED" {
		t.Fatalf("the journal: %+v (found %v)", journal, found)
	}
	f.clock.set(until.Add(30 * time.Second))
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
}

// The previous build was started and launchd then loses its job and won't take it again:
// nothing shows that the previous build is unhealthy, only that it isn't running, so the
// rollback doesn't end as ROLLBACK_UNHEALTHY. It stays rolling_back for the next run.
func TestAPreviousBuildWhoseJobLaunchdLosesAndWontLoadAgainIsNotCalledUnhealthy(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	var until time.Time
	once := false
	updateFault = func(point string) {
		if point == "rollback:started" && !once {
			once = true
			until = f.clock.Now().Add(15 * time.Minute)
			machine.refuseUntil = until
			machine.bootoutByAPerson(t)
		}
	}

	err := f.run()
	if err == nil || !strings.Contains(err.Error(), "doesn't know the agent's service although the previous build was started") {
		t.Fatalf("the run: %v", err)
	}
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageRollingBack {
		t.Fatalf("the journal: %+v (found %v)", journal, found)
	}
	f.clock.set(until.Add(30 * time.Second))
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
}

// ---------------------------------------------------------------- the step's own job

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
	// launchd knows the step's job from then on, and prints that it runs it every 30 seconds.
	step := machine.run(context.Background(), "print", machineStepTarget)
	if step.status != 0 || !strings.Contains(step.stdout, "\trun interval = 30 seconds\n") || !strings.Contains(step.stdout, "\texit timeout = 5\n") || !strings.Contains(step.stdout, "\tstate = not running\n") {
		t.Errorf("launchd's print of the step's job: %+v", step)
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
	if got := machine.changes(); strings.Join(got, "|") != "bootout "+machineStepTarget || machine.stepLoaded {
		t.Errorf("launchd was asked %v, and it still lists the step's job: %v", got, machine.stepLoaded)
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
