package agent

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// A fork of a pinned key is the one refused offer that the agent hands to the update
// step, so that the host remembers it: the offer's three small files and a request,
// and no build. The agent verifies every offer itself, so without that no request would
// reach the step for a release that forks, and a host that saw one would take the next
// offer that carries only one of the two statements. These tests hold the agent's half.
// The step's half, which is what makes the fork the host's record, is in
// update_helper_fork_test.go.

// forkOf is two statements from the key the host pins that name different successors.
type forkOf struct {
	statements []RolloverEnvelope
	private    [2]ReleasePrivateKey
	public     [2]ReleaseKey
}

func (r *offerRig) newFork() forkOf {
	r.t.Helper()
	var fork forkOf
	issued := time.Now().UTC().Truncate(time.Second)
	for i, seed := range []byte{3, 4} {
		fork.private[i] = testPrivateKey(r.t, seed)
		fork.public[i] = testPublicKey(r.t, fork.private[i], "successor")
		envelope, err := SignRollover(r.private, fork.public[i], issued)
		if err != nil {
			r.t.Fatal(err)
		}
		fork.statements = append(fork.statements, envelope)
	}
	return fork
}

// conflict is the fork as the step records it: the key the host pins, and the two
// successors in ascending order.
func (f forkOf) conflict(from ReleaseKey) *RolloverConflict {
	to := [2]string{f.public[0].Fingerprint(), f.public[1].Fingerprint()}
	if to[0] > to[1] {
		to[0], to[1] = to[1], to[0]
	}
	return &RolloverConflict{From: from.Fingerprint(), To: to}
}

// offerFork offers the default release with the two statements that fork the key the
// host pins.
func (r *offerRig) offerFork() forkOf {
	r.t.Helper()
	fork := r.newFork()
	r.offer(r.manifest, r.signatures, fork.statements)
	return fork
}

// stepAnswers writes what the step writes when it ends the request for the release
// that forks: refused, and the fork itself when it found one.
func (r *offerRig) stepAnswers(fork forkOf, recorded bool) {
	r.t.Helper()
	r.step(func(s *UpdateStatus) {
		s.Last = &UpdateLast{Release: r.releaseSHA, Outcome: UpdateOutcomeRefused, Code: "KEY_ROLLOVER_CONFLICT", At: time.Now().UTC().Truncate(time.Second), FromVersion: r.e.State.Agent.Version}
		if recorded {
			s.RolloverConflict = fork.conflict(r.public)
		}
	})
}

// evidencePaths are the four files the agent writes for a fork.
func (r *offerRig) evidencePaths() []string {
	dir := filepath.Join(r.exchange().Incoming, r.releaseSHA)
	return []string{r.exchange().Request, filepath.Join(dir, UpdateReleaseFile), filepath.Join(dir, UpdateSignaturesFile), filepath.Join(dir, UpdateRolloversFile)}
}

// requireEvidence says what the agent handed over for the fork it refused: the three
// small files of the offer as they were offered, and a request that names the manifest
// and this platform's build, and nothing else, and that no build was asked for (builds
// is how many times one was, for an offer that was taken before).
func (r *offerRig) requireEvidence(fork forkOf, builds int) {
	r.t.Helper()
	if got := r.staged(); !slices.Equal(got, []string{r.releaseSHA}) {
		r.t.Fatalf("what is staged: %v, want only the evidence for %s", got, r.releaseSHA)
	}
	dir := filepath.Join(r.exchange().Incoming, r.releaseSHA)
	entries, err := os.ReadDir(dir)
	if err != nil {
		r.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if want := []string{UpdateReleaseFile, UpdateSignaturesFile, UpdateRolloversFile}; !slices.Equal(names, want) {
		r.t.Fatalf("the files of the evidence: %v, want %v", names, want)
	}
	for name, want := range map[string][]byte{UpdateReleaseFile: r.manifest, UpdateSignaturesFile: r.signatures} {
		if got, err := os.ReadFile(filepath.Join(dir, name)); err != nil || !bytes.Equal(got, want) {
			r.t.Fatalf("%s isn't what the server offered: %v", name, err)
		}
	}
	if got, err := ReadUpdateRollovers(filepath.Join(dir, UpdateRolloversFile)); err != nil || !slices.Equal(got, fork.statements) {
		r.t.Fatalf("the statements: %v, %v", got, err)
	}
	request, err := ReadUpdateRequest(r.exchange().Request)
	if err != nil || request.ManifestSHA256 != r.releaseSHA || request.ArtifactSHA256 != r.buildSHA || request.RolloutID != defaultRollout {
		r.t.Fatalf("the request: %+v, %v", request, err)
	}
	if r.requests() != builds || r.e.update.download != nil {
		r.t.Fatalf("builds were asked for %d times for the offers that fork, want %d", r.requests(), builds)
	}
}

func (r *offerRig) requireNothingHandedOver() {
	r.t.Helper()
	if got := r.staged(); len(got) != 0 {
		r.t.Fatalf("something was staged: %v", got)
	}
	if _, err := os.Lstat(r.exchange().Request); !os.IsNotExist(err) {
		r.t.Fatalf("a request was written: %v", err)
	}
}

func TestAForkIsRefusedAndHandedToTheUpdateStepAsEvidenceWithNoBuild(t *testing.T) {
	rig := newOfferRig(t)
	fork := rig.offerFork()
	rig.poll()
	rig.poll()

	// The host reports it as it did before: refused, with both successors.
	beat := rig.beat()
	reported, _ := beat["rollover_conflict"].(map[string]any)
	to, _ := reported["to"].([]any)
	want := fork.conflict(rig.public)
	if beat["state"] != "refused" || beat["code"] != "KEY_ROLLOVER_CONFLICT" || beat["release"] != rig.releaseSHA ||
		reported["from"] != want.From || len(to) != 2 || to[0] != want.To[0] || to[1] != want.To[1] {
		t.Fatalf("the host reports %v", beat)
	}
	rig.requireEvidence(fork, 0)

	// What `vectory update status` and `apply` read says there is no build to apply.
	if staged := readStagedUpdate(rig.exchange()); staged == nil || staged.Complete || staged.ManifestSHA256 != rig.releaseSHA || staged.Version != rig.defaultVersion {
		t.Fatalf("what the host's own commands read of it: %+v", staged)
	}

	// The words of the log are fixed, and said once.
	said := 0
	for _, line := range rig.said {
		if strings.Contains(line, "(KEY_ROLLOVER_CONFLICT): ") {
			said++
		}
	}
	if said != 1 {
		t.Fatalf("the log said %q", rig.said)
	}
}

func TestTheEvidenceOfAForkIsWrittenOnceAndWrittenAgainOnlyWhileItIsIncomplete(t *testing.T) {
	rig := newOfferRig(t)
	fork := rig.offerFork()
	rig.poll()
	rig.poll()
	rig.requireEvidence(fork, 0)
	stamp := func() []os.FileInfo {
		var stamps []os.FileInfo
		for _, path := range rig.evidencePaths() {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			stamps = append(stamps, info)
		}
		return stamps
	}
	before := stamp()
	for i := 0; i < 4; i++ {
		rig.poll()
	}
	for i, after := range stamp() {
		if !os.SameFile(before[i], after) || !before[i].ModTime().Equal(after.ModTime()) {
			t.Errorf("%s was written again while the evidence was whole", rig.evidencePaths()[i])
		}
	}

	// A file that went missing is made again, and the request, which was there, stays.
	signatures := rig.evidencePaths()[2]
	if err := os.Remove(signatures); err != nil {
		t.Fatal(err)
	}
	rig.poll()
	rig.requireEvidence(fork, 0)
	if after := stamp(); !os.SameFile(before[0], after[0]) || !os.SameFile(before[1], after[1]) {
		t.Error("the files that were whole were written again")
	}
}

func TestNoEvidenceIsHandedOverWhileUpdatesAreOffPausedOrHeldAndItIsOnceTheyAreNot(t *testing.T) {
	for name, c := range map[string]struct {
		hold, release func(*offerRig)
		// nothingAtAll: the host that is off makes nothing under its state directory.
		nothingAtAll bool
	}{
		"updates are off": {
			hold:         func(r *offerRig) { r.policy(func(p *UpdatePolicy) { p.Consent = UpdateConsentOff }) },
			release:      func(r *offerRig) { r.policy(func(p *UpdatePolicy) { p.Consent = UpdateConsentAuto }) },
			nothingAtAll: true,
		},
		"updates are paused": {
			hold:    func(r *offerRig) { r.policy(func(p *UpdatePolicy) { p.Paused = true }) },
			release: func(r *offerRig) { r.policy(func(p *UpdatePolicy) { p.Paused = false }) },
		},
		"vectory pause holds the host": {
			hold: func(r *offerRig) {
				if err := SetPause(r.state, true); err != nil {
					r.t.Fatal(err)
				}
			},
			release: func(r *offerRig) {
				if err := SetPause(r.state, false); err != nil {
					r.t.Fatal(err)
				}
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			fork := rig.offerFork()
			c.hold(rig)
			for i := 0; i < 3; i++ {
				rig.poll()
			}
			if c.nothingAtAll {
				rig.nothingUnderUpdates()
			} else {
				rig.requireNothingHandedOver()
			}
			if rig.requests() != 0 {
				t.Fatalf("a build was asked for: %d", rig.requests())
			}
			c.release(rig)
			rig.poll()
			rig.poll()
			rig.requireEvidence(fork, 0)
		})
	}
}

func TestEvidenceTheStepHasAnsweredIsClearedAndNeverHandedOverAgain(t *testing.T) {
	for name, recorded := range map[string]bool{
		"the step recorded the fork":          true,
		"the step answered and found no fork": false,
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			fork := rig.offerFork()
			rig.poll()
			rig.poll()
			rig.requireEvidence(fork, 0)

			rig.stepAnswers(fork, recorded)
			for i := 0; i < 3; i++ {
				rig.poll()
				// What the agent staged for the request is deleted as soon as the answer is
				// there, and what the offer still says does not stage it again.
				rig.requireNothingHandedOver()
			}
			beat := rig.beat()
			if beat["state"] != "refused" || beat["code"] != "KEY_ROLLOVER_CONFLICT" || beat["release"] != rig.releaseSHA {
				t.Fatalf("the host reports %v", beat)
			}
			if rig.requests() != 0 {
				t.Fatalf("a build was asked for: %d", rig.requests())
			}
		})
	}
}

// The request is the step's one input, and while the step is at work on something the
// agent leaves it alone: the offer is still offered at the next check-in.
func TestEvidenceWaitsWhileTheStepIsAtWorkAndIsHandedOverWhenItIsIdle(t *testing.T) {
	rig := newOfferRig(t)
	rig.step(func(s *UpdateStatus) {
		s.Stage, s.Release, s.FromVersion, s.ToVersion = UpdateStageTrial, strings.Repeat("9", 64), "0.0.9", "0.1.0"
		s.Deadline = time.Now().UTC().Add(4 * time.Minute).Truncate(time.Second)
	})
	fork := rig.offerFork()
	rig.poll()
	rig.poll()
	rig.requireNothingHandedOver()

	rig.step(nil)
	rig.poll()
	rig.requireEvidence(fork, 0)
}

func TestAForkReplacesWhatWasStagedForAnotherOffer(t *testing.T) {
	rig := newOfferRig(t)
	rig.stageIt()
	first := rig.releaseSHA
	requests := rig.requests()

	fork := rig.newFork()
	rig.build = append(bytes.Clone(rig.build), "next"...)
	rig.release(func(m *ReleaseManifest) {
		m.Version, m.Counter = rig.followingVersion, 8
		m.Artifacts = []ReleaseArtifact{platformArtifact(rig.build, rig.followingVersion)}
	})
	rig.offer(rig.manifest, rig.signatures, fork.statements)
	rig.poll()
	rig.poll()

	if rig.releaseSHA == first {
		t.Fatal("the offer didn't change")
	}
	// The only build asked for is the one of the offer before.
	rig.requireEvidence(fork, requests)
	if _, err := os.Lstat(filepath.Join(rig.exchange().Incoming, first)); !os.IsNotExist(err) {
		t.Errorf("what was staged for the offer before is still there: %v", err)
	}
}

// What the step records is what makes the host refuse, and the agent reads it from the
// step's status: a release signed by one of the two successors, with the one statement
// that hands the key over, verifies for a host that never saw the fork, and is refused
// by one that did.
func TestOnceTheStepHasRecordedAForkALaterOfferWithOneStatementIsRefusedAndWithoutTheRecordItIsTaken(t *testing.T) {
	rig := newOfferRig(t)
	fork := rig.offerFork()
	rig.poll()
	rig.poll()
	rig.requireEvidence(fork, 0)
	rig.stepAnswers(fork, true)
	rig.poll()
	rig.requireNothingHandedOver()

	manifest, err := BuildReleaseManifest(ReleaseManifest{
		Version: rig.followingVersion, Counter: 8, IssuedAt: time.Now().UTC().Add(-time.Hour).Truncate(time.Second), ExpiresAt: time.Now().UTC().Add(90 * 24 * time.Hour).Truncate(time.Second),
		ServiceDefinition: 1, Artifacts: []ReleaseArtifact{platformArtifact(rig.build, rig.followingVersion)},
	})
	if err != nil {
		t.Fatal(err)
	}
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(fork.public[0], fork.private[0].SignRelease(manifest))})
	if err != nil {
		t.Fatal(err)
	}
	rig.offer(manifest, signatures, fork.statements[:1])
	for i := 0; i < 3; i++ {
		rig.poll()
	}
	beat := rig.beat()
	if beat["state"] != "refused" || beat["code"] != "KEY_ROLLOVER_CONFLICT" || beat["release"] != rig.releaseSHA {
		t.Fatalf("the host reports %v", beat)
	}
	if rig.requests() != 0 || rig.e.update.download != nil {
		t.Fatalf("a frozen host asked for a build: %d requests", rig.requests())
	}
	rig.requireNothingHandedOver()

	// The control: the same offer, to a host whose step recorded nothing, is taken.
	rig.step(nil)
	rig.stageIt()
	if got := rig.staged(); !slices.Equal(got, []string{rig.releaseSHA}) || rig.requests() != 1 {
		t.Fatalf("a host that recorded no fork didn't take the offer: %v, %d requests", got, rig.requests())
	}
}
