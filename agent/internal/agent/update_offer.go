package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"time"
)

// What this agent does with an offer of an agent build. It is the service
// account's side of an update and never installs anything: it verifies the offer
// against the keys this host pinned, downloads the build and stages it for the
// privileged step, which verifies everything again before it changes a file.
//
// An offer is the manifest member `agent_update`, read only from a manifest that
// lists the feature. Per check-in, after the configuration has been reconciled
// (an apply finishes first, and the build waits), the agent
//
//  1. reads the host's policy. Off, or a policy it may not trust, means it reports
//     that and does nothing else: nothing is written, deleted or made, not even a
//     directory;
//  2. verifies the release (VerifyRelease) with the pins, the counter floors the
//     step attempted and the step's last result, so a release this host already
//     tried and rolled back is refused before one byte is downloaded, and checks
//     that the offer's artifact is the release's build for this platform;
//  3. asks whether this host can take it (the step's own eligibility), and
//     whether it is busy: a configuration apply in progress, a check on request,
//     a pause on the host, or the step at work, all of which defer;
//  4. downloads the build in the background, into
//     <state>/updates/incoming/<manifest sha256>/vectory.part, and renames it only
//     when its size and SHA-256 are the signed ones; then writes release.json,
//     release.json.sig and rollovers.json beside it and request.json last.
//
// An offer that is withdrawn or changed deletes what it staged, unless the step
// has started on it. Everything the agent writes here belongs to the service
// account, so the step reads it only by copying and never trusts it: the files are
// requests, never authority.

const (
	// updateReleasePath is where the server serves a release's build, followed by
	// the build's SHA-256.
	updateReleasePath = "/agent/v1/agent-releases/"
	// updateAttempts is how many transfers of one release may fail before the agent
	// reports it failed and stops trying it.
	updateAttempts = 3
	// updateGoneWait is how long the agent waits after the server stopped serving a
	// build (403 or 404) before it asks for the same one again. The server doesn't
	// charge such a request to the device's six transfers an hour, so the wait only
	// keeps a server that goes on refusing from being asked at every check-in.
	updateGoneWait = time.Minute
	// updateBusyWait is how long it waits when a server that is busy gave no
	// Retry-After.
	updateBusyWait = time.Minute
	// updateServiceGeneration is the generation of the service definition this
	// build writes and needs, which a host without the step is taken to have.
	updateServiceGeneration = 1
	// updateStopWait bounds how long the agent waits for a transfer it stopped to
	// end.
	updateStopWait = 10 * time.Second
)

// ---------------------------------------------------------------- the offer

// agentOffer is the manifest member `agent_update`, decoded and checked for
// shape. Nothing in it is acted on before VerifyRelease has accepted Manifest.
type agentOffer struct {
	RolloutID  string
	ReleaseID  string
	Manifest   []byte
	Signatures []byte
	Rollovers  []RolloverEnvelope
	Artifact   offeredArtifact
	// ManifestSHA256 is the digest of Manifest: what a host reports as `release`.
	ManifestSHA256 string
}

type offeredArtifact struct {
	SHA256 string
	Size   int64
	Path   string
}

func offerRefusal(format string, args ...any) *UpdateRefusal {
	return newUpdateRefusal(codeManifestInvalid, "the offer "+format, args...)
}

// parseAgentOffer decodes the member. Members the agent doesn't know are ignored
// (a newer server may add some), one it needs and doesn't find is a refusal
// (MANIFEST_INVALID), and every bound of the contract is kept. The offer it
// returns holds the digest of the manifest as soon as the manifest decodes, even
// when a later member is refused, so that a refusal can say which release it is
// about.
func parseAgentOffer(raw json.RawMessage) (*agentOffer, *UpdateRefusal) {
	var wire struct {
		RolloutID  *string            `json:"rollout_id"`
		ReleaseID  *string            `json:"release_id"`
		Manifest   *string            `json:"manifest"`
		Signatures *string            `json:"signatures"`
		Rollovers  []RolloverEnvelope `json:"rollovers"`
		Artifact   *struct {
			SHA256 *string `json:"sha256"`
			Size   *int64  `json:"size"`
			Path   *string `json:"path"`
		} `json:"artifact"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, offerRefusal("isn't an object with the members of an offer")
	}
	offer := &agentOffer{}
	if wire.Manifest == nil {
		return nil, offerRefusal("has no manifest")
	}
	manifest, err := DecodeCanonicalBase64(*wire.Manifest)
	if err != nil || len(manifest) == 0 || len(manifest) > MaxReleaseManifest {
		return nil, offerRefusal("holds a manifest that isn't canonical base64 of 1 to %d bytes", MaxReleaseManifest)
	}
	offer.Manifest, offer.ManifestSHA256 = manifest, Digest(manifest)
	switch {
	case wire.RolloutID == nil || !updateRolloutID.MatchString(*wire.RolloutID):
		return offer, offerRefusal("has no rollout_id that is a lowercase UUID")
	case wire.ReleaseID == nil || !updateRolloutID.MatchString(*wire.ReleaseID):
		return offer, offerRefusal("has no release_id that is a lowercase UUID")
	case wire.Signatures == nil:
		return offer, offerRefusal("has no signatures")
	case wire.Artifact == nil || wire.Artifact.SHA256 == nil || wire.Artifact.Size == nil || wire.Artifact.Path == nil:
		return offer, offerRefusal("has no artifact with a sha256, a size and a path")
	}
	offer.RolloutID, offer.ReleaseID = *wire.RolloutID, *wire.ReleaseID
	if offer.Signatures, err = DecodeCanonicalBase64(*wire.Signatures); err != nil || len(offer.Signatures) == 0 || len(offer.Signatures) > MaxReleaseSignatures {
		return offer, offerRefusal("holds signatures that aren't canonical base64 of 1 to %d bytes", MaxReleaseSignatures)
	}
	if len(wire.Rollovers) > MaxRolloverChain {
		return offer, offerRefusal("carries %d rollover statements, and a host follows at most %d", len(wire.Rollovers), MaxRolloverChain)
	}
	if _, err := MarshalUpdateRollovers(wire.Rollovers); err != nil {
		return offer, offerRefusal("carries a rollover statement that breaks the format: %v", err)
	}
	offer.Rollovers = wire.Rollovers
	artifact := offeredArtifact{SHA256: *wire.Artifact.SHA256, Size: *wire.Artifact.Size, Path: *wire.Artifact.Path}
	if !isLowerHex64(artifact.SHA256) || artifact.Size < 1 || artifact.Size > MaxAgentBuild {
		return offer, offerRefusal("names an artifact that isn't a SHA-256 and a size of 1 to %d bytes", MaxAgentBuild)
	}
	offer.Artifact = artifact
	return offer, nil
}

// ---------------------------------------------------------------- what the engine keeps

// updateDecision is what this agent decided about the offer in front of it.
// State is empty (nothing to report), downloading, staged, refused or failed; it
// is about the release named by Release.
type updateDecision struct {
	state    string
	release  string
	code     string
	conflict *RolloverConflict
	// version is the release's version, once the release verified, for the log.
	version string
}

// updateRun is what the engine keeps about agent updates between check-ins. It
// is owned by the run loop's one goroutine, like the engine: the transfer in the
// background touches none of it.
type updateRun struct {
	// memberRefused: a server refused a heartbeat that carried the report and
	// accepted it without. The report stays out for the rest of the process.
	memberRefused bool

	// The offer of the manifest the latest check-in verified: whether it carries
	// one, what it decodes to, why it doesn't, and the digest it names (health.json
	// says it whether or not the agent took the offer).
	offered     bool
	offer       *agentOffer
	offerErr    *UpdateRefusal
	offerDigest string

	decision updateDecision
	// unreported: the decision changed after the last report was built, so the
	// run loop checks in again at once, once.
	unreported bool

	download *updateDownload
	// failures counts the transfers of a release that failed; failure holds the
	// code of the latest one, and gone when the server last stopped offering the
	// build. retryAt is the earliest the server allows another request.
	failures map[string]int
	failure  map[string]string
	gone     map[string]time.Time
	retryAt  time.Time
	// built remembers the builds whose digest this process has checked, by the
	// size and the time the file had.
	built map[string]builtBuild

	// probeCode is the step's answer about a host that hasn't installed it, kept
	// for probeAge since the answer comes from the file system and the service
	// manager.
	probeCode string
	probedAt  time.Time

	// sentLast identifies the result the last report carried, and trial says that
	// report was about a build on trial: the run loop looks at the step's status
	// every few seconds while one is (updateAttention).
	sentLast string
	trial    bool

	// said holds the last line said for each kind, so that the log says each once.
	said map[string]string
}

type builtBuild struct {
	size int64
	time time.Time
}

// reporting says whether the next heartbeats carry the report.
func (e *Engine) reportingUpdates() bool {
	return e.serverSupports(featureAgentUpdate) && !e.update.memberRefused
}

// setDecision records a decision, and says the report is out of date when it
// changed what the report says.
func (e *Engine) setDecision(d updateDecision) {
	run := &e.update
	old := run.decision
	changed := old.state != d.state || old.release != d.release || old.code != d.code
	run.decision = d
	if changed && e.reportingUpdates() {
		run.unreported = true
	}
}

// sayOnce tells the operator something about agent updates, once for each kind of
// line until it changes. The words are fixed: nothing the server said is in them.
func (e *Engine) sayOnce(kind, line string) {
	run := &e.update
	if run.said[kind] == line {
		return
	}
	if run.said == nil {
		run.said = map[string]string{}
	}
	run.said[kind] = line
	if e.Notice != nil {
		e.Notice(line)
	}
}

// noteUpdateOffer reads the offer of a manifest that has just been verified.
func (e *Engine) noteUpdateOffer(m Manifest) {
	run := &e.update
	run.offered, run.offer, run.offerErr, run.offerDigest = false, nil, nil, ""
	if !slices.Contains(m.Features, featureAgentUpdate) || len(m.AgentUpdate) == 0 || string(bytes.TrimSpace(m.AgentUpdate)) == "null" {
		return
	}
	run.offered = true
	run.offer, run.offerErr = parseAgentOffer(m.AgentUpdate)
	if run.offer != nil {
		run.offerDigest = run.offer.ManifestSHA256
	}
}

// ---------------------------------------------------------------- health.json

// recordUpdateHealth writes health.json after a check-in the server answered with
// a manifest this agent verified: the build that runs, the process, when it was
// answered, whether Vector runs and the manifest the answer offered. The privileged
// step reads it to tell a new build that checks in from one that only starts,
// and `vectory update apply` shows it as advice. It is written only for a host
// that consented: an agent that is off writes nothing here, not even a directory.
func (e *Engine) recordUpdateHealth() {
	if e.Dir == "" || e.State.Agent == nil || e.State.Agent.SHA256 == "" {
		return
	}
	policy, _, err := readUpdatePolicy(UpdateLocations())
	if err != nil || policy.Consent == UpdateConsentOff {
		return
	}
	ex := UpdateExchangeFor(e.Dir)
	health := UpdateHealth{
		AgentSHA256: e.State.Agent.SHA256, AgentVersion: Version, BootID: e.BootID, CheckedInAt: e.now(),
		Vector: e.vectorHealth(), Offer: e.update.offerDigest,
	}
	err = ensureUpdateDir(ex.Dir)
	if err == nil {
		err = WriteUpdateHealth(ex.Health, health)
	}
	if err != nil {
		e.sayOnce("health", "The agent couldn't record its check-in for the update step ("+filepath.Join(ex.Dir, UpdateHealthFile)+"): "+err.Error()+". A build it tries will be taken back.")
	}
}

// vectorHealth says whether the workload this agent supervises runs.
func (e *Engine) vectorHealth() string {
	switch {
	case e.Driver == nil || !e.Settings.Adopted || e.State.LastGoodSHA256 == "":
		return UpdateVectorNone
	case e.Driver.Alive():
		return UpdateVectorRunning
	}
	return UpdateVectorStopped
}

// ensureUpdateDir makes a directory of the agent's exchange with the step, private
// to the account that owns the state directory. The parent must exist. A directory
// that is there is left as it is, and a link in the way is refused.
func ensureUpdateDir(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("%s isn't a directory", path)
		}
		return SafePath(path)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := PrivateDir(path); err != nil {
		return storageError(path, err)
	}
	return ownedLikeParent(path)
}

// ---------------------------------------------------------------- attention

// updateAttention says that something about agent updates is worth a check-in now
// rather than at the next interval: a build finished downloading, or the step
// settled the trial of the build this agent runs. The supervisor asks every few
// seconds. It reads one small file, and only while a trial is being watched.
func (e *Engine) updateAttention() bool {
	run := &e.update
	if d := run.download; d != nil && !d.attended && d.finished() {
		d.attended = true
		return true
	}
	if !run.trial || !e.reportingUpdates() {
		return false
	}
	status, err := ReadUpdateStatus()
	if err != nil {
		return false
	}
	if status.Stage != UpdateStageTrial {
		run.trial = false
		return true
	}
	return resultKey(status.Last) != run.sentLast
}

// ---------------------------------------------------------------- the step

// stepUpdates is the agent's work on an offer in one check-in, run after the
// configuration was reconciled and a check on request was answered. check is the
// check the manifest asks for, nil when there is none.
func (e *Engine) stepUpdates(ctx context.Context, check *ValidationRequest) {
	run := &e.update
	if ctx.Err() != nil {
		return
	}
	facts := e.readUpdateFacts()
	policy := facts.policy
	if !facts.policyOK || policy.Consent == UpdateConsentOff {
		// Off, or a policy this agent may not trust: it reports that and nothing
		// else. A transfer it began is dropped, and nothing is written or deleted.
		e.stopUpdateDownload()
		e.setDecision(updateDecision{})
		return
	}
	ex := UpdateExchangeFor(e.Dir)
	e.settleUpdateResult(ex, facts.status)
	switch {
	case !run.offered:
		e.withdrawOffer(ex, facts, true)
		return
	case run.offerErr != nil:
		e.refuseUpdate(ex, facts, run.offerDigest, "", run.offerErr, false)
		return
	}
	offer := run.offer
	if fork := (UpdateView{Policy: policy, Status: facts.status}).Conflict(); fork != nil {
		// The step's own verification found two successors of a pinned key: nothing
		// is taken until the host is pinned again.
		refusal := &UpdateRefusal{Code: codeKeyRolloverConflict, Detail: conflictSentence(fork), From: fork.From, Successors: fork.To[:]}
		e.refuseUpdate(ex, facts, offer.ManifestSHA256, "", refusal, false)
		return
	}
	if policy.Paused || facts.localStop {
		// A pause stops every download and every apply; what is staged for this
		// offer stays, and what was staged for another is deleted as ever.
		e.stopUpdateDownload()
		if e.cleanUpdateFiles(ex, facts.status, offer.ManifestSHA256) {
			e.sayOnce("withdrawn", "A staged agent update that the server no longer offers was deleted.")
		}
		e.setDecision(updateDecision{})
		return
	}

	verified, err := VerifyRelease(e.verifyInput(offer, facts))
	if err != nil {
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) {
			refusal = newUpdateRefusal(codeManifestInvalid, "the release can't be verified")
		}
		e.refuseUpdate(ex, facts, offer.ManifestSHA256, "", refusal, false)
		return
	}
	version := verified.Manifest.Version
	if want := updateReleasePath + verified.Artifact.SHA256; offer.Artifact.SHA256 != verified.Artifact.SHA256 || offer.Artifact.Size != verified.Artifact.Size || offer.Artifact.Path != want {
		e.refuseUpdate(ex, facts, offer.ManifestSHA256, version, offerRefusal("names a build that isn't the release's build for this platform"), false)
		return
	}
	if last := facts.status; last != nil && last.Last != nil && last.Last.Release == verified.ManifestSHA256 {
		// The step has ended its request for this release, whatever came of it: the
		// agent never stages it again. A release that rolled back is already refused
		// above (the host's floor), and one that failed or was refused is for the
		// next release to replace.
		e.withdrawOffer(ex, facts, false)
		return
	}
	if code := e.reportEligibility(facts); code != UpdateEligible {
		e.refuseUpdate(ex, facts, verified.ManifestSHA256, version, newUpdateRefusal(code, "this host can't take an update"), true)
		return
	}
	if e.updateDeferred(facts, check) {
		// Busy: nothing is started and nothing is staged. A build already on its way
		// or staged is left as it is.
		if d := run.decision; d.release != verified.ManifestSHA256 || (d.state != UpdateStateDownloading && d.state != UpdateStateStaged) {
			e.setDecision(updateDecision{})
		}
		return
	}
	e.stageUpdate(ctx, ex, facts, verified, offer)
}

// verifyInput is everything this host decides an offer from.
func (e *Engine) verifyInput(offer *agentOffer, facts updateFacts) VerifyInput {
	input := VerifyInput{
		Manifest: offer.Manifest, Signatures: offer.Signatures, Rollovers: offer.Rollovers,
		Pins: facts.policy.PinnedKeys(), Now: e.now(), RunningVersion: Version, OS: runtime.GOOS, Arch: runtime.GOARCH,
		Track: facts.policy.Track, ServiceDefinition: updateServiceGeneration,
	}
	if status := facts.status; status != nil {
		input.Floors = maps.Clone(status.HighestCounters)
		input.ServiceDefinition = status.ServiceDefinition
		if status.Last != nil {
			result := status.Last.ReleaseResult()
			input.Last = &result
		}
	}
	return input
}

// updateDeferred says the host is busy with something an agent update waits for: a
// configuration apply in progress or journaled, a check on request that hasn't
// been answered, or the privileged step at work.
func (e *Engine) updateDeferred(facts updateFacts, check *ValidationRequest) bool {
	switch {
	case e.applyInFlight():
		return true
	case e.deviceCheckOpen(check):
		return true
	case facts.status != nil && facts.status.Stage != UpdateStageIdle:
		return true
	}
	return false
}

// deviceCheckOpen says the manifest asks for a check this agent hasn't answered.
func (e *Engine) deviceCheckOpen(check *ValidationRequest) bool {
	if check == nil {
		return false
	}
	if pending := e.validation.pending; pending != nil && pending.ID == check.ID {
		return false
	}
	return !e.validationAnswered(check.ID)
}

// refuseUpdate records that the agent refuses the offer, with the code of the
// contract, and ends what the offer started: a transfer is dropped, and what was
// staged for it deleted unless keep says to leave it (a host that can't take an
// update right now may be able to in a minute).
func (e *Engine) refuseUpdate(ex UpdateExchange, facts updateFacts, release, version string, refusal *UpdateRefusal, keep bool) {
	e.stopUpdateDownload()
	code := refusal.Code
	if !IsUpdateCode(code) {
		code = codeManifestInvalid
	}
	decision := updateDecision{state: UpdateStateRefused, release: release, code: code, version: version}
	if code == codeKeyRolloverConflict && refusal.From != "" && len(refusal.Successors) == 2 {
		decision.conflict = &RolloverConflict{From: refusal.From, To: [2]string{refusal.Successors[0], refusal.Successors[1]}}
	}
	e.setDecision(decision)
	if !keep {
		e.cleanUpdateFiles(ex, facts.status, "")
	}
	if code == codeAlreadyRunning {
		// Where a release that was just installed is still offered until the server
		// has seen it check in: nothing to tell.
		return
	}
	what := "An offered agent update"
	if version != "" {
		what = "Agent update " + version
	}
	e.sayOnce("refused", fmt.Sprintf("%s was refused (%s): %s.", what, code, updateCodeWords(code)))
}

// withdrawOffer ends everything the agent did for an offer: the transfer, what
// was staged unless the step has started on it, and the decision. gone says the
// server stopped offering it, which the log tells; otherwise the step is done with
// it, and nothing in it is news.
func (e *Engine) withdrawOffer(ex UpdateExchange, facts updateFacts, gone bool) {
	e.stopUpdateDownload()
	version := e.update.decision.version
	if e.cleanUpdateFiles(ex, facts.status, "") && gone {
		what := "the agent update"
		if version != "" {
			what = "agent update " + version
		}
		e.sayOnce("withdrawn", "The server no longer offers "+what+". What was staged for it is deleted.")
	}
	e.setDecision(updateDecision{})
}

// ---------------------------------------------------------------- the files

// settleUpdateResult deletes the request and the staged build once the step's
// status holds the result of that request: the step has finished with them.
func (e *Engine) settleUpdateResult(ex UpdateExchange, status *UpdateStatus) {
	if status == nil || status.Last == nil {
		return
	}
	request, err := ReadUpdateRequest(ex.Request)
	if err != nil || request.ManifestSHA256 != status.Last.Release {
		return
	}
	_ = os.Remove(ex.Request)
	if dir, err := ex.IncomingDir(request.ManifestSHA256); err == nil && SafePath(dir) == nil {
		_ = os.RemoveAll(dir)
	}
	_ = syncDir(ex.Dir)
}

// cleanUpdateFiles deletes what the agent staged for any offer but keep, and the
// request that names it, unless the step's status shows it started on that one: the
// request goes first, so that the step never meets one that names files that are
// gone. It reports whether it deleted anything. It makes nothing: a directory that
// isn't there is not an error.
func (e *Engine) cleanUpdateFiles(ex UpdateExchange, status *UpdateStatus, keep string) (removed bool) {
	started := ""
	if status != nil && status.Stage != UpdateStageIdle {
		started = status.Release
	}
	switch request, err := ReadUpdateRequest(ex.Request); {
	case err == nil:
		if request.ManifestSHA256 != keep && request.ManifestSHA256 != started {
			removed = os.Remove(ex.Request) == nil || removed
		}
	case !notExist(err) && started == "" && SafePath(ex.Dir) == nil:
		// A request nothing can read is one the step can't act on either.
		removed = os.Remove(ex.Request) == nil || removed
	}
	if SafePath(ex.Incoming) != nil {
		return removed
	}
	entries, err := os.ReadDir(ex.Incoming)
	if err != nil {
		return removed
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == keep || started != "" && name == started {
			continue
		}
		removed = os.RemoveAll(filepath.Join(ex.Incoming, name)) == nil || removed
	}
	return removed
}

// ---------------------------------------------------------------- staging

// stageUpdate takes a verified, eligible, undeferred offer to the point where the
// step has a request: the build is fetched in the background, and when it has
// arrived whole its files and the request are written.
func (e *Engine) stageUpdate(ctx context.Context, ex UpdateExchange, facts updateFacts, v Verified, offer *agentOffer) {
	run := &e.update
	release, version := v.ManifestSHA256, v.Manifest.Version
	decide := func(state, code string) {
		e.setDecision(updateDecision{state: state, release: release, code: code, version: version})
	}
	// What was staged for another offer goes; this one's stays.
	e.cleanUpdateFiles(ex, facts.status, release)
	if d := run.download; d != nil && d.release != release {
		e.stopUpdateDownload()
	}
	dir, err := ex.IncomingDir(release)
	if err != nil {
		decide(UpdateStateFailed, "DOWNLOAD_FAILED")
		return
	}
	build := filepath.Join(dir, UpdateBuildFile(runtime.GOOS))

	if d := run.download; d != nil {
		select {
		case <-d.done:
			run.download = nil
			if failure := d.err; failure != nil {
				e.transferFailed(ex, facts, release, version, failure, decide)
				return
			}
			// The transfer checked the build's size and digest before it gave it its
			// name: that is as good as hashing it again.
			e.rememberBuild(v.Artifact.SHA256, d.info)
		default:
			decide(UpdateStateDownloading, "")
			return
		}
	}
	if !e.buildStaged(build, v.Artifact) {
		now := e.now()
		switch {
		case run.failures[release] >= updateAttempts:
			decide(UpdateStateFailed, run.failure[release])
		case now.Before(run.retryAt):
			// The server is busy and asked for time.
			decide(UpdateStateDownloading, "")
		case now.Before(run.gone[release].Add(updateGoneWait)):
			// The server stopped serving the build lately: not asked for again yet.
			decide("", "")
		default:
			e.startUpdateDownload(ctx, ex, dir, v, offer, decide)
		}
		return
	}
	if err := e.writeUpdateStage(ex, dir, v, offer); err != nil {
		e.transferFailed(ex, facts, release, version, storageFailure(ex.Dir, err), decide)
		return
	}
	delete(run.failures, release)
	decide(UpdateStateStaged, "")
	e.sayStaged(version, v.Artifact.Size, facts)
}

// sayStaged tells the operator that a build is staged and what it waits for.
func (e *Engine) sayStaged(version string, size int64, facts updateFacts) {
	line := "Agent update " + version + " (" + byteSize(size) + ") is staged"
	switch {
	case facts.policy.Consent == UpdateConsentAsk:
		line += ", and waits for you: " + AdminCommandFor(e.Dir, "vectory update apply") + "."
	default:
		if windows, err := facts.policy.ParsedWindows(); err == nil && !windows.OpenAt(facts.now.Local()) {
			line += ", and waits for the update window."
		} else {
			line += ". The update step applies it within a minute."
		}
	}
	e.sayOnce("staged", line)
}

// buildStaged says the build is there under its final name with the signed size
// and SHA-256. A build this process has checked is trusted while its size and
// time are what they were; any other is hashed once, and deleted when it isn't
// the signed one.
func (e *Engine) buildStaged(path string, artifact ReleaseArtifact) bool {
	run := &e.update
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != artifact.Size {
		return false
	}
	if known, ok := run.built[artifact.SHA256]; ok && known.size == info.Size() && known.time.Equal(info.ModTime()) {
		return true
	}
	if digest, err := FileDigest(path); err != nil || digest != artifact.SHA256 {
		_ = os.Remove(path)
		return false
	}
	e.rememberBuild(artifact.SHA256, info)
	return true
}

// rememberBuild notes that the file info describes has been checked against the
// digest.
func (e *Engine) rememberBuild(digest string, info os.FileInfo) {
	if e.update.built == nil {
		e.update.built = map[string]builtBuild{}
	}
	e.update.built[digest] = builtBuild{size: info.Size(), time: info.ModTime()}
}

// startUpdateDownload begins the transfer in the background. The engine never
// waits for it: the next check-in that finds it done takes it from there.
func (e *Engine) startUpdateDownload(ctx context.Context, ex UpdateExchange, dir string, v Verified, offer *agentOffer, decide func(state, code string)) {
	run := &e.update
	for _, path := range []string{ex.Dir, ex.Incoming, dir} {
		if err := ensureUpdateDir(path); err != nil {
			e.transferFailed(ex, updateFacts{}, v.ManifestSHA256, v.Manifest.Version, storageFailure(path, err), decide)
			return
		}
	}
	client := e.Client
	transfer, cancel := context.WithCancel(ctx)
	d := &updateDownload{release: v.ManifestSHA256, cancel: cancel, done: make(chan struct{})}
	run.download = d
	size, digest, path := v.Artifact.Size, v.Artifact.SHA256, offer.Artifact.Path
	go func() {
		defer close(d.done)
		d.info, d.err = client.downloadAgentBuild(transfer, path, dir, size, digest)
	}()
	decide(UpdateStateDownloading, "")
	e.sayOnce("download", "Downloading agent update "+v.Manifest.Version+" ("+byteSize(size)+").")
}

// transferFailed records a transfer that did not give a build, in the way the
// failure asks: a server that stopped offering the build ends the attempt, one
// that is busy is waited out, and the rest are counted, three failing a release.
func (e *Engine) transferFailed(ex UpdateExchange, facts updateFacts, release, version string, err error, decide func(state, code string)) {
	run := &e.update
	var failure *updateDownloadError
	if !errors.As(err, &failure) {
		if errors.Is(err, context.Canceled) {
			return
		}
		failure = &updateDownloadError{Code: "DOWNLOAD_FAILED", Words: "The build couldn't be fetched. " + updateDownloadWords.again, cause: err}
	}
	what := "agent update " + version
	switch {
	case failure.Gone:
		if run.gone == nil {
			run.gone = map[string]time.Time{}
		}
		run.gone[release] = e.now()
		e.cleanUpdateFiles(ex, facts.status, "")
		decide("", "")
		e.sayOnce("download", "The server no longer serves "+what+". What was staged for it is deleted.")
	case failure.Retry > 0:
		run.retryAt = e.now().Add(failure.Retry)
		decide(UpdateStateDownloading, "")
		e.sayOnce("download", "Downloading "+what+" waits: "+failure.Words)
	default:
		if run.failures == nil {
			run.failures, run.failure = map[string]int{}, map[string]string{}
		}
		run.failures[release]++
		run.failure[release] = failure.Code
		if run.failures[release] >= updateAttempts {
			decide(UpdateStateFailed, failure.Code)
			e.sayOnce("download", fmt.Sprintf("The download of %s failed %d times, and the agent stops trying it: %s", what, updateAttempts, failure.Words))
		} else {
			decide(UpdateStateDownloading, "")
			e.sayOnce("download", fmt.Sprintf("The download of %s failed (%d of %d): %s", what, run.failures[release], updateAttempts, failure.Words))
		}
	}
}

// writeUpdateStage writes release.json, release.json.sig and rollovers.json beside
// the staged build, then request.json, which tells the step there is something to
// apply. Each is written whole or not at all (AtomicWrite), the request last, and
// a file that already holds the bytes is left alone.
func (e *Engine) writeUpdateStage(ex UpdateExchange, dir string, v Verified, offer *agentOffer) error {
	rollovers, err := MarshalUpdateRollovers(offer.Rollovers)
	if err != nil {
		return err
	}
	for _, file := range []struct {
		name string
		data []byte
	}{{UpdateReleaseFile, offer.Manifest}, {UpdateSignaturesFile, offer.Signatures}, {UpdateRolloversFile, rollovers}} {
		path := filepath.Join(dir, file.name)
		if have, err := readUpdateFile(path, MaxUpdateRollovers); err == nil && bytes.Equal(have, file.data) {
			continue
		}
		if err := AtomicWrite(path, file.data); err != nil {
			return err
		}
	}
	request := UpdateRequest{ManifestSHA256: v.ManifestSHA256, ArtifactSHA256: v.Artifact.SHA256, RolloutID: offer.RolloutID, OfferedAt: e.now().Truncate(time.Second)}
	if have, err := ReadUpdateRequest(ex.Request); err == nil && have.ManifestSHA256 == request.ManifestSHA256 && have.ArtifactSHA256 == request.ArtifactSHA256 && have.RolloutID == request.RolloutID {
		return nil
	}
	return WriteUpdateRequest(ex.Request, request)
}

// ---------------------------------------------------------------- the transfer

// updateDownload is a transfer in the background. The goroutine that runs it
// writes info and err before it closes done, and nothing else of the engine.
type updateDownload struct {
	release string
	cancel  context.CancelFunc
	done    chan struct{}
	info    os.FileInfo
	err     error
	// attended: the supervisor has already asked for a check-in because it ended.
	attended bool
}

// finished reports whether the transfer has ended.
func (d *updateDownload) finished() bool {
	select {
	case <-d.done:
		return true
	default:
		return false
	}
}

// stopUpdateDownload ends a transfer that is running, and waits for it to take its
// partial file away. It is called when the offer is gone, when the host stops
// taking updates and when the agent stops.
func (e *Engine) stopUpdateDownload() {
	d := e.update.download
	if d == nil {
		return
	}
	e.update.download = nil
	d.cancel()
	select {
	case <-d.done:
	case <-time.After(updateStopWait):
	}
}
