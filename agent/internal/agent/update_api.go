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
// step is applying or trying an update, and ends by a time it knows.
func errUpdateInProgress(journal updateJournal) error {
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
// it. Called by `vectory update off` and by service uninstall; it does nothing on a
// host that has no step.
func RemoveUpdateHelper() error {
	host := currentUpdateHost()
	if host == nil {
		return nil
	}
	paths := UpdateLocations()
	_, statErr := os.Lstat(paths.StepDir)
	if notExist(statErr) {
		return removeUnits(host, nil)
	}
	if !canWriteRootOwned() {
		return errors.New("removing the update step needs root (an Administrator on Windows): run the command with sudo")
	}
	if err := removeStepUnits(host, paths); err != nil {
		return err
	}
	return removeTree(paths.StepDir)
}

// removeStepUnits takes the step's units away while it holds the step's lock, so
// that no run is under way, and lets go of the lock and of the directories it
// opened before it returns: the directory is removed next, and a file that is open
// can't be deleted on Windows.
func removeStepUnits(host updateHost, paths UpdatePaths) error {
	private, err := openRootOwned(paths.Private, rootOwnedDirectory)
	if err != nil && !notExist(err) {
		return err
	}
	var journal *updateJournal
	if private != nil {
		defer private.Close()
		release, err := host.Lock(private)
		if errors.Is(err, errUpdateStepBusy) {
			return errors.New("the update step is working now; try again in a minute")
		}
		if err != nil {
			return err
		}
		defer release()
		found, ok, err := readUpdateJournal(private)
		if err != nil {
			return fmt.Errorf("%s can't be read; leave it for a person to mend: %w", paths.Journal, err)
		}
		if ok {
			if found.active() && found.Stage != UpdateStagePreparing {
				return errUpdateInProgress(found)
			}
			journal = &found
		}
	}
	return removeUnits(host, journal)
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
