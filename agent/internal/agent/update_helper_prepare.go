package agent

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"runtime"
)

// Preparing: from the moment the step accepts a request to the moment it stops the
// service. Nothing here changes anything outside the step's own directories except
// one temporary file beside the executable, which the journal names before it is
// created, and which any run that finds the journal in this stage removes.

// stepFailure is why a request ended before anything was replaced: the step
// removes what it made for the request, forgets the journal, and records the code
// as the result.
type stepFailure struct{ code, detail string }

func (f *stepFailure) Error() string { return f.code + ": " + f.detail }

func failure(code, format string, args ...any) *stepFailure {
	return &stepFailure{code: code, detail: fmt.Sprintf(format, args...)}
}

// errOfferWithdrawn says the agent took away what it staged while the step read
// it: nothing is wrong, and nothing is recorded.
var errOfferWithdrawn = errors.New("the agent withdrew the offer while the step was reading it")

// prepare accepts a request that the host's consent allows. It returns when the
// request has ended, or the swap has been made and the trial is over.
func (s *updateStep) prepare(ctx context.Context, request UpdateRequest) error {
	j := updateJournal{Stage: UpdateStagePreparing, Release: request.ManifestSHA256, Signers: []string{}, StartedAt: s.now()}
	if err := writeUpdateJournal(s.private, j); err != nil {
		return err
	}
	s.journal, s.haveJournal = j, true
	faultPoint("accepted")
	s.say("Checking the staged update")
	s.status(&j)

	err := s.prepareUntilSwap(ctx, &j, request)
	var failed *stepFailure
	switch {
	case err == nil:
		return s.stopAndSwap(ctx, &j)
	case errors.Is(err, errOfferWithdrawn):
		// Nothing is wrong, and nothing is answered: the agent took the offer back
		// (or never staged what the request names), and says so itself.
		s.logf("%v", err)
		s.cleanUp(&j)
		if err := s.dropJournal(); err != nil {
			return err
		}
		return s.writeStatus(nil)
	case errors.As(err, &failed):
		return s.abort(&j, failed.code, failed.detail)
	case isDiskFull(err):
		return s.abort(&j, "DISK_FULL", err.Error())
	case errors.Is(err, errUpdateReadOnly):
		return s.abort(&j, "READ_ONLY", err.Error())
	}
	// Anything else leaves the journal as it is: the next run, which finds it in
	// preparing, removes what this one made and records the interruption.
	return err
}

// prepareUntilSwap takes a request as far as the build staged beside the
// executable and the journal saying swapping, with the counter floors raised and
// synced. It stops at the first failure.
func (s *updateStep) prepareUntilSwap(ctx context.Context, j *updateJournal, request UpdateRequest) error {
	if err := s.freshStaging(); err != nil {
		return err
	}
	running, err := s.runningBuild(ctx)
	if err != nil {
		return err
	}
	faultPoint("identified")
	incoming, err := s.exchange.IncomingDir(request.ManifestSHA256)
	if err != nil {
		return failure("MANIFEST_INVALID", "%v", err)
	}

	// Copy: the small files first, and only then, once the manifest has verified,
	// the build. A build that no pinned key signed is never copied, and everything
	// that is verified from here on is a copy that only root can touch.
	copied, err := s.copyFile(s.exchange.Dir, UpdateRequestFile, MaxUpdateFile, "MANIFEST_INVALID")
	if err != nil {
		return err
	}
	if again, err := ParseUpdateRequest(copied); err != nil || again.ManifestSHA256 != request.ManifestSHA256 || again.ArtifactSHA256 != request.ArtifactSHA256 {
		return errOfferWithdrawn
	}
	manifest, err := s.copyFile(incoming, UpdateReleaseFile, MaxReleaseManifest, "MANIFEST_INVALID")
	if err != nil {
		return err
	}
	signatures, err := s.copyFile(incoming, UpdateSignaturesFile, MaxReleaseSignatures, "SIGNATURE_INVALID")
	if err != nil {
		return err
	}
	rolloverBytes, err := s.copyFile(incoming, UpdateRolloversFile, MaxUpdateRollovers, "MANIFEST_INVALID")
	if err != nil {
		return err
	}
	faultPoint("copied")
	if digest := Digest(manifest); digest != request.ManifestSHA256 {
		return failure("MANIFEST_INVALID", "the staged release.json is %s, and the request names %s", shortFingerprint(digest), shortFingerprint(request.ManifestSHA256))
	}
	envelopes, err := ParseUpdateRollovers(rolloverBytes)
	if err != nil {
		return failure("MANIFEST_INVALID", "%v", err)
	}

	verified, err := s.verifyOffer(manifest, signatures, envelopes, running)
	if err != nil {
		return err
	}
	artifact := verified.Artifact
	if request.ArtifactSHA256 != artifact.SHA256 {
		return failure("ARTIFACT_MISMATCH", "the request names the build %s, and the signed release names %s for this platform", shortFingerprint(request.ArtifactSHA256), shortFingerprint(artifact.SHA256))
	}
	faultPoint("verified")

	j.Counter = verified.Manifest.Counter
	j.From = &updateBuild{Version: running.Version, SHA256: running.SHA256}
	j.To = &updateBuild{Version: verified.Manifest.Version, SHA256: artifact.SHA256}
	j.Signers = fingerprintsOf(verified.Signers)

	// The build: the size it has now must be the signed one before a byte is read,
	// and the copy must hash to the signed digest.
	if err := s.checkRoom(artifact.Size); err != nil {
		return err
	}
	build := UpdateBuildFile(runtime.GOOS)
	file, err := s.openServiceFile(incoming, build, MaxAgentBuild, "ARTIFACT_MISMATCH")
	if err != nil {
		return err
	}
	if file.Size != artifact.Size {
		file.File.Close()
		return failure("ARTIFACT_MISMATCH", "the staged build is %d bytes, and the signed release says %d", file.Size, artifact.Size)
	}
	digest, err := s.host.CopyInto(s.staging, build, rootPrivate, file.File, file.Size)
	file.File.Close()
	if err != nil {
		return s.copyError(err)
	}
	if digest != artifact.SHA256 {
		return failure("ARTIFACT_MISMATCH", "the staged build is %s, and the signed release says %s", shortFingerprint(digest), shortFingerprint(artifact.SHA256))
	}
	faultPoint("built")

	if err := s.probeBuild(ctx, build, artifact, verified.Manifest.Version); err != nil {
		return err
	}
	faultPoint("probed")

	// Stage beside the executable. The journal names the temporary file before it
	// exists, so that a run that finds the journal here can remove it.
	j.Swap = &updateSwap{Style: s.install.Style(), Staged: fmt.Sprintf("%s%d", updateStagedPrefix, j.Counter), Previous: updatePreviousName}
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("named")
	s.say("Staging the new build beside the executable")
	source, err := s.staging.OpenAt(build)
	if err != nil {
		return err
	}
	staged, err := s.install.Stage(j.Swap.Staged, source, artifact.Size)
	source.Close()
	if err != nil {
		return s.copyError(err)
	}
	if staged != artifact.SHA256 {
		return failure("ARTIFACT_MISMATCH", "the build written beside the executable is %s, and the signed release says %s", shortFingerprint(staged), shortFingerprint(artifact.SHA256))
	}
	faultPoint("staged")

	// What the trial compares the new build's check-in with: the process that is
	// running now, and whether it has Vector running.
	j.BootIDBefore, _ = s.snapshotHealth(j.From.SHA256)
	faultPoint("snapshot")

	// The policy once more, and the offer under it: nothing after this point can be
	// undone but by a rollback.
	if verified, err = s.recheckPolicy(manifest, signatures, envelopes, running); err != nil {
		return err
	}
	j.Signers = fingerprintsOf(verified.Signers)

	// The floors, then the journal. Both are on disk before anything stops, and the
	// floors first: from the moment the journal says swapping, this release has been
	// attempted and can never be tried again on this host. The floors only go up: what
	// is on disk is raised to what the library says a host holds after the release
	// (the signers' floors at the release's counter), and a key the release's
	// statements replace keeps its floor beside its successor's, because the host
	// still pins it until the build has proven itself.
	s.counters.HighestCounters = raiseFloors(s.counters.HighestCounters, verified.Floors, append(s.policy.Fingerprints(), fingerprintsOf(verified.Pins)...))
	if err := writeUpdateCounters(s.private, s.counters); err != nil {
		return err
	}
	faultPoint("floor_raised")
	j.Stage = UpdateStageSwapping
	if err := writeUpdateJournal(s.private, *j); err != nil {
		return err
	}
	s.journal = *j
	faultPoint("swapping")
	s.status(j)
	return nil
}

// verifyOffer decides the offer with the one function every host uses, from the
// step's copies, the pins and the track in the policy as it is now, the floors on
// disk and the step's last result. A fork is recorded, synced, so that every later
// request is refused until the host is pinned again.
func (s *updateStep) verifyOffer(manifest, signatures []byte, envelopes []RolloverEnvelope, running updateBuild) (Verified, error) {
	verified, err := VerifyRelease(VerifyInput{
		Manifest: manifest, Signatures: signatures, Rollovers: envelopes,
		Pins: s.policy.PinnedKeys(), Floors: s.counters.HighestCounters, Now: s.now(), Last: s.lastForVerification(),
		RunningVersion: running.Version, OS: runtime.GOOS, Arch: runtime.GOARCH, Track: s.policy.Track, ServiceDefinition: updateServiceDefinition,
	})
	if err == nil {
		return verified, nil
	}
	var refusal *UpdateRefusal
	if !errors.As(err, &refusal) {
		return Verified{}, err
	}
	if refusal.Code == "KEY_ROLLOVER_CONFLICT" {
		if err := s.recordConflict(refusal); err != nil {
			return Verified{}, err
		}
	}
	return Verified{}, failure(refusal.Code, "%s", refusal.Detail)
}

// recheckPolicy reads the policy again, right before the step commits to the swap:
// a person who paused updates, turned them off or pinned the host to other keys
// while the step was copying and probing is not overtaken. The offer is decided
// again under what the policy says now.
func (s *updateStep) recheckPolicy(manifest, signatures []byte, envelopes []RolloverEnvelope, running updateBuild) (Verified, error) {
	s.policy, _, s.policyErr = readUpdatePolicy(s.paths)
	if code, detail := s.consentRefusal(); code != "" {
		return Verified{}, failure(code, "%s", detail)
	}
	return s.verifyOffer(manifest, signatures, envelopes, running)
}

// freshStaging empties the step's scratch directories: what is in them belongs to
// no request.
func (s *updateStep) freshStaging() error {
	if err := s.host.EmptyDir(s.staging); err != nil {
		return err
	}
	return s.host.RemoveFrom(s.probeDir, UpdateBuildFile(runtime.GOOS))
}

// lastForVerification is the step's last result as VerifyRelease takes it.
func (s *updateStep) lastForVerification() *ReleaseResult {
	if s.last == nil {
		return nil
	}
	result := s.last.ReleaseResult()
	return &result
}

// recordConflict writes the fork the verification found, synced, so that every
// later request is refused until the host is pinned again.
func (s *updateStep) recordConflict(refusal *UpdateRefusal) error {
	if len(refusal.Successors) != 2 {
		return nil
	}
	s.counters.RolloverConflict = &RolloverConflict{From: refusal.From, To: [2]string{refusal.Successors[0], refusal.Successors[1]}}
	return writeUpdateCounters(s.private, s.counters)
}

// runningBuild is the build that is installed now: its digest from the file
// through the held handle, and its version from the record the step keeps for that
// digest. A file the step has no record of is asked, as the service account, for
// its version. When the step did have a record, of another file, the executable
// was replaced outside the step: the step takes the new file as the running build
// from now on and ends the request with BINARY_CHANGED.
func (s *updateStep) runningBuild(ctx context.Context) (updateBuild, error) {
	name := s.install.Name()
	digest, present, err := s.install.Digest(name)
	if err != nil {
		return updateBuild{}, err
	}
	if !present {
		return updateBuild{}, failure("NO_SERVICE", "the agent's executable %s isn't there", s.install.Path())
	}
	if s.haveInstalled && s.installed.SHA256 == digest {
		return updateBuild{Version: s.installed.Version, SHA256: digest}, nil
	}
	changed := s.haveInstalled
	build := updateBuild{Version: "unknown", SHA256: digest}
	if version, err := s.versionOfInstalled(ctx); err != nil {
		s.logf("couldn't ask %s its version: %v", s.install.Path(), err)
	} else {
		build.Version = version
		s.installed = updateInstalled{Version: version, SHA256: digest, RecordedAt: s.now()}
		if err := writeUpdateInstalled(s.private, s.installed); err != nil {
			return updateBuild{}, err
		}
	}
	s.haveInstalled = build.Version != "unknown"
	if changed {
		return build, failure("BINARY_CHANGED", "the executable at %s isn't the build the step installed or recorded: it was replaced outside the step. It is taken as the running build from now on, and this request is dropped", s.install.Path())
	}
	return build, nil
}

// versionOfInstalled runs the installed executable as the service account and
// reads the version it prints. The file and every directory above it belong to
// root and were checked through handles, so running it where it is trusts nothing
// the service account can change.
func (s *updateStep) versionOfInstalled(ctx context.Context) (string, error) {
	output, err := s.host.RunProbe(ctx, s.install.Path(), s.service.Account)
	if err != nil {
		return "", err
	}
	return probeVersionOf(output)
}

// openServiceFile opens one of the agent's files in dir, mapping what the open
// says to what the step records: a link, a named pipe or a file that isn't the
// service account's is refused as UNTRUSTED_LOCATION, a file too large is
// tooLarge, and a file that isn't there means the agent took the offer back.
func (s *updateStep) openServiceFile(dir, name string, limit int64, tooLarge string) (*updateServiceFile, error) {
	file, err := s.host.OpenServiceFile(dir, name, s.service.Account, limit)
	if err == nil {
		return file, nil
	}
	var refusal *UpdateRefusal
	switch {
	case errors.Is(err, errServiceFileTooLarge):
		return nil, failure(tooLarge, "%v", err)
	case errors.As(err, &refusal):
		return nil, failure(refusal.Code, "%s", refusal.Detail)
	case errors.Is(err, fs.ErrNotExist):
		return nil, errOfferWithdrawn
	}
	return nil, err
}

// copyFile copies one of the agent's small files into the step's staging
// directory and returns the bytes of the copy, which is what the step reads from
// here on.
func (s *updateStep) copyFile(dir, name string, limit int64, tooLarge string) ([]byte, error) {
	file, err := s.openServiceFile(dir, name, limit, tooLarge)
	if err != nil {
		return nil, err
	}
	_, err = s.host.CopyInto(s.staging, name, rootPrivate, file.File, file.Size)
	file.File.Close()
	if err != nil {
		return nil, s.copyError(err)
	}
	return s.staging.ReadFileAt(name, limit)
}

// copyError maps a failure to write the step's own files: a full disk is the code
// DISK_FULL, and a file that grew or shrank while it was read is a file that
// isn't the one the agent wrote.
func (s *updateStep) copyError(err error) error {
	switch {
	case isDiskFull(err):
		return failure("DISK_FULL", "%v", err)
	case errors.Is(err, errUpdateReadOnly):
		return failure("READ_ONLY", "%v", err)
	}
	return err
}

// checkRoom refuses an update when either file system can't take two copies of the
// build: the install directory's (the staged file beside the executable) and the
// step's own (the copy the step verifies, and the probe's).
func (s *updateStep) checkRoom(size int64) error {
	need := uint64(size) * 2
	free, err := s.install.FreeSpace()
	if err != nil {
		return err
	}
	if free < need {
		return failure("DISK_FULL", "the file system that holds %s has %d bytes free, and an update needs room for two copies of the build (%d)", s.install.Path(), free, need)
	}
	if free, err = s.host.FreeSpace(s.private); err != nil {
		return err
	}
	if free < need {
		return failure("DISK_FULL", "the file system that holds %s has %d bytes free, and an update needs room for two copies of the build (%d)", s.paths.StepDir, free, need)
	}
	return nil
}

// probeBuild copies the verified build into the probe directory, checks the copy's
// digest there, runs it as the service account and checks what it says, and
// removes the copy. A build that doesn't pass is PROBE_FAILED and nothing else
// happens.
func (s *updateStep) probeBuild(ctx context.Context, build string, artifact ReleaseArtifact, version string) error {
	source, err := s.staging.OpenAt(build)
	if err != nil {
		return err
	}
	_ = s.host.RemoveFrom(s.probeDir, build)
	digest, err := s.host.CopyInto(s.probeDir, build, rootExecutable, source, artifact.Size)
	source.Close()
	if err != nil {
		return s.copyError(err)
	}
	defer func() { _ = s.host.RemoveFrom(s.probeDir, build) }()
	if digest != artifact.SHA256 {
		return failure("PROBE_FAILED", "the copy in the probe directory is %s, and the signed release says %s", shortFingerprint(digest), shortFingerprint(artifact.SHA256))
	}
	faultPoint("probe:copied")
	s.say("Running the new build to see what it says")
	output, err := s.host.RunProbe(ctx, filepath.Join(s.paths.Probe, build), s.service.Account)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return failure("PROBE_FAILED", "%v", err)
	}
	if refusal := checkProbeOutput(output, version); refusal != nil {
		return failure(refusal.Code, "%s", refusal.Detail)
	}
	return nil
}

// snapshotHealth keeps a copy of the health record the agent that is running now
// last wrote, in the staging directory, and returns the boot_id and the state of
// Vector in it. The trial compares the new build's check-in with them, and a run
// that continues a trial after a crash needs them again: the record itself is the
// new build's by then. A record that isn't the running build's is not believed.
func (s *updateStep) snapshotHealth(runningDigest string) (bootID, vector string) {
	file, err := s.host.OpenServiceFile(s.exchange.Dir, UpdateHealthFile, s.service.Account, MaxUpdateFile)
	if err != nil {
		return "", ""
	}
	_, err = s.host.CopyInto(s.staging, updateHealthBeforeFile, rootPrivate, file.File, file.Size)
	file.File.Close()
	if err != nil {
		return "", ""
	}
	health, ok := s.healthBefore()
	if !ok || health.AgentSHA256 != runningDigest {
		_ = s.host.RemoveFrom(s.staging, updateHealthBeforeFile)
		return "", ""
	}
	return health.BootID, health.Vector
}

// healthBefore reads the snapshot taken before the swap.
func (s *updateStep) healthBefore() (UpdateHealth, bool) {
	data, found, err := readStepFile(s.staging, updateHealthBeforeFile, MaxUpdateFile)
	if err != nil || !found {
		return UpdateHealth{}, false
	}
	health, err := ParseUpdateHealth(data)
	return health, err == nil
}

// status writes status.json and says so when it can't: during an update a status
// that can't be written is not a reason to stop.
func (s *updateStep) status(j *updateJournal) {
	if err := s.writeStatus(j); err != nil {
		s.logf("%v", err)
	}
}

// cleanUp removes what a request that didn't get as far as the swap left: the
// temporary file beside the executable, the probe's copy and the staging
// directory's files.
func (s *updateStep) cleanUp(j *updateJournal) {
	if j != nil && j.Swap != nil && s.install != nil {
		for _, name := range []string{j.Swap.Staged, j.Swap.Previous + ".new"} {
			if err := s.install.Remove(name); err != nil {
				s.logf("couldn't remove %s: %v", name, err)
			}
		}
	}
	if err := s.host.RemoveFrom(s.probeDir, UpdateBuildFile(runtime.GOOS)); err != nil {
		s.logf("couldn't remove the probe's copy: %v", err)
	}
	if err := s.host.EmptyDir(s.staging); err != nil {
		s.logf("couldn't empty the staging directory: %v", err)
	}
}

// dropJournal removes the journal: the step is idle again.
func (s *updateStep) dropJournal() error {
	if err := s.host.RemoveFrom(s.private, updateJournalFile); err != nil {
		return err
	}
	s.journal, s.haveJournal = updateJournal{}, false
	return nil
}

// abort ends a request that failed before the service stopped: what the step made
// for it goes, then the journal, then the result is recorded. The order matters:
// a crash before the journal goes finds a journal in preparing and records an
// interruption, and a crash after it leaves a step with no journal and no result,
// which answers the request again from the start.
func (s *updateStep) abort(j *updateJournal, code, detail string) error {
	s.logf("%s: %s", code, detail)
	if j.Swap != nil && s.install == nil {
		// The journal names a temporary file beside the executable, and without the
		// install directory the step can't see whether it is there: the journal stays
		// until a run that can.
		return errors.New("the install directory can't be opened, so the files of the request can't be removed: " + s.eligibility)
	}
	s.cleanUp(j)
	if err := s.dropJournal(); err != nil {
		return err
	}
	faultPoint("abort:dropped")
	from, to := "unknown", ""
	switch {
	case j.From != nil:
		from = j.From.Version
	case s.haveInstalled:
		from = s.installed.Version
	}
	if j.To != nil {
		to = j.To.Version
	}
	s.recordResult(j.Release, outcomeOf(code, true), code, from, to, nil)
	return s.writeStatus(nil)
}
