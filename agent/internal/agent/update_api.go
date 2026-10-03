package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// The privileged step's API, which the agent's host side (setup, `vectory update`
// and the offer handling) calls and the step's own code fills. The signatures are
// frozen: callers are written against them, so a change to one needs the callers'
// authors.
//
// dir is the agent's state directory throughout.

// InstallUpdateHelper makes the host ready to apply updates: it makes the step's
// directory (UpdateLocations), copies executable, the running agent, into it as
// the helper the step runs from, records the build that is installed, and
// registers and starts the step's units (a timer and a service on Linux). It is
// called by setup when the host consents, after the policy is written and after
// the agent's service is registered, and may be called again: it leaves a helper
// that is already the executable as it is, and it clears the fork the step
// recorded (a host that is pinned again starts over, and keeps its floors).
//
// It refuses a host that can't take an update, with the code UpdateEligibility
// gives and the reason: nothing is changed then. executable must be the
// executable the registered service runs for dir. It refuses while an update is
// being applied or tried, because replacing the helper then would put the build
// under trial in the place of the one that rolls it back.
func InstallUpdateHelper(dir, executable string) error {
	host := currentUpdateHost()
	if host == nil {
		return errUpdateStepUnavailable
	}
	if !canWriteRootOwned() {
		return errors.New("installing the update step needs root (an Administrator on Windows): run the command with sudo")
	}
	if !filepath.IsAbs(dir) || !filepath.IsAbs(executable) || filepath.Clean(executable) != executable {
		return fmt.Errorf("the state directory and the executable must be absolute paths, and %q and %q aren't", dir, executable)
	}
	facts := inspectHost(host, dir, executable)
	if facts.install != nil {
		defer facts.install.Close()
	}
	if facts.code != UpdateEligible {
		return &UpdateRefusal{Code: facts.code, Detail: facts.detail}
	}
	paths := UpdateLocations()
	private, release, err := openStepForInstall(host, paths)
	if err != nil {
		return err
	}
	defer private.Close()
	defer func() {
		if release != nil {
			release()
		}
	}()
	if journal, found, err := readUpdateJournal(private); err != nil {
		return fmt.Errorf("%s can't be read; leave it for a person to mend: %w", paths.Journal, err)
	} else if found && journal.active() {
		return errUpdateInProgress(journal)
	}

	digest, present, err := facts.install.Digest(facts.install.Name())
	if err != nil {
		return err
	}
	if !present {
		return fmt.Errorf("%s isn't there", executable)
	}
	if err := placeHelper(host, facts.install, paths, digest); err != nil {
		return fmt.Errorf("couldn't place the update step's copy of the agent: %w", err)
	}
	if err := recordInstalled(context.Background(), host, private, facts, executable, digest); err != nil {
		return err
	}
	counters, err := readUpdateCounters(private)
	if err != nil {
		return err
	}
	if counters.RolloverConflict != nil {
		counters.RolloverConflict = nil
		if err := writeUpdateCounters(private, counters); err != nil {
			return err
		}
	}
	release()
	release = nil
	return host.InstallUnits(updateUnitSpec{StateDir: dir, InstallDir: filepath.Dir(executable), Helper: paths.HelperExecutable})
}

// openStepForInstall makes the step's directories (root's, the step's directory and
// the probe's readable by everyone, the private directory closed) and takes the
// step's lock, so that a run of the step doesn't see a half-made directory.
func openStepForInstall(host updateHost, paths UpdatePaths) (*rootOwned, func(), error) {
	for _, directory := range []struct {
		path string
		leaf rootFilePerm
	}{{paths.PolicyDir, rootReadable}, {paths.StepDir, rootReadable}, {paths.Probe, rootReadable}} {
		held, err := ensureRootOwnedDir(directory.path, directory.leaf)
		if err != nil {
			return nil, nil, err
		}
		held.Close()
	}
	var private *rootOwned
	for _, directory := range []string{paths.Private, paths.Staging, paths.Helper} {
		held, err := ensureRootOwnedDir(directory, rootPrivate)
		if err != nil {
			return nil, nil, err
		}
		if private == nil {
			private = held
		} else {
			held.Close()
		}
	}
	if err := host.CheckPrivate(private); err != nil {
		private.Close()
		return nil, nil, err
	}
	release, err := host.Lock(private)
	if err != nil {
		private.Close()
		if errors.Is(err, errUpdateStepBusy) {
			return nil, nil, errors.New("the update step is working now; try again in a minute")
		}
		return nil, nil, err
	}
	return private, release, nil
}

// errUpdateInProgress is why the step's files can't be replaced or removed now: the
// step is applying, trying or taking back an update. A trial ends by a time the journal
// knows. A rollback has none to name: it is over when the previous build is in place,
// started and has been watched, and the deadline it carries is set again each time it has
// passed while the step still can't start the build, so a time taken from it would move on
// for ever. An update that has swapped is held the same way, by a stop or a start the
// service manager won't make.
func errUpdateInProgress(journal updateJournal) error {
	switch journal.Stage {
	case UpdateStageRollingBack:
		return errors.New(rollbackBusyWords)
	case UpdateStageSwapping:
		return errors.New(swapBusyWords)
	}
	if journal.Deadline.IsZero() || !currentUpdateClock().Now().Before(journal.Deadline) {
		return errors.New("an update is being applied or was interrupted, and the update step hasn't settled it yet; try again in a few minutes")
	}
	return fmt.Errorf("an update is being tried; it ends by %s", journal.Deadline.Local().Format("15:04"))
}

// recordInstalled records the build that is installed: its version, which it says
// itself when it runs as the service account, and its digest. A record that is
// already there for the same file stays, with the release it came from.
func recordInstalled(ctx context.Context, host updateHost, private *rootOwned, facts hostFacts, executable, digest string) error {
	if existing, found, err := readUpdateInstalled(private); err == nil && found && existing.SHA256 == digest {
		return nil
	}
	output, err := host.RunProbe(ctx, executable, facts.service.Account)
	if err != nil {
		return fmt.Errorf("couldn't ask %s its version as the service account: %w", executable, err)
	}
	version, err := probeVersionOf(output)
	if err != nil {
		return fmt.Errorf("%s didn't print a version: %w", executable, err)
	}
	return writeUpdateInstalled(private, updateInstalled{Version: version, SHA256: digest, RecordedAt: currentUpdateClock().Now().UTC().Truncate(time.Second)})
}

// placeHelper makes the helper copy the build whose digest is given: the installed
// executable, copied through the install handle into a file beside the helper,
// checked against the digest and renamed over the old copy. A helper that already
// is that build stays. The helper that is running keeps running from its own file.
func placeHelper(host updateHost, install updateInstall, paths UpdatePaths, digest string) error {
	helper, err := ensureRootOwnedDir(paths.Helper, rootPrivate)
	if err != nil {
		return err
	}
	defer helper.Close()
	name := filepath.Base(paths.HelperExecutable)
	next := name + ".next"
	if file, err := helper.OpenAt(name); err == nil {
		current, hashErr := digestOfReader(file)
		file.Close()
		if hashErr == nil && current == digest {
			return nil
		}
	}
	installed, err := install.Open(install.Name())
	if err != nil {
		return err
	}
	defer installed.Close()
	_ = host.RemoveFrom(helper, next)
	copied, err := host.CopyInto(helper, next, rootExecutable, installed, -1)
	if err != nil {
		_ = host.RemoveFrom(helper, next)
		return err
	}
	if copied != digest {
		_ = host.RemoveFrom(helper, next)
		return fmt.Errorf("the executable is %s, not the build %s that was expected", shortFingerprint(copied), shortFingerprint(digest))
	}
	return host.Replace(helper, next, name)
}

// RemoveUpdateHelper stops and removes the step's units and its directory. It is
// refused while a trial runs (the step's journal says swapping, trial or
// rolling_back), with the time it ends: the step's next run is what settles an
// interrupted update, and without it the host could be left on a build nobody
// proved. What the step left beside the executable (the previous build) goes with
// it. Called by `vectory update off` and by service uninstall.
//
// It uses the operating system's host whatever the gate says (removalUpdateHost): a
// build that doesn't ship updates here still has to take away a step, and the root
// launch daemon or service that runs it, which an earlier build installed. Where no
// step is written for the operating system, there is none to remove, and a step's
// directory that is there anyway is said to be out of its reach, never reported removed.
func RemoveUpdateHelper() error { return removeStepWith(removalUpdateHost()) }

// removeStepWith is RemoveUpdateHelper for the host given: nil where no step is written
// for the operating system.
func removeStepWith(host updateHost) error {
	_, err := removeStepReporting(host)
	return err
}

// removeStepReporting is removeStepWith, and says whether the removal ended a rollback that
// waited for the agent's service to start, also where it stopped after that: what a person is
// told about the rollback is what the removal did, and not what it was expected to do when
// it was asked.
func removeStepReporting(host updateHost) (endedARollback bool, err error) {
	paths := UpdateLocations()
	_, statErr := os.Lstat(paths.StepDir)
	if host == nil {
		if notExist(statErr) {
			return false, nil
		}
		return false, fmt.Errorf("this build has no update step for this operating system, so it can't take away %s: delete it yourself", paths.StepDir)
	}
	if notExist(statErr) {
		return false, removeUnits(host, nil)
	}
	if !canWriteRootOwned() {
		return false, errors.New("removing the update step needs root (an Administrator on Windows): run the command with sudo")
	}
	ended, err := removeStepUnits(host, paths)
	if err != nil {
		return ended, err
	}
	return ended, removeTree(paths.StepDir)
}

// removeStepUnits takes the step's units away while it holds the step's lock, so
// that no run is under way, and lets go of the lock and of the directories it
// opened before it returns: the directory is removed next, and a file that is open
// can't be deleted on Windows. It says whether it ended a rollback that waited for a start.
func removeStepUnits(host updateHost, paths UpdatePaths) (endedARollback bool, err error) {
	private, err := openRootOwned(paths.Private, rootOwnedDirectory)
	if err != nil && !notExist(err) {
		return false, err
	}
	var journal *updateJournal
	if private != nil {
		defer private.Close()
		release, err := lockStepForRemoval(host, private)
		if errors.Is(err, errUpdateStepBusy) {
			return false, errors.New("the update step is working now; try again in a minute")
		}
		if err != nil {
			return false, err
		}
		defer release()
		found, ok, err := readUpdateJournal(private)
		if err != nil {
			return false, fmt.Errorf("%s can't be read; leave it for a person to mend: %w", paths.Journal, err)
		}
		if ok {
			if found.active() && found.Stage != UpdateStagePreparing {
				endedARollback, err = endRollbackWaitingForAStart(host, paths, &found)
				if err != nil {
					return false, err
				}
				if !endedARollback {
					return false, removalRefusal(host, found)
				}
			}
			journal = &found
		}
	}
	return endedARollback, removeUnits(host, journal)
}

// removalRefusal is why the removal of the step refuses an update that has swapped: the words
// for the step's own work, and for a rollback whose start can't be made because the agent's
// service isn't registered, the words that say so (rollbackWithoutRegistration).
func removalRefusal(host updateHost, journal updateJournal) error {
	if err := rollbackWithoutRegistration(host, journal); err != nil {
		return err
	}
	return errUpdateInProgress(journal)
}

const (
	// removalLockWait is how long the removal of the step waits for a run of the step to end
	// when the step is trying to start the previous build of a rollback. On a Mac such a run
	// lasts most of a minute (a start that launchd refuses is tried again for
	// launchdStartBound) and the timer starts the next one on its own 30-second beat, so a
	// removal that tried the step's lock once would find it held most of the time. It is not a
	// bound on the run: launchctl calls that hang at their limits (5 seconds to print, 30 to
	// bootstrap) stretch a run past it, and the removal then says that the step is working, which
	// is true, and that a later try is the way: the words and the documents say so.
	removalLockWait = 90 * time.Second
	removalLockPoll = 250 * time.Millisecond
)

// lockStepForRemoval takes the step's lock, which the removal needs so that no run is under
// way. A run that is under way holds it, and a removal that finds it held says so. Where the
// journal says rolling_back and the previous build is in place but isn't running, so that
// only its start is missing, the run is the step's try at that start, and the next one comes
// soon after: the removal waits for the lock, up to removalLockWait, instead of leaving it to
// chance whether the person's next try finds it free. A run of any other kind isn't waited
// for: a trial's watch, a swap, and the watch of a previous build that runs last minutes, and
// the removal says at once that the step is working. A previous build that starts and ends
// again (launchd shows its job as waiting for its next start, which reads "activating", and the
// watch of such a build is the run that holds the lock) doesn't run when the removal looks, so
// the removal waits for that run too, up to removalLockWait, before it says the same.
func lockStepForRemoval(host updateHost, private *rootOwned) (func(), error) {
	release, err := host.Lock(private)
	if !errors.Is(err, errUpdateStepBusy) {
		return release, err
	}
	journal, found, readErr := readUpdateJournal(private)
	if readErr != nil || !found || !rollbackWaitsForAStart(host, journal) {
		return nil, err
	}
	if state, stateErr := host.ServiceState(context.Background()); stateErr == nil && state.running() {
		return nil, err
	}
	clock := currentUpdateClock()
	deadline := clock.Now().Add(removalLockWait)
	for clock.Now().Before(deadline) {
		if sleepErr := clock.Sleep(context.Background(), removalLockPoll); sleepErr != nil {
			return nil, sleepErr
		}
		if release, err = host.Lock(private); !errors.Is(err, errUpdateStepBusy) {
			return release, err
		}
	}
	return nil, err
}

// rollbackWaitsForAStart says whether the step's journal is a rollback that has put the
// previous build back and has only its start to make: the executable the agent's service
// runs is the build the journal says the update came from. A rollback whose executable is
// anything else is mid-way, and so is one whose executable can't be read: that is the one
// that rollbackWithoutRegistration says what to do about.
func rollbackWaitsForAStart(host updateHost, journal updateJournal) bool {
	if journal.Stage != UpdateStageRollingBack || journal.From == nil {
		return false
	}
	locator, ok := host.(agentLocator)
	if !ok {
		return false
	}
	executable, err := locator.AgentExecutable()
	if err != nil {
		return false
	}
	install, _ := host.OpenInstall(executable)
	if install == nil {
		return false
	}
	defer install.Close()
	digest, present, err := install.Digest(install.Name())
	return err == nil && present && digest == journal.From.SHA256
}

// rollbackWithoutRegistration is the refusal for a rollback whose start the step can't make
// because the agent's service isn't registered: its definition, unit or service was removed by
// hand, so the step can't find the executable the service runs and can't start anything. The
// removal doesn't end such a rollback, because it can't say whether the previous build is in
// place; the one thing that ends it is the command that registers the service again, after which
// the step's next run finishes the rollback itself. It is nil for any other journal, and for one
// whose registration can be read.
func rollbackWithoutRegistration(host updateHost, journal updateJournal) error {
	if journal.Stage != UpdateStageRollingBack {
		return nil
	}
	locator, ok := host.(agentLocator)
	if !ok {
		return nil
	}
	if _, err := locator.AgentExecutable(); err != nil {
		return &UpdateBusyError{Message: unregisteredRollbackWords(err)}
	}
	return nil
}

// unregisteredRollbackWords says that a rollback can't be ended or helped by the removal of the
// step because the agent's service has no registration the step can use, and what gives it one.
// Where the registration is there and can't be read as the one setup writes, nothing says that
// registering it again puts it right, so the words name no command.
func unregisteredRollbackWords(cause error) string {
	if !errors.Is(cause, errAgentNotRegistered) {
		return "an update is being rolled back on this host, and the update step can't read the registration of the agent's service (" + safeText(cause.Error(), 200) + "), so it can't start the previous build. Put the registration right; the update step then finishes the rollback by itself, usually within a minute or two"
	}
	command := "`" + AdminCommandFor("", "vectory service-install") + "`"
	if runtime.GOOS == "windows" {
		command += " in an elevated PowerShell"
	}
	return "an update is being rolled back on this host, and " + cause.Error() + ", so the update step can't start the previous build. Register the service again with " + command + "; the update step then finishes the rollback by itself, usually within a minute or two"
}

// endRollbackWaitingForAStart ends a rollback that has put the previous build back and
// waits for its start, for the removal of the step, which holds the step's lock. The step
// tries the start again every 30 seconds for as long as it takes, and a service that can
// never start (its job disabled, its unit masked) would keep whoever removes the step, or
// turns updates off, waiting for ever. The request ends as the step ends an update that was
// interrupted after the swap, and as only the step's own journal and status say it: rolled
// back, INTERRUPTED, and the floors stay raised until the step's directory goes, which the
// removal does next. That record is the only one there is: nothing reports it, because the
// directory that holds it is removed by the same command. It reports whether it ended the
// rollback: one that hasn't put the previous build back isn't ended, because the step's next
// run still has the previous build to put in place, and the host would be left on one that was
// never proven.
func endRollbackWaitingForAStart(host updateHost, paths UpdatePaths, journal *updateJournal) (bool, error) {
	if !rollbackWaitsForAStart(host, *journal) {
		return false, nil
	}
	step := newUpdateStep(host, "", stepTimer, nil)
	step.paths = paths
	step.logf = func(string, ...any) {}
	if err := step.openDirectories(); err != nil {
		step.closeAll()
		return false, err
	}
	defer step.closeAll()
	if err := step.load(); err != nil {
		return false, err
	}
	step.eligibility = UpdateEligible
	if status, err := ReadUpdateStatus(); err == nil && status.Eligibility != "" {
		step.eligibility = status.Eligibility
	}
	return true, step.endRolledBack(journal, "INTERRUPTED")
}

// removeTree removes a directory and everything in it. On Windows a file that was
// written a moment ago may still be open in a virus scanner, and the process of a
// service that has just stopped may not have let go of its executable yet, so the
// removal is repeated for a few seconds before it is reported.
func removeTree(path string) error {
	err := os.RemoveAll(path)
	for attempt := 1; err != nil && runtime.GOOS == "windows" && attempt < 10; attempt++ {
		time.Sleep(500 * time.Millisecond)
		err = os.RemoveAll(path)
	}
	return err
}

// removeUnits removes the step's units and what it left beside the executable.
func removeUnits(host updateHost, journal *updateJournal) error {
	installDir, _, err := host.RemoveUnits()
	if err != nil {
		return err
	}
	if installDir == "" {
		return nil
	}
	held, err := openRootOwned(installDir, rootOwnedDirectory)
	if err != nil {
		return nil
	}
	defer held.Close()
	previous := updatePreviousFor(runtime.GOOS)
	names := []string{previous, previous + ".new"}
	if journal != nil && journal.Swap != nil {
		names = append(names, journal.Swap.Staged, journal.Swap.Previous+".new")
	}
	for _, name := range names {
		_ = host.RemoveFrom(held, name)
	}
	return nil
}

// ApplyStagedUpdate applies the build the agent staged now, in the foreground, for
// a host whose level is ask: it runs the step's work through the same code the
// step runs, and says each stage it reaches through progress. force says the
// person has already been shown that the offer may be gone or stale and chose to
// go on. What authorizes the install is never the request or force: the step
// verifies the signed manifest, the pins and the policy itself, so force changes
// nothing here.
//
// The process that does this is the installed agent. It keeps running from its own
// file when the swap replaces the name, so the rollback, if there is one, is made by
// this process, which is the build that was installed before. A person who
// interrupts it (Ctrl-C), a crash or a power cut leaves an update that has swapped
// to the step's timer, which settles it from the helper copy, the last build proven
// on this host, as it settles any crash. A second apply never takes it over: from
// the swap on, the installed agent is the build under trial, so apply says the
// update step is settling it (UpdateBeingSettledError) and changes nothing. An update still in preparing has
// swapped nothing, and apply ends it itself.
func ApplyStagedUpdate(ctx context.Context, dir string, force bool, progress func(string)) error {
	return runUpdateStep(ctx, dir, stepApply, progress)
}

// RunUpdateHelper is one run of the privileged step: the hidden `update-helper`
// command calls it every 30 seconds and at boot. It reads its journal, takes the
// next step, writes status.json and returns. A refusal of a request is a result it
// records, not an error.
func RunUpdateHelper(ctx context.Context, dir string) error {
	return runUpdateStep(ctx, dir, stepTimer, nil)
}

// UpdateEligibility is UpdateEligible when this host can take an agent update, and
// otherwise the code that says why not: PACKAGE_MANAGED, NO_SERVICE,
// UNTRUSTED_LOCATION, READ_ONLY or PLATFORM_NOT_IN_RELEASE. It reads only, and any
// account may call it. The service must be registered for this executable and dir
// (call it after ServiceInstall), because an update replaces the executable the
// service runs. SERVICE_DEFINITION_OUTDATED is a release's refusal (the release
// needs a newer definition than this build writes), and HELPER_NOT_RUNNING is the
// agent's to say when status.json is missing or older than two minutes: this
// function never answers either.
func UpdateEligibility(dir string) string {
	host := currentUpdateHost()
	if host == nil || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return "PLATFORM_NOT_IN_RELEASE"
	}
	running, err := os.Executable()
	if err != nil {
		return "NO_SERVICE"
	}
	facts := inspectHost(host, dir, running)
	if facts.install != nil {
		facts.install.Close()
	}
	return facts.code
}
