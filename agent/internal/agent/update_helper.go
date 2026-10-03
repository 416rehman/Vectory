package agent

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// The privileged step: one function that reads the journal and takes the next
// step, so that every run is idempotent and every crash between two steps is
// resumed by the next run. It runs as root (SYSTEM on Windows), from a copy of the
// last build that was proven on this host, and it does no network I/O.
//
// What the service account can write is untrusted input: <state>/updates/ is its
// directory, so the step copies each file it needs out of it (OpenServiceFile,
// without following a link, requiring a regular file of that account within its
// bound) into its own private directory, and from then on reads, verifies and
// installs only its copies. What authorizes an install is never the request: the
// step verifies the signed manifest against the pins in the root-owned policy, the
// counter floors it keeps, and the host's own state, itself, in the order of the
// contract (VerifyRelease), before it probes, stages or swaps anything.
//
// The order of a request, and the invariant each step protects:
//
//	consent      the root-owned policy says off, paused, ask or auto (and a window);
//	             a host held by `vectory pause` leaves the request waiting           I1
//	fork         the offer's small files are read, with no copy and no build, and two
//	             statements of a pinned key that name different successors are
//	             recorded before any wait; nothing else is touched                   I2
//	eligibility  a service that runs this executable, no package, a root-owned
//	             install directory and room for two copies                           I1
//	preparing    the journal is written; the offer's small files are copied and the
//	             manifest is verified against the pins and the floors                I2
//	             the build is copied, and checked against the signed size and digest I2
//	             the build is probed as the service account from probe/
//	             the build is staged beside the executable, and hashed there
//	swapping     the floors are raised and synced, then the journal says swapping,
//	             then the service stops and the executable is replaced               I2, I3
//	trial        the new build runs for five minutes under a watch of the service
//	             manager and of the check-in it records
//	committed    the previous build stays beside the executable
//	rolling_back the previous build is put back by this process, which is the old
//	             build, never by the build under trial                               I3
//
// The journal is written and synced before each step it names. A step that fails
// before the swap leaves nothing but its own files and a temporary file beside the
// executable, which the next run removes.
//
// Who settles what. The run that makes a swap settles it: the timer's run is the
// helper copy, and `vectory update apply` is the agent that was installed before
// the swap, which keeps running from its own file when the swap replaces the name.
// An update that was interrupted after the swap (swapping, trial, rolling_back) is
// settled only by the timer's run, from the helper copy, which is still the last
// build proven on this host. A run that is the installed agent never settles it,
// because after the swap that agent is the build under trial.

const (
	// The trial lasts five minutes from the start of the service, and so does the
	// watch of a rollback. The step looks every two seconds, and three automatic
	// restarts of the service end the trial at once.
	updateTrialDuration = 5 * time.Minute
	updatePollInterval  = 2 * time.Second
	updateRestartLimit  = 3
	// A status.json older than two minutes tells the agent the step isn't running,
	// so a long wait refreshes it often.
	updateStatusRefresh = 10 * time.Second
	// A check-in whose time is further ahead of the step's clock than this isn't
	// one: a record from the future is never a record of the trial.
	updateFutureSkew = 30 * time.Second

	// updateServiceDefinition is the generation of the service definition this
	// build writes and expects, which status.json reports. Every 0.1 definition is
	// generation 1.
	updateServiceDefinition = 1

	updatePreviousName     = ".vectory-previous"
	updateStagedPrefix     = ".vectory-update-"
	updateHealthBeforeFile = "health-before.json"
)

// updatePreviousFor is the name the build that a swap replaces is kept under
// beside the executable: a hidden name where the swap makes a second name of the
// old file (Linux and macOS), and the executable's own name with .previous on
// Windows, where the old file itself steps aside (the contract's swap member).
func updatePreviousFor(goos string) string {
	if goos == "windows" {
		return "vectory.exe.previous"
	}
	return updatePreviousName
}

// stepMode says who asked for this run.
type stepMode int

const (
	// stepTimer is the run the timer starts every 30 seconds and at boot.
	stepTimer stepMode = iota
	// stepApply is `vectory update apply`, a person at the keyboard, in the
	// foreground: it applies what the timer's run leaves waiting for them.
	stepApply
)

// updateStep is one run of the step.
type updateStep struct {
	host     updateHost
	clock    updateClock
	paths    UpdatePaths
	stateDir string
	exchange UpdateExchange
	mode     stepMode
	progress func(string)
	logf     func(format string, args ...any)

	// What the run holds open: the step's own directories, and (once the service
	// is known) the install directory and the executable in it.
	stepDir, private, staging, probeDir *rootOwned
	install                             updateInstall

	// What the run read.
	policy        UpdatePolicy
	policyErr     error
	counters      updateCounters
	installed     updateInstalled
	haveInstalled bool
	journal       updateJournal
	haveJournal   bool
	last          *UpdateLast

	service     registeredService
	eligibility string
}

func newUpdateStep(host updateHost, dir string, mode stepMode, progress func(string)) *updateStep {
	return &updateStep{
		host:     host,
		clock:    currentUpdateClock(),
		paths:    UpdateLocations(),
		stateDir: dir,
		exchange: UpdateExchangeFor(dir),
		mode:     mode,
		progress: progress,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "update step: "+format+"\n", args...)
		},
	}
}

var errUpdateStepUnavailable = errors.New("this build has no privileged update step for this operating system")

// runUpdateStep is RunUpdateHelper and ApplyStagedUpdate.
func runUpdateStep(ctx context.Context, dir string, mode stepMode, progress func(string)) error {
	host := currentUpdateHost()
	if host == nil {
		return errUpdateStepUnavailable
	}
	if !canWriteRootOwned() {
		return errors.New("the update step runs as root (an Administrator on Windows): run it with sudo")
	}
	step := newUpdateStep(host, dir, mode, progress)
	return step.run(ctx)
}

func (s *updateStep) now() time.Time { return s.clock.Now().UTC().Truncate(time.Second) }

func (s *updateStep) say(message string) {
	if s.progress != nil {
		s.progress(message)
	}
}

// ---------------------------------------------------------------- opening, locking, loading

func (s *updateStep) openDirectories() error {
	var err error
	if s.stepDir, err = openRootOwned(s.paths.StepDir, rootOwnedDirectory); err != nil {
		if notExist(err) {
			return fmt.Errorf("the update step isn't installed here (%s doesn't exist): run `vectory setup` with --updates", s.paths.StepDir)
		}
		return err
	}
	if s.private, err = openRootOwned(s.paths.Private, rootOwnedDirectory); err != nil {
		return err
	}
	if err = s.host.CheckPrivate(s.private); err != nil {
		return err
	}
	for _, directory := range []struct {
		held **rootOwned
		path string
		leaf rootFilePerm
	}{{&s.staging, s.paths.Staging, rootPrivate}, {&s.probeDir, s.paths.Probe, rootReadable}} {
		if *directory.held, err = ensureRootOwnedDir(directory.path, directory.leaf); err != nil {
			return err
		}
	}
	return nil
}

func (s *updateStep) closeAll() {
	for _, held := range []*rootOwned{s.stepDir, s.private, s.staging, s.probeDir} {
		if held != nil {
			_ = held.Close()
		}
	}
	if s.install != nil {
		_ = s.install.Close()
		s.install = nil
	}
}

// run is one run of the step.
func (s *updateStep) run(ctx context.Context) error {
	if err := s.openDirectories(); err != nil {
		s.closeAll()
		return err
	}
	defer s.closeAll()
	release, err := s.host.Lock(s.private)
	if errors.Is(err, errUpdateStepBusy) {
		if s.mode == stepTimer {
			return nil
		}
		return errors.New("another run of the update step is working now; try again in a minute")
	}
	if err != nil {
		return err
	}
	defer release()

	if err := s.load(); err != nil {
		return err
	}
	s.eligibility = s.computeEligibility()
	faultPoint("run:started")

	if s.haveJournal && s.journal.active() {
		// An update that has swapped is judged and undone by the update step's own
		// run, never by the installed agent, which after the swap is the build under
		// trial (I3). A journal in preparing has swapped nothing, so any run may end it.
		if s.journal.Stage != UpdateStagePreparing && s.runsAsInstalledBuild() {
			return UpdateBeingSettledError(s.stateDir)
		}
		return s.resume(ctx)
	}
	return s.idle(ctx)
}

// runsAsInstalledBuild says whether this run is the agent that is installed.
// `vectory update apply` always is: it is the executable at the install path, which
// once a swap has happened is the build under trial. The timer's run is the helper
// copy, another file; a run of `update-helper` that someone starts by hand from the
// installed executable is the installed build too, and is told apart by its file.
func (s *updateStep) runsAsInstalledBuild() bool {
	if s.mode == stepApply {
		return true
	}
	self, err := os.Executable()
	return err == nil && sameFile(self, s.service.Executable)
}

// sameFile reports whether two paths name one file.
func sameFile(a, b string) bool {
	first, err := os.Stat(a)
	if err != nil {
		return false
	}
	second, err := os.Stat(b)
	return err == nil && os.SameFile(first, second)
}

// UpdateBeingSettledError is what a run that must not settle an update that has
// swapped says, and does: it writes nothing, and leaves the update to the update
// step. `vectory update apply` says it before it asks anything, when the step's
// status shows such an update, and the step says it again to a run that finds one
// in its journal.
func UpdateBeingSettledError(stateDir string) error {
	return errors.New("an update that already began is being settled by the background update step. This command leaves it to that step, which finishes it by itself, usually within a minute or two. See where it stands: " +
		AdminCommandFor(stateDir, "vectory update status"))
}

// load reads what the step keeps and what the root-owned policy says. A counters.json
// or a journal that can't be read stops the run: a step that forgets its floors would
// try a release twice, and one that forgets what it was doing could leave a
// stopped service.
func (s *updateStep) load() error {
	s.policy, _, s.policyErr = readUpdatePolicy(s.paths)
	var err error
	if s.counters, err = readUpdateCounters(s.private); err != nil {
		return fmt.Errorf("the update step won't run until %s is mended or removed by a person: %w", s.paths.Counters, err)
	}
	if s.journal, s.haveJournal, err = readUpdateJournal(s.private); err != nil {
		return fmt.Errorf("the update step won't run until %s is mended or removed by a person: %w", s.paths.Journal, err)
	}
	if s.installed, s.haveInstalled, err = readUpdateInstalled(s.private); err != nil {
		s.logf("%v; the installed build is read from the executable again", err)
		s.haveInstalled = false
	}
	s.last = s.readLast()
	return nil
}

// readLast is the result of the latest request that ended, which only the step
// writes, in the status file of its own root-owned directory. When the journal
// ended later than that result (a crash between the two writes), the journal's own
// end is the result.
func (s *updateStep) readLast() *UpdateLast {
	var last *UpdateLast
	if data, found, err := readStepFile(s.stepDir, updateStatusFile, MaxUpdateFile); err == nil && found {
		if status, err := ParseUpdateStatus(data); err == nil {
			last = status.Last
		}
	}
	if s.haveJournal && !s.journal.active() && !s.journal.FinishedAt.IsZero() && (last == nil || last.At.Before(s.journal.FinishedAt)) {
		result := UpdateLast{Release: s.journal.Release, Outcome: UpdateOutcomeCommitted, Code: s.journal.Code, At: s.journal.FinishedAt}
		if s.journal.Stage == updateJournalRolledBack {
			result.Outcome = UpdateOutcomeRolledBack
		}
		result.FromVersion, result.ToVersion = "unknown", ""
		if s.journal.From != nil {
			result.FromVersion = s.journal.From.Version
		}
		if s.journal.To != nil {
			result.ToVersion = s.journal.To.Version
		}
		return &result
	}
	return last
}

// ---------------------------------------------------------------- eligibility

// computeEligibility asks the host the questions of the contract's list of hosts
// that can't be updated, from the cheapest, and keeps what it learned: the
// registered service, and the install directory and the executable, held open.
func (s *updateStep) computeEligibility() string {
	facts := inspectHost(s.host, s.stateDir, "")
	s.install, s.service = facts.install, facts.service
	if facts.code != UpdateEligible {
		s.logf("%s: %s", facts.code, facts.detail)
	}
	return facts.code
}

// hostFacts is what the step learns about the host: whether it can take an update,
// the registered service and the install directory held open.
type hostFacts struct {
	// code is UpdateEligible or the code that says why not, and detail the
	// sentence that says what was found.
	code, detail string
	service      registeredService
	// install is open whenever the install directory could be opened, even for a
	// host that is read-only, because a trial in progress still has to be settled
	// there. The caller closes it.
	install updateInstall
}

// inspectHost asks the host the questions of the contract's list of hosts that
// can't be updated, from the cheapest. running is the executable of the caller when
// the caller is the installed agent (the helper copy passes ""), which must be the
// one the service runs. It reads only.
func inspectHost(host updateHost, stateDir, running string) hostFacts {
	refused := func(err error, fallback string, facts hostFacts) hostFacts {
		facts.code, facts.detail = fallback, err.Error()
		var refusal *UpdateRefusal
		if errors.As(err, &refusal) {
			facts.code, facts.detail = refusal.Code, refusal.Detail
		}
		return facts
	}
	service, err := host.Registered(stateDir)
	if err != nil {
		return refused(err, "NO_SERVICE", hostFacts{})
	}
	facts := hostFacts{service: service}
	fail := func(code, format string, args ...any) hostFacts {
		facts.code, facts.detail = code, fmt.Sprintf(format, args...)
		return facts
	}
	// The install directory is opened first, whatever else is wrong with the host,
	// so that an update in progress can still be settled there (a trial that began
	// before a package took the executable over, say): the answers below decide
	// whether a new update starts, and this one decides whether the step can see.
	install, openErr := host.OpenInstall(service.Executable)
	facts.install = install
	switch {
	case service.Account.UID == 0:
		return fail("NO_SERVICE", "the agent's service runs as root, so no update is applied: the service account must not be root")
	case running != "" && running != service.Executable:
		return fail("NO_SERVICE", "the registered service runs %s, not %s", service.Executable, running)
	}
	if reason, managed := host.PackageManaged(service.Executable); managed {
		return fail("PACKAGE_MANAGED", "%s is managed by a package: %s", service.Executable, reason)
	}
	if err := host.StateDirReachable(stateDir); err != nil {
		return refused(err, "UNTRUSTED_LOCATION", facts)
	}
	if openErr != nil {
		if notExist(openErr) {
			return fail("NO_SERVICE", "the service's executable %s isn't there", service.Executable)
		}
		return refused(openErr, "UNTRUSTED_LOCATION", facts)
	}
	if install.ReadOnly() {
		return fail("READ_ONLY", "the file system that holds %s is mounted read-only", service.Executable)
	}
	facts.code = UpdateEligible
	return facts
}

// ---------------------------------------------------------------- status.json

// floorsForStatus are the floors the status file reports: at most four, those of
// the pinned keys first. counters.json keeps more.
func (s *updateStep) floorsForStatus() map[string]uint64 {
	floors := make(map[string]uint64, len(s.counters.HighestCounters))
	for fingerprint, floor := range s.counters.HighestCounters {
		floors[fingerprint] = floor
	}
	return trimFloors(floors, s.policy.Fingerprints(), maxUpdateFingerprints)
}

// writeStatus writes status.json for the journal j, or for an idle step when j is
// nil or has ended. The agent reads it to know the step is alive, what it is doing
// and what its last result was.
func (s *updateStep) writeStatus(j *updateJournal) error {
	status := UpdateStatus{
		RunAt: s.now(), Stage: UpdateStageIdle, Eligibility: s.eligibility, ServiceDefinition: updateServiceDefinition,
		HighestCounters: s.floorsForStatus(), RolloverConflict: s.counters.RolloverConflict, Last: s.last,
	}
	if j != nil && j.active() {
		status.Stage, status.Release, status.Deadline = j.Stage, j.Release, j.Deadline
		if j.From != nil {
			status.FromVersion = j.From.Version
		}
		if j.To != nil {
			status.ToVersion = j.To.Version
		}
	}
	if err := WriteUpdateStatus(s.stepDir, status); err != nil {
		return fmt.Errorf("couldn't write %s: %w", s.paths.Status, err)
	}
	return nil
}

// recordResult remembers the outcome of the request that ended, for status.json
// and for VerifyRelease, which refuses a release the last result says was rolled
// back.
func (s *updateStep) recordResult(release, outcome, code, from, to string, firstCheckInMS *uint32) {
	if !validUpdateText(from) {
		from = "unknown"
	}
	if to != "" && !validUpdateVersion(to) {
		to = ""
	}
	s.last = &UpdateLast{Release: release, Outcome: outcome, Code: code, At: s.now(), FromVersion: from, ToVersion: to, FirstCheckInMS: firstCheckInMS}
}

// outcomeOf says which outcome a code belongs to when a request ends with it:
// the contract's table. beforeSwap decides INTERRUPTED, which is a failure when
// nothing was replaced and a rollback when something was.
func outcomeOf(code string, beforeSwap bool) string {
	switch code {
	case "":
		return UpdateOutcomeCommitted
	case "START_FAILED", "NO_CHECK_IN", "UNHEALTHY", "ROLLBACK_UNHEALTHY":
		return UpdateOutcomeRolledBack
	case "INTERRUPTED":
		if beforeSwap {
			return UpdateOutcomeFailed
		}
		return UpdateOutcomeRolledBack
	case "PROBE_FAILED", "ARTIFACT_MISMATCH", "DISK_FULL", "BINARY_CHANGED":
		return UpdateOutcomeFailed
	}
	return UpdateOutcomeRefused
}

// ---------------------------------------------------------------- idle: finish, then a request

// idle is a run with no request in progress: it finishes what an earlier run left
// (the end of a commit or a rollback whose files are still there), clears what a
// failed run left, and looks for a request.
func (s *updateStep) idle(ctx context.Context) error {
	if s.haveJournal && s.stagingHolds(UpdateReleaseFile) {
		switch s.journal.Stage {
		case updateJournalCommitted:
			s.logf("finishing the commit of %s", s.journal.Release[:12])
			if err := s.finishCommit(ctx, &s.journal, nil); err != nil {
				return err
			}
		case updateJournalRolledBack:
			s.logf("finishing the rollback of %s", s.journal.Release[:12])
			if err := s.finishRollback(&s.journal); err != nil {
				return err
			}
		}
	}
	if s.eligibility != UpdateEligible {
		if err := s.writeStatus(nil); err != nil {
			return err
		}
		if s.mode == stepApply {
			return fmt.Errorf("this host can't take an update now (%s)", s.eligibility)
		}
		return nil
	}
	if !s.stagingHolds(UpdateReleaseFile) {
		// Nothing is mid-flight: whatever else is in the scratch directories is left
		// over from a run that failed.
		_ = s.host.EmptyDir(s.staging)
		_ = s.host.RemoveFrom(s.probeDir, UpdateBuildFile(runtime.GOOS))
	}
	request, modified, found := s.readRequest()
	if !found {
		if s.mode == stepApply {
			return errors.New("no update is staged: the agent stages one when a rollout reaches this device")
		}
		return s.writeStatus(nil)
	}
	return s.consider(ctx, request, modified)
}

// stagingHolds reports whether a file is in the step's staging directory.
func (s *updateStep) stagingHolds(name string) bool {
	_, found, err := readStepFile(s.staging, name, MaxReleaseManifest)
	return err == nil && found
}

// readRequest reads request.json, which only the service account writes. A request
// that isn't there, or isn't a request the agent could have written, is nothing:
// the step answers a request by naming its release, and a file that names none
// can't be answered.
func (s *updateStep) readRequest() (UpdateRequest, time.Time, bool) {
	file, err := s.host.OpenServiceFile(s.exchange.Dir, UpdateRequestFile, s.service.Account, MaxUpdateFile)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.logf("%s isn't a request: %v", UpdateRequestFile, err)
		}
		return UpdateRequest{}, time.Time{}, false
	}
	defer file.File.Close()
	data, err := readBounded(file.File, file.Size)
	if err != nil {
		s.logf("%s isn't a request: %v", UpdateRequestFile, err)
		return UpdateRequest{}, time.Time{}, false
	}
	request, err := ParseUpdateRequest(data)
	if err != nil {
		s.logf("%s isn't a request: %v", UpdateRequestFile, err)
		return UpdateRequest{}, time.Time{}, false
	}
	return request, file.ModTime, true
}

// consider decides what to do with a request: answer it, wait for the host's
// consent (a person, or a window), or start the update. Nothing here has changed
// anything beyond the step's own files yet.
func (s *updateStep) consider(ctx context.Context, request UpdateRequest, modified time.Time) error {
	// A request is answered once. One the step already answered, and that nobody
	// has written since, is left for the agent to clear: answering it again would
	// replace a result before the server has seen it (a commit the agent is about
	// to report), and would try again an update that was interrupted, behind the
	// back of the report that said it was. A request the agent writes again is a
	// new question.
	// (A result's time has whole seconds, so a request written in the second it
	// was answered counts as the one that was.)
	if last := s.last; last != nil && last.Release == request.ManifestSHA256 && modified.Before(last.At.Add(time.Second)) {
		return s.writeStatus(nil)
	}
	if code, detail := s.consentRefusal(); code != "" {
		return s.finishWithout(request.ManifestSHA256, code, detail)
	}
	if detail, waiting := s.pauseWait(); waiting {
		s.logf("%s", detail)
		return s.writeStatus(nil)
	}
	// The host that is off, paused or held verifies nothing, so this is after those
	// three. It is before the waits for a person and for a window: what the offer's
	// statements say about the keys is a fact about the offer, whenever consent lets it
	// through.
	if recorded, err := s.recordFork(request); recorded || err != nil {
		return err
	}
	if code, detail, waiting := s.consentWait(); waiting {
		s.logf("%s", detail)
		return s.writeStatus(nil)
	} else if code != "" {
		return s.finishWithout(request.ManifestSHA256, code, detail)
	}
	if s.counters.RolloverConflict != nil {
		if s.conflictStillApplies() {
			return s.finishWithout(request.ManifestSHA256, "KEY_ROLLOVER_CONFLICT", forkWords(s.counters.RolloverConflict))
		}
		s.counters.RolloverConflict = nil
		if err := writeUpdateCounters(s.private, s.counters); err != nil {
			return err
		}
	}
	state, err := s.host.ServiceState(ctx)
	if err != nil || !state.running() {
		detail := "the agent service isn't running, so a trial couldn't show that the new build checks in"
		if err != nil {
			detail += ": " + err.Error()
		}
		if s.mode == stepApply {
			return errors.New(detail + ". Start it with `sudo vectory service-start`, then apply again")
		}
		s.logf("%s", detail)
		return s.writeStatus(nil)
	}
	return s.prepare(ctx, request)
}

func shortFingerprint(fingerprint string) string {
	if len(fingerprint) > 16 {
		return fingerprint[:16]
	}
	return fingerprint
}

// conflictStillApplies reports whether the fork the step recorded still concerns a
// key the host pins. A host pinned again to other keys has left it behind.
func (s *updateStep) conflictStillApplies() bool {
	for _, fingerprint := range s.policy.Fingerprints() {
		if fingerprint == s.counters.RolloverConflict.From {
			return true
		}
	}
	return false
}

// consentRefusal is the code that refuses a request outright: the policy can't be
// read or says off, or the host is paused.
func (s *updateStep) consentRefusal() (code, detail string) {
	var refusal *UpdateRefusal
	switch {
	case s.policyErr != nil && errors.As(s.policyErr, &refusal):
		return refusal.Code, refusal.Detail
	case s.policyErr != nil:
		return "UPDATES_OFF", "the host's update policy can't be read, so this host takes no update: " + s.policyErr.Error()
	case s.policy.Consent == UpdateConsentOff:
		return "UPDATES_OFF", "updates are off on this host"
	case s.policy.Paused:
		return "UPDATES_PAUSED", "updates are paused on this host: run `sudo vectory update resume` to take them again"
	}
	return "", ""
}

// pauseWait says whether `vectory pause` makes the request wait. A pause is not a
// decision about a release, so the request waits and is never refused: it stays as
// the agent wrote it, and nothing on the host changes until the host is resumed. A
// person at the keyboard is the consent itself, so apply ignores it.
func (s *updateStep) pauseWait() (detail string, waiting bool) {
	if s.mode == stepApply || !s.localPauseHolds() {
		return "", false
	}
	return "a staged update waits while `vectory pause` holds this host: run `" + AdminCommandFor(s.stateDir, "vectory resume") + "` to take updates again", true
}

// consentWait says whether the host's consent makes the request wait: an ask host
// waits for a person to run `vectory update apply`, and an automatic host with
// windows waits for one to open. A person at the keyboard is the consent itself, so
// apply waits for nothing.
func (s *updateStep) consentWait() (code, detail string, waiting bool) {
	if s.mode == stepApply {
		return "", "", false
	}
	switch s.policy.Consent {
	case UpdateConsentAsk:
		return "", "a staged update waits for someone to run `sudo vectory update apply`", true
	case UpdateConsentAuto:
		windows, err := s.policy.ParsedWindows()
		if err != nil {
			return "UPDATES_OFF", "the host's update windows can't be read: " + err.Error(), false
		}
		if len(windows) > 0 && !windows.OpenAt(s.clock.Now()) {
			return "", "a staged update waits for the update window to open", true
		}
	}
	return "", "", false
}

// localPauseHolds says whether `vectory pause` is in force: the marker it leaves in
// the agent's state directory is there. That directory is the service account's, so
// the marker is looked for the way the step opens every other file from that tree,
// through a walk that follows no link at any depth and waits for no writer, and what
// is found is never read: that it is there is all it says. Anything but "it isn't
// there" counts as a pause, as the agent's own check does, so a marker that is a
// directory, a link or a file the step can't open holds the host. The marker is
// advice and not authority: the service account can set it, and all that gains it
// is a delay of its own updates.
func (s *updateStep) localPauseHolds() bool {
	file, err := openPlainFile(filepath.Join(s.stateDir, localPauseMarker))
	if err == nil {
		_ = file.Close()
		return true
	}
	return !errors.Is(err, fs.ErrNotExist)
}

// finishWithout ends a request that never started: nothing but status.json
// changes.
func (s *updateStep) finishWithout(release, code, detail string) error {
	from := s.installed.Version
	if !s.haveInstalled {
		from = "unknown"
	}
	s.logf("refusing %s: %s: %s", shortFingerprint(release), code, detail)
	s.recordResult(release, outcomeOf(code, true), code, from, "", nil)
	return s.writeStatus(nil)
}
