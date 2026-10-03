package agent

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"runtime"
	"time"
)

// Swapping, the trial, the commit and the rollback, and what a run does when it
// finds the journal in one of those stages: continue, or take the new build back.

// ---------------------------------------------------------------- swapping

// stopAndSwap stops the agent's service, checks that the executable is still the
// build the step recorded, replaces it, and goes on to the trial. The journal
// already says swapping and the floors are already on disk. A swap that fails, or a
// step that finds something else installed, is settled like a crash would be:
// by looking at what is installed.
func (s *updateStep) stopAndSwap(ctx context.Context, j *updateJournal) error {
	s.say("Stopping the agent service")
	if err := s.host.StopService(ctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.logf("couldn't stop the service: %v", err)
		return s.settleSwap(ctx, j, "INTERRUPTED")
	}
	faultPoint("stopped")
	digest, present, err := s.install.Digest(s.install.Name())
	if err == nil && present && digest == j.From.SHA256 {
		s.say("Replacing the executable")
		if err := s.install.Swap(j.Swap.Staged, j.Swap.Previous); err != nil {
			s.logf("the swap failed: %v", err)
			cause := "INTERRUPTED"
			if errors.Is(err, errUpdateReadOnly) {
				cause = "READ_ONLY"
			}
			return s.settleSwap(ctx, j, cause)
		}
		faultPoint("swapped")
	}
	return s.settleSwap(ctx, j, "INTERRUPTED")
}

// settleSwap is what the step does with a journal in swapping, whether it just
// made the swap or found the journal after a crash: it reads which build is
// installed, through the handle, and goes on from there.
//
//	the new build        the swap happened: the trial begins
//	the previous build   nothing was replaced: the temporary file goes, the
//	                     service is started again, and the request ends with cause
//	no file              (where a swap takes two renames) the previous build is put back
//	any other file       someone replaced the executable: it is left alone and taken
//	                     as the running build, and the request ends with BINARY_CHANGED
//
// The floor was raised before the service stopped, so none of these lets the
// release be tried again.
func (s *updateStep) settleSwap(ctx context.Context, j *updateJournal, cause string) error {
	if s.install == nil {
		return errors.New("the install directory can't be opened, so the update can't be settled: " + s.eligibility)
	}
	digest, present, err := s.install.Digest(s.install.Name())
	if err != nil {
		return err
	}
	if !present {
		previous, kept, err := s.install.Digest(j.Swap.Previous)
		if err != nil {
			return err
		}
		if !kept || previous != j.From.SHA256 {
			return s.binaryChanged(ctx, j, "the executable is missing and the previous build isn't beside it")
		}
		if err := s.install.Restore(j.Swap.Previous); err != nil {
			return err
		}
		digest, present = previous, true
	}
	switch {
	case present && digest == j.To.SHA256:
		return s.trial(ctx, j)
	case present && digest == j.From.SHA256:
		s.say("The update was interrupted before the executable changed; starting the agent again")
		if err := s.startService(ctx); err != nil {
			return err
		}
		return s.abort(j, cause, "the step stopped before it replaced the executable")
	}
	return s.binaryChanged(ctx, j, "the executable is neither the build the step installed nor the one it staged")
}

// binaryChanged ends a request because the executable was replaced outside the
// step: the file is left alone, the step records it as the running build, the
// service is started, and the request is dropped.
func (s *updateStep) binaryChanged(ctx context.Context, j *updateJournal, why string) error {
	s.logf("%s", why)
	if digest, present, err := s.install.Digest(s.install.Name()); err == nil && present {
		if version, err := s.versionOfInstalled(ctx); err == nil {
			s.installed = updateInstalled{Version: version, SHA256: digest, RecordedAt: s.now()}
			if err := writeUpdateInstalled(s.private, s.installed); err != nil {
				return err
			}
			s.haveInstalled = true
		}
	}
	if err := s.startService(ctx); err != nil {
		return err
	}
	return s.abort(j, "BINARY_CHANGED", why+": it is left as it is and taken as the running build")
}

func (s *updateStep) startService(ctx context.Context) error {
	if err := s.host.StartService(ctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("couldn't start the agent service: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------- resuming

// resume continues a request an earlier run left in the journal: a crash, a power
// loss or a stop that came at a boundary.
func (s *updateStep) resume(ctx context.Context) error {
	j := s.journal
	s.logf("continuing an update that was interrupted in %s", j.Stage)
	switch j.Stage {
	case UpdateStagePreparing:
		// Nothing but the step's own files and a temporary file beside the
		// executable has changed.
		return s.abort(&j, "INTERRUPTED", "the step was interrupted before it stopped the service")
	case UpdateStageSwapping:
		return s.settleSwap(ctx, &j, "INTERRUPTED")
	case UpdateStageTrial:
		return s.resumeTrial(ctx, &j)
	}
	return s.continueRollback(ctx, &j)
}

// ---------------------------------------------------------------- the trial

// trial starts the new build and watches it for five minutes.
func (s *updateStep) trial(ctx context.Context, j *updateJournal) error {
	j.Stage = UpdateStageTrial
	j.Deadline = s.now().Add(updateTrialDuration)
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("trial")
	s.status(j)
	return s.runTrial(ctx, j, true)
}

// resumeTrial continues a trial the step was interrupted in, with a fresh
// deadline, once. A trial that was already interrupted once is over: the new build
// is taken back.
func (s *updateStep) resumeTrial(ctx context.Context, j *updateJournal) error {
	if s.install == nil {
		return errors.New("the install directory can't be opened, so the trial can't continue: " + s.eligibility)
	}
	digest, present, err := s.install.Digest(s.install.Name())
	if err != nil {
		return err
	}
	if !present || digest != j.To.SHA256 {
		return s.binaryChanged(ctx, j, "the executable isn't the build under trial")
	}
	if j.Interruptions >= 1 {
		return s.rollBack(ctx, j, "INTERRUPTED")
	}
	j.Interruptions = 1
	j.Deadline = s.now().Add(updateTrialDuration)
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("trial:resumed")
	s.status(j)
	return s.runTrial(ctx, j, false)
}

// runTrial starts the service and watches the new build until it is healthy, its
// service fails or the deadline passes.
func (s *updateStep) runTrial(ctx context.Context, j *updateJournal, fresh bool) error {
	s.say("Starting the new build and waiting for it to check in")
	started := s.clock.Now()
	if err := s.host.StartService(ctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.logf("the new build's service didn't start: %v", err)
		return s.rollBack(ctx, j, "START_FAILED")
	}
	faultPoint("started")
	before, _ := s.healthBefore()
	outcome, err := s.watch(ctx, j, watchSpec{
		build: *j.To, notBoot: j.BootIDBefore, since: started, deadline: j.Deadline,
		vectorRunning: before.Vector == UpdateVectorRunning, measureFrom: started, measure: fresh,
	})
	if err != nil {
		return err
	}
	if outcome.healthy {
		faultPoint("healthy")
		return s.commit(ctx, j, outcome.firstCheckInMS)
	}
	return s.rollBack(ctx, j, outcome.code)
}

// watchSpec says what a healthy build is.
type watchSpec struct {
	// build is the build that must report: its SHA-256 and version.
	build updateBuild
	// notBoot is a process identity the build must not report: the process that
	// ran before it.
	notBoot string
	// since is the time a check-in must be at or after to count, and deadline the
	// end of the watch.
	since, deadline time.Time
	// vectorRunning requires the build to report Vector running, because it was
	// running under the build before.
	vectorRunning bool
	// measure asks for first_check_in_ms, measured from measureFrom.
	measure     bool
	measureFrom time.Time
}

// watchOutcome is how a watch ended: healthy, or the code of the rollback it asks
// for.
type watchOutcome struct {
	healthy        bool
	code           string
	firstCheckInMS *uint32
}

// watch looks every two seconds, until the build is healthy or the deadline.
//
// Healthy is all of: the service manager reports the service running with no
// restart since the watch began, and the health record the agent writes after each
// check-in names this build's SHA-256 and version, a boot_id other than the
// previous process's, a check-in at or after the start and no more than half a
// minute ahead of the clock, and a file written at or after the start; and, if
// Vector was running under the previous build, this one reports it running. A
// service the manager reports failed, or restarted three times, ends the watch at
// once with START_FAILED. At the deadline, a build that never checked in is
// NO_CHECK_IN, and one that did but isn't healthy is UNHEALTHY.
//
// The health record is a file the service account writes: it can't prove the
// build is healthy to anyone but the step, and a service account that forges it can
// keep a build that was signed and doesn't work, which is a denial of service to
// itself. It never makes the step install or keep anything unsigned.
func (s *updateStep) watch(ctx context.Context, j *updateJournal, spec watchSpec) (watchOutcome, error) {
	baseline := -1
	var firstCheckIn time.Time
	refreshed := s.clock.Now()
	for {
		state, stateErr := s.host.ServiceState(ctx)
		if ctx.Err() != nil {
			return watchOutcome{}, ctx.Err()
		}
		restarts := 0
		if stateErr == nil {
			if baseline < 0 {
				baseline = state.Restarts
			}
			restarts = state.Restarts - baseline
			if state.failed() || state.State == "inactive" || restarts >= updateRestartLimit {
				return watchOutcome{code: "START_FAILED"}, nil
			}
		}
		now := s.clock.Now()
		if health, written, err := s.readHealth(); err == nil {
			if reported, healthy := judgeHealth(health, written, spec, now); reported {
				if firstCheckIn.IsZero() {
					firstCheckIn = health.CheckedInAt
				}
				if healthy && stateErr == nil && state.running() && restarts == 0 {
					return watchOutcome{healthy: true, firstCheckInMS: firstCheckInMillis(spec, firstCheckIn)}, nil
				}
			}
		}
		if !now.Before(spec.deadline) {
			if firstCheckIn.IsZero() {
				return watchOutcome{code: "NO_CHECK_IN"}, nil
			}
			return watchOutcome{code: "UNHEALTHY"}, nil
		}
		if now.Sub(refreshed) >= updateStatusRefresh {
			s.status(j)
			refreshed = now
		}
		if err := s.clock.Sleep(ctx, updatePollInterval); err != nil {
			return watchOutcome{}, err
		}
	}
}

// judgeHealth says whether a health record is a check-in of the build under watch
// (reported), and whether it also shows the build healthy.
func judgeHealth(health UpdateHealth, written time.Time, spec watchSpec, now time.Time) (reported, healthy bool) {
	reported = health.AgentSHA256 == spec.build.SHA256 && health.AgentVersion == spec.build.Version &&
		(spec.notBoot == "" || health.BootID != spec.notBoot) &&
		!health.CheckedInAt.Before(spec.since) && !written.Before(spec.since) &&
		!health.CheckedInAt.After(now.Add(updateFutureSkew)) && !written.After(now.Add(updateFutureSkew))
	healthy = reported && (!spec.vectorRunning || health.Vector == UpdateVectorRunning)
	return reported, healthy
}

// firstCheckInMillis is how long after the service started the first check-in of
// the build was answered, when the watch measured it.
func firstCheckInMillis(spec watchSpec, firstCheckIn time.Time) *uint32 {
	if !spec.measure || firstCheckIn.IsZero() {
		return nil
	}
	elapsed := firstCheckIn.Sub(spec.measureFrom).Milliseconds()
	elapsed = max(0, min(elapsed, maxFirstCheckInMS))
	value := uint32(elapsed)
	return &value
}

// readHealth reads health.json, which the service account writes: through the
// handle, as a regular file of that account within its bound, strictly.
func (s *updateStep) readHealth() (UpdateHealth, time.Time, error) {
	file, err := s.host.OpenServiceFile(s.exchange.Dir, UpdateHealthFile, s.service.Account, MaxUpdateFile)
	if err != nil {
		return UpdateHealth{}, time.Time{}, err
	}
	defer file.File.Close()
	data, err := readBounded(file.File, file.Size)
	if err != nil {
		return UpdateHealth{}, time.Time{}, err
	}
	health, err := ParseUpdateHealth(data)
	return health, file.ModTime, err
}

// ---------------------------------------------------------------- commit

// commit ends a trial that passed. The journal says so first, and everything after
// it can be done again by a later run: the journal and the files in the staging
// directory are what tell a run that the end of the commit is still to do.
func (s *updateStep) commit(ctx context.Context, j *updateJournal, firstCheckInMS *uint32) error {
	j.Stage = updateJournalCommitted
	j.Code = ""
	j.FinishedAt = s.now()
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("committed")
	s.say("The new build is healthy")
	return s.finishCommit(ctx, j, firstCheckInMS)
}

// finishCommit does what a commit leaves to do, each part safe to do again:
//
//  1. the build's copy in the staging directory goes (it is the largest file, and
//     the next part may need its room);
//  2. installed.json records the build;
//  3. the pins take what a rollover statement in the offer says, and the floors
//     follow them;
//  4. status.json says the update committed;
//  5. the helper copy becomes the new build: written beside the old copy and
//     renamed over it, so that the old copy, itself a committed build, serves until
//     then. If there is no room the files stay, and the next run tries again;
//  6. the staging directory is emptied.
func (s *updateStep) finishCommit(ctx context.Context, j *updateJournal, firstCheckInMS *uint32) error {
	_ = s.host.RemoveFrom(s.staging, UpdateBuildFile(runtime.GOOS))
	s.installed = updateInstalled{Version: j.To.Version, SHA256: j.To.SHA256, Release: j.Release, RecordedAt: j.FinishedAt}
	s.haveInstalled = true
	if err := writeUpdateInstalled(s.private, s.installed); err != nil {
		return err
	}
	faultPoint("commit:installed")
	if err := s.applyPinsAndFloors(j); err != nil {
		return err
	}
	faultPoint("commit:pins")
	s.last = &UpdateLast{Release: j.Release, Outcome: UpdateOutcomeCommitted, At: j.FinishedAt, FromVersion: j.From.Version, ToVersion: j.To.Version, FirstCheckInMS: firstCheckInMS}
	if err := s.writeStatus(nil); err != nil {
		return err
	}
	faultPoint("commit:status")
	if err := s.placeNewHelper(j.To.SHA256); err != nil {
		s.logf("the helper copy stays the earlier build for now: %v", err)
		return nil
	}
	faultPoint("commit:helper")
	if err := s.host.EmptyDir(s.staging); err != nil {
		s.logf("couldn't empty the staging directory: %v", err)
	}
	faultPoint("commit:cleaned")
	return nil
}

// errNoPinChange says an edit of the policy found nothing to change.
var errNoPinChange = errors.New("the policy already pins what the release's statements lead to")

// applyPinsAndFloors does what the release's rollover statements say, now that the
// build has committed. The pins are edited and never written over: against the
// policy as it is on disk at that moment, each statement whose from key is pinned
// there puts its successor in that key's place, and every other pin, and the
// consent, track, windows and pause a person set, stay as they are. A person who
// pinned the host to other keys while the trial ran is therefore never undone. The
// floors are raised to what the release library says a host holds after the release
// and are otherwise left alone, so that the replaced key keeps its floor beside its
// successor's. A release signed by a key the host pinned directly has no statement
// to follow.
func (s *updateStep) applyPinsAndFloors(j *updateJournal) error {
	manifest, found, err := readStepFile(s.staging, UpdateReleaseFile, MaxReleaseManifest)
	if err != nil || !found {
		return nil
	}
	signatures, found, err := readStepFile(s.staging, UpdateSignaturesFile, MaxReleaseSignatures)
	if err != nil || !found {
		return nil
	}
	rolloverBytes, found, err := readStepFile(s.staging, UpdateRolloversFile, MaxUpdateRollovers)
	if err != nil || !found {
		return nil
	}
	envelopes, err := ParseUpdateRollovers(rolloverBytes)
	if err != nil {
		return nil
	}
	take := func(pins []ReleaseKey) (Verified, error) {
		return VerifyReleaseFiles(VerifyInput{
			Manifest: manifest, Signatures: signatures, Rollovers: envelopes,
			Pins: pins, Floors: s.counters.HighestCounters, Now: j.StartedAt,
		})
	}
	policy, _, err := readUpdatePolicy(s.paths)
	if err != nil {
		s.logf("the pins stay as they are, because the policy can't be read: %v", err)
		return nil
	}
	taken, err := take(policy.PinnedKeys())
	if err != nil {
		s.logf("the pins stay as they are: %v", err)
		return nil
	}
	faultPoint("commit:policy_read")
	if !sameFingerprints(taken.Pins, policy.PinnedKeys()) {
		errStay := errors.New("the statements don't lead where the release library says")
		var after []ReleaseKey
		changeErr := ChangeUpdatePolicy(func(p *UpdatePolicy) error {
			// The edit is made on the pins the policy has now, which may not be the ones
			// it had a moment ago, and checked against the library's own reading of the
			// same statements before anything is written.
			again, err := take(p.PinnedKeys())
			if err != nil {
				return errStay
			}
			edited := replacePins(p.PinnedKeys(), envelopes)
			if !sameFingerprints(edited, again.Pins) {
				return errStay
			}
			if sameFingerprints(edited, p.PinnedKeys()) {
				return errNoPinChange
			}
			p.SetPinnedKeys(edited)
			after = edited
			return nil
		})
		switch {
		case changeErr == nil:
			s.logf("the host now pins %s", joinShort(fingerprintsOf(after)))
		case errors.Is(changeErr, errNoPinChange):
		default:
			s.logf("the pins stay as they are: %v", changeErr)
			return nil
		}
	}
	keep := append(policy.Fingerprints(), fingerprintsOf(taken.Pins)...)
	floors := raiseFloors(s.counters.HighestCounters, taken.Floors, keep)
	if maps.Equal(floors, s.counters.HighestCounters) {
		return nil
	}
	s.counters.HighestCounters = floors
	return writeUpdateCounters(s.private, s.counters)
}

func joinShort(fingerprints []string) string {
	out := ""
	for i, fingerprint := range fingerprints {
		if i > 0 {
			out += ", "
		}
		out += shortFingerprint(fingerprint)
	}
	return out
}

// placeNewHelper makes the helper copy the build that committed.
func (s *updateStep) placeNewHelper(digest string) error {
	if s.install == nil {
		return errors.New("the install directory isn't open")
	}
	return placeHelper(s.host, s.install, s.paths, digest)
}

// ---------------------------------------------------------------- rollback

// rollBack takes the new build back. The step that does it is the one that
// started the trial, or the helper copy that replaced it: the build that was
// installed before, which already ran and checked in on this host, and never the
// build under trial. The journal says rolling_back, with the code, first.
func (s *updateStep) rollBack(ctx context.Context, j *updateJournal, code string) error {
	s.logf("taking the new build back: %s", code)
	j.Stage = UpdateStageRollingBack
	j.Code = code
	j.Deadline = s.now().Add(updateTrialDuration)
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("rolling_back")
	s.status(j)
	return s.continueRollback(ctx, j)
}

// continueRollback stops the service, puts the previous build back after checking
// it against the journal's digest, starts the service and watches the previous build
// for the same health. Each step can be done again, so a crash anywhere in it is
// resumed. If the previous build can't be put back, or isn't healthy within five
// minutes, the step records ROLLBACK_UNHEALTHY and stops there: it leaves what is
// installed in place and never alternates between builds.
func (s *updateStep) continueRollback(ctx context.Context, j *updateJournal) error {
	if s.install == nil {
		return errors.New("the install directory can't be opened, so the rollback can't continue: " + s.eligibility)
	}
	s.say("Putting the previous build back")
	if !s.now().Before(j.Deadline) {
		j.Deadline = s.now().Add(updateTrialDuration)
		if err := writeUpdateJournal(s.private, *j); err != nil {
			return err
		}
		s.journal = *j
	}
	if err := s.host.StopService(ctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.logf("couldn't stop the service: %v", err)
	}
	faultPoint("rollback:stopped")
	digest, present, err := s.install.Digest(s.install.Name())
	if err != nil {
		return err
	}
	cause := j.Code
	switch {
	case present && digest == j.From.SHA256:
		// An earlier run put it back.
	case present && digest != j.To.SHA256:
		return s.binaryChanged(ctx, j, "the executable isn't the build under trial or the one before it")
	default:
		previous, kept, err := s.install.Digest(j.Swap.Previous)
		if err != nil {
			return err
		}
		if !kept || previous != j.From.SHA256 {
			s.logf("the previous build isn't beside the executable, so the new build stays")
			cause = "ROLLBACK_UNHEALTHY"
			if err := s.startService(ctx); err != nil {
				return err
			}
			return s.endRolledBack(j, cause)
		}
		if err := s.install.Restore(j.Swap.Previous); err != nil {
			return err
		}
	}
	faultPoint("rollback:restored")
	s.say("Starting the previous build")
	started := s.clock.Now()
	if err := s.host.StartService(ctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.logf("the previous build's service didn't start: %v", err)
		return s.endRolledBack(j, "ROLLBACK_UNHEALTHY")
	}
	faultPoint("rollback:started")
	before, _ := s.healthBefore()
	outcome, err := s.watch(ctx, j, watchSpec{
		build: *j.From, notBoot: j.BootIDBefore, since: started, deadline: j.Deadline,
		vectorRunning: before.Vector == UpdateVectorRunning,
	})
	if err != nil {
		return err
	}
	if !outcome.healthy {
		cause = "ROLLBACK_UNHEALTHY"
	}
	return s.endRolledBack(j, cause)
}

// endRolledBack ends a rollback: the journal says rolled_back with the code, then
// the end of it (the result, and the files) is done, which a later run can do again.
func (s *updateStep) endRolledBack(j *updateJournal, code string) error {
	j.Stage = updateJournalRolledBack
	j.Code = code
	j.FinishedAt = s.now()
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("rolled_back")
	s.say("The previous build is back")
	return s.finishRollback(j)
}

// finishRollback records the result of a rollback and removes the files of the
// request.
func (s *updateStep) finishRollback(j *updateJournal) error {
	s.last = &UpdateLast{Release: j.Release, Outcome: UpdateOutcomeRolledBack, Code: j.Code, At: j.FinishedAt, FromVersion: j.From.Version, ToVersion: j.To.Version}
	if err := s.writeStatus(nil); err != nil {
		return err
	}
	faultPoint("rollback:status")
	s.cleanUp(j)
	return nil
}
