//go:build !windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The record of the agent's job that the step is telling launchd to remove, through the whole step
// over the simulated launchctl, where every run is a new process and nothing survives in memory
// between runs. launchd goes on listing a job as running while it removes it, and nothing in the
// listing tells that job from one that was started: a run that takes the departing listing for a
// start ends the request on it, and when launchd finishes removing the job nothing loads the agent
// again until a reboot or a person does. What lets the next run tell is a record that is on disk
// before launchctl is asked, whatever becomes of the step while launchctl waits for the agent to
// drain, and whatever launchctl answers.

// holdsUntilLaunchdIsDone runs the step as each next timer run does, a new process thirty seconds
// after the one before, while launchd lists the agent's job that it was told to remove. It holds
// that no run ends the request while launchd does, and that the first run after launchd is done
// ends it with the old build running again: the job is loaded again, the executable is as it was,
// launchd was asked to boot the job out once and to bootstrap it once, and no record is left. It
// returns the run it ended in, counted from the first of them.
func (f *stepFixture) holdsUntilLaunchdIsDone(machine *launchdOverMachine, mac *macosUpdateHost, release *fakeRelease, oldDigest string) int {
	f.t.Helper()
	for run := 1; run <= 12; run++ {
		f.clock.advance(30 * time.Second)
		f.anotherStepProcess(machine)
		err := f.run()
		journal, found := f.journal()
		open := found && journal.active()
		switch {
		case machine.beingRemoved():
			if err == nil || !open || journal.Stage != UpdateStageSwapping {
				f.t.Fatalf("run %d after the stop: launchd is still removing the agent's job, and the run ended %v with the journal %+v (found %v)", run, err, journal, found)
			}
			if f.executableDigest() != oldDigest {
				f.t.Fatalf("run %d after the stop: the executable changed", run)
			}
			if last := f.status().Last; last != nil && last.Release == release.manifestSHA() {
				f.t.Fatalf("run %d after the stop: the request was answered with %+v", run, last)
			}
		case open:
			f.t.Fatalf("run %d after the stop: launchd is done with the job, and the request is still open after a run that ended %v", run, err)
		default:
			f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
			if service := f.service(); service.State != "active" || service.Version != "0.1.0" {
				f.t.Errorf("the agent's service when the request ended: %+v", service)
			}
			if !machine.loaded {
				f.t.Error("launchd has no job for the agent: nothing loaded it after it finished removing the old one")
			}
			if got := f.executableDigest(); got != oldDigest {
				f.t.Errorf("the executable is %s", got)
			}
			bootouts, bootstraps := 0, 0
			for _, change := range machine.changes() {
				switch {
				case strings.HasPrefix(change, "bootout "):
					bootouts++
				case strings.HasPrefix(change, "bootstrap "):
					bootstraps++
				}
			}
			if bootouts != 1 || bootstraps != 1 {
				f.t.Errorf("launchd was asked %v: one bootout, then one bootstrap once the job was gone", machine.changes())
			}
			if _, kept := recordNames(f.t, mac); kept {
				f.t.Errorf("the record of the job that was told to leave is still there after launchd was seen to be done: %q", leavingRecord(f.t, mac))
			}
			return run
		}
	}
	f.t.Fatal("the request never ended")
	return 0
}

// aMachineWhoseDrainTakesFiveMinutes is a Mac on which launchd goes on listing the agent's job for
// five minutes after it was told to remove it, as it does while the agent drains Vector.
func (f *stepFixture) aMachineWhoseDrainTakesFiveMinutes() (*launchdOverMachine, *macosUpdateHost, *fakeRelease, string) {
	f.t.Helper()
	machine, mac := f.useLaunchd()
	machine.removalLasts = 5 * time.Minute
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	return machine, mac, release, f.executableDigest()
}

// A person presses Ctrl-C on `sudo vectory update apply` while it waits for "Stopping the agent
// service", or the SSH session drops, or the step is killed: launchctl is killed with the run's
// context, and launchd goes on removing the job. The timer's next run finds the journal saying
// swapping and the old build in place, and must not take the departing listing for a start.
func TestAStopCutShortInsideTheBootoutLeavesTheRequestOpenUntilLaunchdHasRemovedTheJob(t *testing.T) {
	f := newStepFixture(t)
	machine, mac, release, oldDigest := f.aMachineWhoseDrainTakesFiveMinutes()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inner := mac.agent.run
	mac.agent.run = func(c context.Context, args ...string) launchctlResult {
		if args[0] == "bootout" && args[1] == machineAgentTarget {
			// launchd takes the bootout in hand, and the person interrupts while launchctl waits
			// for the agent to drain.
			inner(c, args...)
			cancel()
			return launchctlResult{status: -1}
		}
		return inner(c, args...)
	}
	if err := RunUpdateHelper(ctx, f.stateDir); !errors.Is(err, context.Canceled) {
		t.Fatalf("the run that was interrupted: %v", err)
	}
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageSwapping {
		t.Fatalf("the journal after the interruption: %+v (found %v)", journal, found)
	}
	if !machine.beingRemoved() {
		t.Fatal("launchd isn't removing the job, so the test shows nothing")
	}

	f.holdsUntilLaunchdIsDone(machine, mac, release, oldDigest)
}

// KeepAlive can restart the agent after the step records the process launchd listed but
// before launchctl receives bootout. The process ID in the record is then older than the
// process ID launchd lists while removing the *same job*. A later step process must not
// treat that different ID as proof that someone has loaded a replacement job.
func TestAKeepAliveRestartBetweenRecordAndInterruptedBootoutDoesNotEndTheRequestOnTheDepartingJob(t *testing.T) {
	f := newStepFixture(t)
	machine, mac, release, oldDigest := f.aMachineWhoseDrainTakesFiveMinutes()
	before := 1000 + f.service().Starts

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inner := mac.agent.run
	mac.agent.run = func(c context.Context, args ...string) launchctlResult {
		if args[0] == "bootout" && args[1] == machineAgentTarget {
			if pid, kept := recordNames(t, mac); !kept || pid != before {
				t.Errorf("record before bootout: process %d, kept %v; want process %d", pid, kept, before)
			}
			// launchd's KeepAlive starts the same loaded job with a new process just before
			// it takes the bootout in hand. The launchctl caller is then interrupted.
			running := f.service()
			running.Starts++
			running.Restarts++
			running.Started = f.clock.Now().UnixNano()
			f.host.saveService(running)
			inner(c, args...)
			cancel()
			return launchctlResult{status: -1}
		}
		return inner(c, args...)
	}
	if err := RunUpdateHelper(ctx, f.stateDir); !errors.Is(err, context.Canceled) {
		t.Fatalf("the interrupted bootout: %v", err)
	}
	if !machine.beingRemoved() || machine.departed.pid == before {
		t.Fatalf("the test did not leave the restarted job being removed: %+v", machine.departed)
	}
	if pid, kept := recordNames(t, mac); !kept || pid != before {
		t.Fatalf("record after the interrupted bootout: process %d, kept %v", pid, kept)
	}

	f.holdsUntilLaunchdIsDone(machine, mac, release, oldDigest)
}

// The step's process dies while launchctl waits (it is killed, or it crashes): nothing after the
// bootout runs, so what is on disk is what it wrote before launchctl was asked.
func TestAStepThatDiesInsideTheBootoutHasWrittenItsRecordBeforeLaunchctlWasAskedAndTheNextRunHoldsTheRequest(t *testing.T) {
	f := newStepFixture(t)
	machine, mac, release, oldDigest := f.aMachineWhoseDrainTakesFiveMinutes()

	inner := mac.agent.run
	mac.agent.run = func(c context.Context, args ...string) launchctlResult {
		if args[0] == "bootout" && args[1] == machineAgentTarget {
			if pid, kept := recordNames(t, mac); !kept || pid == 0 {
				t.Errorf("when launchctl was asked to boot the job out, the record was: process %d, kept %v", pid, kept)
			}
			inner(c, args...)
			panic("the step's process dies here")
		}
		return inner(c, args...)
	}
	func() {
		defer func() { _ = recover() }()
		_ = f.run()
	}()
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageSwapping {
		t.Fatalf("the journal after the step died: %+v (found %v)", journal, found)
	}

	f.holdsUntilLaunchdIsDone(machine, mac, release, oldDigest)
}

// What launchctl answers to a bootout says nothing about whether launchd is removing the job: a
// refusal and a removal that is under way both leave it listed as it was. A bootout that launchd
// takes in hand and answers with any status at all, among them one the step has no name for
// (37, "Operation already in progress", is one that launchd may give for a job whose removal a
// person's bootout began a moment earlier), leaves the request open as one it answers 0 does.
func TestABootoutAnsweredWithAnyStatusForAJobLaunchdIsRemovingLeavesTheRequestOpenUntilLaunchdIsDone(t *testing.T) {
	for name, reply := range map[string]launchctlResult{
		"already in progress": {status: 37, stderr: "Boot-out failed: 37: Operation already in progress"},
		"input/output error":  {status: 5, stderr: "Boot-out failed: 5: Input/output error"},
		"no such process":     {status: 3, stderr: "Boot-out failed: 3: No such process"},
		"a status of no name": {status: 91, stderr: "Boot-out failed: 91: something launchd said"},
		"killed":              {status: -1},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			machine, mac, release, oldDigest := f.aMachineWhoseDrainTakesFiveMinutes()
			inner := mac.agent.run
			mac.agent.run = func(c context.Context, args ...string) launchctlResult {
				if args[0] == "bootout" && args[1] == machineAgentTarget {
					inner(c, args...) // launchd removes the job
					return reply
				}
				return inner(c, args...)
			}
			if err := f.run(); err == nil {
				t.Fatal("the run ended without an error while launchd lists the job it was told to remove")
			}
			if !machine.beingRemoved() {
				t.Fatal("launchd isn't removing the job, so the test shows nothing")
			}

			f.holdsUntilLaunchdIsDone(machine, mac, release, oldDigest)
		})
	}
}

// A job that `print` lists without a process before the bootout (a listing the step can't read
// a process from) is recorded as one that names none, and then any listing of the job, with a
// process or without, is the job that was told to leave until `print` says there is no such job:
// the process a departing job lists after the bootout is one the step never saw.
func TestAJobListedWithNoProcessBeforeTheBootoutIsRecordedAsUnknownSoAnyListingOfItIsTheJobLeaving(t *testing.T) {
	f := newStepFixture(t)
	machine, mac, release, oldDigest := f.aMachineWhoseDrainTakesFiveMinutes()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inner := mac.agent.run
	booted := false
	mac.agent.run = func(c context.Context, args ...string) launchctlResult {
		result := inner(c, args...)
		switch {
		case args[0] == "bootout" && args[1] == machineAgentTarget:
			booted = true
			cancel()
			return launchctlResult{status: -1}
		case args[0] == "print" && args[1] == machineAgentTarget && !booted:
			// While the step stops the agent, and before the bootout, `print` lists the job
			// without saying which process it has.
			if journal, found := f.journal(); found && journal.Stage == UpdateStageSwapping {
				var lines []string
				for _, line := range strings.Split(result.stdout, "\n") {
					if !strings.HasPrefix(line, "\tpid = ") {
						lines = append(lines, line)
					}
				}
				result.stdout = strings.Join(lines, "\n")
			}
		}
		return result
	}
	if err := RunUpdateHelper(ctx, f.stateDir); !errors.Is(err, context.Canceled) {
		t.Fatalf("the run that was interrupted: %v", err)
	}
	if pid, kept := recordNames(t, mac); !kept || pid != 0 {
		t.Fatalf("the record when `print` listed no process: process %d, kept %v", pid, kept)
	}
	// What launchd lists while it removes the job has the process the job had.
	if listing := machine.run(bg(), "print", machineAgentTarget); !strings.Contains(listing.stdout, "\tpid = ") {
		t.Fatalf("the departing job is listed without a process, so the test shows nothing:\n%s", listing.stdout)
	}

	f.holdsUntilLaunchdIsDone(machine, mac, release, oldDigest)
}

// The Mac restarts before launchd is done with the job, and at boot launchd loads the agent's job,
// which runs the old build with the process ID the departing job had before the restart. A record
// from before the restart (another boot session) names a process of another Mac, and the swap
// whose start is all that is left ends on the agent that runs.
func TestARecordFromBeforeARestartIsNoRecordAndTheSwapEndsOnTheAgentThatRunsAfterIt(t *testing.T) {
	for name, c := range map[string]struct {
		restart bool
		ends    bool
	}{
		"the Mac was restarted":     {true, true},
		"the Mac was not restarted": {false, false},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			machine, mac := f.useLaunchd()
			// The process can't be ended, so launchd lists the job for an hour: the stop gives up.
			machine.removalLasts = time.Hour
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			if err := f.run(); err == nil {
				t.Fatal("the run whose stop gave up ended without an error")
			}
			if pid, kept := recordNames(t, mac); !kept || pid != 1000+f.service().Starts {
				t.Fatalf("the record: process %d, kept %v", pid, kept)
			}

			// Less than a minute later (the record still holds by its age) launchd has the agent's
			// job running with that process ID again: after a restart, which loads it from its
			// definition, or because the removal ended and a person loaded it.
			f.clock.advance(45 * time.Second)
			if c.restart {
				machine.restart("uuid:boot-2")
			}
			machine.removeAt, machine.loaded = time.Time{}, true
			running := f.service()
			running.State, running.Started = "active", f.clock.Now().UnixNano()
			f.host.saveService(running)
			f.anotherStepProcess(machine)

			err := f.run()
			journal, found := f.journal()
			open := found && journal.active()
			if c.ends && (err != nil || open) {
				t.Fatalf("the run after the restart: %v, with the journal %+v (found %v)", err, journal, found)
			}
			if !c.ends && (err == nil || !open) {
				t.Fatalf("the run without a restart took a listing of the process the record names for a start: %v, with the journal %+v (found %v)", err, journal, found)
			}
			if c.ends {
				f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
				if service := f.service(); service.State != "active" || service.Version != "0.1.0" {
					t.Errorf("the agent's service: %+v", service)
				}
			}
		})
	}
}

// launchd's removal is over by the job's exit timeout, so a record older than the stop limit and
// a margin names a job that is gone, and a listing of a process with the ID it had is a process
// that took the number since. Until then the record holds, whoever has the number.
func TestAProcessIDAnotherProcessHasTakenSinceTheStopIsNotTheJobThatWasToldToLeaveOnceTheRecordIsOld(t *testing.T) {
	f := newStepFixture(t)
	machine, mac := f.useLaunchd()
	machine.removalLasts = time.Hour
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	if err := f.run(); err == nil {
		t.Fatal("the run whose stop gave up ended without an error")
	}
	pid, kept := recordNames(t, mac)
	if !kept || pid == 0 {
		t.Fatalf("the record: process %d, kept %v", pid, kept)
	}

	// The old process is gone and launchd has dropped the job. Another process now has the ID
	// the old one had: the agent's job, loaded again by a person.
	machine.removeAt, machine.loaded = time.Time{}, true
	running := f.service()
	running.State, running.Started = "active", f.clock.Now().UnixNano()
	f.host.saveService(running)

	// Half a minute after the stop gave up the record still holds: the step can't tell the number's
	// new owner from the old one, and waits.
	f.clock.advance(30 * time.Second)
	f.anotherStepProcess(machine)
	if err := f.run(); err == nil {
		t.Fatal("the step ended the request on a listing of the process the record names while the record held")
	}
	if journal, found := f.journal(); !found || !journal.active() {
		t.Fatalf("the journal while the record held: %+v (found %v)", journal, found)
	}

	// Past the record's life it is no record.
	f.clock.advance(recordLife())
	f.anotherStepProcess(machine)
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	if _, kept := recordNames(t, mac); kept {
		t.Error("the record of a job that was over is still there")
	}
	if service := f.service(); service.State != "active" || service.Version != "0.1.0" {
		t.Errorf("the agent's service: %+v", service)
	}
}

// The record is written before launchctl is asked to boot the job out, and a write that fails is
// not ignored: nothing is stopped, the swap doesn't go on, and the stop fails with the reason as
// any stop that fails does. The old build runs, as it did, and launchd shows it started, so the
// request ends INTERRUPTED with the agent never stopped.
func TestARecordThatCannotBeWrittenStopsTheSwapBeforeAnythingIsStopped(t *testing.T) {
	f := newStepFixture(t)
	machine, mac := f.useLaunchd()
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	// A directory where the record goes: the file can't be put there, as it can't be on a disk
	// that is full or failing.
	mkdirMode(t, mac.leavingPath(), 0o700)
	if err := os.WriteFile(filepath.Join(mac.leavingPath(), "held"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	log := captureStepLog(t, f.mustRun)

	for _, call := range machine.calls {
		if strings.HasPrefix(call, "bootout ") || strings.HasPrefix(call, "bootstrap ") {
			t.Errorf("launchd was asked %q although the record of it couldn't be written", call)
		}
	}
	if !strings.Contains(log, "couldn't stop the service: couldn't write the record of the agent's job before launchd is told to remove it, so launchctl wasn't asked to:") {
		t.Errorf("the step's log doesn't say why the stop failed:\n%s", log)
	}
	if got := f.executableDigest(); got != oldDigest {
		t.Errorf("the executable changed to %s", got)
	}
	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	if got := strings.Join(f.service().History, ","); got != "start 0.1.0" {
		t.Errorf("the service's history: %s; the agent was never stopped", got)
	}
	if !machine.loaded || f.service().State != "active" {
		t.Errorf("the agent's job: loaded %v, service %+v", machine.loaded, f.service())
	}
}

// The record is on disk, synced, when launchctl is asked, and says what the next run needs: the
// process `print` listed, the boot session of the Mac, how long it had been awake and when.
func TestTheRecordIsOnDiskWithWhatTheNextRunNeedsWhenLaunchctlIsAskedToBootTheJobOut(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", listingOf(4242))
	var seen string
	recorder.beforeCall = func(call string) {
		if call == "bootout system/io.vectory.agent" {
			seen = leavingRecord(t, host)
		}
	}
	started := recorder.clock

	if err := host.StopService(context.Background()); err == nil {
		t.Fatal("a stop of a job launchd lists for ever ended without an error")
	}

	want := fmt.Sprintf(`{"pid":4242,"boot":"uuid:boot-a","awake_ns":%d,"at":"%s"}`+"\n", int64(time.Hour), started.Format(time.RFC3339Nano))
	if seen != want {
		t.Errorf("the record when launchctl was asked:\n%q\nwant\n%q", seen, want)
	}
}
