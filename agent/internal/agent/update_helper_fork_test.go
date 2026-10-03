//go:build !windows

package agent

import (
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"
)

// A fork of a pinned key (two statements from it that name different successors) is
// evidence that someone else holds the key, and the host that saw it takes no update
// until it is pinned again. The agent verifies every offer itself and hands one that
// forks to the step as a request with no build; the step decides it again from its own
// copies, before consent makes the request wait, and writes the fork into root's files.
// What the step touches for it is its record and its answer, and nothing else.

// stepFork is the release a server offers a host that pins the fixture's key when two
// statements fork that key: it is signed by the first successor and carries both.
type stepFork struct {
	release    *fakeRelease
	conflict   *RolloverConflict
	b, c       ReleasePrivateKey
	keyB, keyC ReleaseKey
	toB, toC   RolloverEnvelope
}

func (f *stepFixture) newFork() stepFork {
	f.t.Helper()
	var fork stepFork
	fork.b, fork.c = testPrivateKey(f.t, 31), testPrivateKey(f.t, 32)
	fork.keyB, fork.keyC = testPublicKey(f.t, fork.b, "b"), testPublicKey(f.t, fork.c, "c")
	var err error
	if fork.toB, err = SignRollover(f.private, fork.keyB, f.start.Add(-time.Hour)); err != nil {
		f.t.Fatal(err)
	}
	if fork.toC, err = SignRollover(f.private, fork.keyC, f.start.Add(-time.Hour)); err != nil {
		f.t.Fatal(err)
	}
	fork.release = f.newRelease("0.1.1", "good", releaseOptions{signer: &fork.b, signerKey: &fork.keyB, rollovers: []RolloverEnvelope{fork.toB, fork.toC}})
	successors := []string{fork.keyB.Fingerprint(), fork.keyC.Fingerprint()}
	slices.Sort(successors)
	fork.conflict = &RolloverConflict{From: f.public.Fingerprint(), To: [2]string{successors[0], successors[1]}}
	return fork
}

// stageEvidence stages a release the way the agent stages an offer that forks: the
// three small files and the request, and no build.
func (f *stepFixture) stageEvidence(r *fakeRelease) {
	f.t.Helper()
	dir := f.stage(r)
	if err := os.Remove(filepath.Join(dir, UpdateBuildFile(runtime.GOOS))); err != nil {
		f.t.Fatal(err)
	}
}

func (f *stepFixture) helperListing() []string {
	f.t.Helper()
	entries, err := os.ReadDir(f.paths.Helper)
	if err != nil {
		f.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// whatTheStepKeeps is what a request that forks must leave alone besides the record:
// what machineSnapshot holds, the floors in counters.json and the helper copy's
// directory.
type whatTheStepKeeps struct {
	machineSnapshot
	floors map[string]uint64
	helper []string
}

func (f *stepFixture) keepsNow() whatTheStepKeeps {
	f.t.Helper()
	return whatTheStepKeeps{machineSnapshot: f.snapshot(), floors: maps.Clone(f.counters().HighestCounters), helper: f.helperListing()}
}

// requireOnlyTheForkWasRecorded says the step answered the request refused with
// KEY_ROLLOVER_CONFLICT, wrote the fork in counters.json and status.json, and changed
// nothing else: not the executable, the journal, the floors, the installed record, the
// service, the helper copy or the step's scratch directories, and it ran no build.
func (f *stepFixture) requireOnlyTheForkWasRecorded(release *fakeRelease, fork *RolloverConflict, before whatTheStepKeeps) {
	f.t.Helper()
	f.requireAnswered(release, UpdateOutcomeRefused, "KEY_ROLLOVER_CONFLICT")
	f.requireUnchanged(before.machineSnapshot, "counters")
	counters := f.counters()
	if counters.RolloverConflict == nil || *counters.RolloverConflict != *fork {
		f.t.Fatalf("the fork the step recorded: %+v, want %+v", counters.RolloverConflict, fork)
	}
	if got := f.status().RolloverConflict; got == nil || *got != *fork {
		f.t.Errorf("status.json says %+v", got)
	}
	if !maps.Equal(counters.HighestCounters, before.floors) {
		f.t.Errorf("the floors changed: %v, were %v", counters.HighestCounters, before.floors)
	}
	if got := f.helperListing(); !slices.Equal(got, before.helper) {
		f.t.Errorf("the helper copy's directory changed: %v, was %v", got, before.helper)
	}
	if len(f.host.probeCalls) != 0 {
		f.t.Errorf("a build was run: %v", f.host.probeCalls)
	}
}

func (f *stepFixture) requireNoForkRecorded() {
	f.t.Helper()
	if got := f.counters().RolloverConflict; got != nil {
		f.t.Fatalf("a fork was recorded: %+v", got)
	}
	if got := f.status().RolloverConflict; got != nil {
		f.t.Fatalf("status.json shows a fork: %+v", got)
	}
}

func (f *stepFixture) applyNow() {
	f.t.Helper()
	if err := ApplyStagedUpdate(bg(), f.stateDir, false, nil); err != nil {
		f.t.Fatal(err)
	}
}

func TestAForkInARequestWithNoBuildIsRecordedWhateverTheHostWaitsFor(t *testing.T) {
	for _, c := range []struct {
		name   string
		policy func(*UpdatePolicy)
		// apply: a person runs `vectory update apply`; otherwise it is the timer's run.
		apply bool
		// withBuild: a build is beside the request, which the step must not copy.
		withBuild bool
	}{
		{name: "an automatic host", policy: func(p *UpdatePolicy) {}},
		{name: "an ask host that waits for a person", policy: func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk }},
		{name: "an automatic host whose window is closed", policy: func(p *UpdatePolicy) { p.Windows = []string{"daily 03:00-04:00 UTC"} }},
		{name: "a person running apply on an ask host", policy: func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk }, apply: true},
		{name: "an ask host, and a build is beside the request", policy: func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk }, withBuild: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newStepFixture(t)
			f.setPolicy(c.policy)
			fork := f.newFork()
			if c.withBuild {
				f.stage(fork.release)
			} else {
				f.stageEvidence(fork.release)
			}
			before := f.keepsNow()

			if c.apply {
				f.applyNow()
			} else {
				f.mustRun()
			}

			f.requireOnlyTheForkWasRecorded(fork.release, fork.conflict, before)
		})
	}
}

// The host that is off, paused or held verifies nothing, so it records nothing: the
// first two end the request with their own words, and `vectory pause` leaves it where
// it was. Once the host takes updates again the same request is decided.
func TestAHostThatIsOffPausedOrHeldVerifiesNothingSoItRecordsNoFork(t *testing.T) {
	for _, c := range []struct {
		name string
		hold func(*stepFixture)
		// code is how the step answers the request, "" when it leaves it unanswered.
		code string
	}{
		{"updates are off", func(f *stepFixture) { f.setPolicy(func(p *UpdatePolicy) { p.Consent = UpdateConsentOff }) }, "UPDATES_OFF"},
		{"updates are paused", func(f *stepFixture) { f.setPolicy(func(p *UpdatePolicy) { p.Paused = true }) }, "UPDATES_PAUSED"},
		{"vectory pause holds the host", func(f *stepFixture) { f.pauseHost() }, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newStepFixture(t)
			fork := f.newFork()
			f.stageEvidence(fork.release)
			c.hold(f)
			before := f.keepsNow()
			request := seeFile(t, UpdateExchangeFor(f.stateDir).Request)

			f.mustRun()

			f.requireNoForkRecorded()
			if c.code != "" {
				f.requireAnswered(fork.release, UpdateOutcomeRefused, c.code)
				f.requireUnchanged(before.machineSnapshot)
				return
			}
			f.requestWaitsUntouched(before.machineSnapshot, request)

			// Resumed, the same request is decided, and the fork is recorded.
			f.resumeHost()
			f.clock.advance(30 * time.Second)
			f.mustRun()
			f.requireOnlyTheForkWasRecorded(fork.release, fork.conflict, before)
		})
	}
}

// What the early look finds that isn't a fork changes nothing: the request waits as it
// did, and is decided at its turn by the verification that always ran there.
func TestARequestThatDoesNotForkWaitsAsItDidAndIsDecidedAtItsTurn(t *testing.T) {
	other := testPrivateKey(t, 21)
	otherKey := testPublicKey(t, other, "someone else")
	for _, c := range []struct {
		name    string
		policy  func(*UpdatePolicy)
		release func(f *stepFixture) *fakeRelease
		// code is how the step answers when it is a person's turn (apply), "" when the
		// release is taken.
		code string
	}{
		{"a release that verifies, for an ask host", func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk },
			func(f *stepFixture) *fakeRelease { return f.newRelease("0.1.1", "good", releaseOptions{}) }, ""},
		{"a release that verifies, for a host whose window is closed", func(p *UpdatePolicy) { p.Windows = []string{"daily 03:00-04:00 UTC"} },
			func(f *stepFixture) *fakeRelease { return f.newRelease("0.1.1", "good", releaseOptions{}) }, ""},
		{"a release signed by a key the host doesn't pin", func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk },
			func(f *stepFixture) *fakeRelease {
				return f.newRelease("0.1.1", "good", releaseOptions{signer: &other, signerKey: &otherKey})
			}, "KEY_NOT_PINNED"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newStepFixture(t)
			f.setPolicy(c.policy)
			release := c.release(f)
			f.stage(release)
			before := f.keepsNow()
			request := seeFile(t, UpdateExchangeFor(f.stateDir).Request)

			f.mustRun()

			f.requestWaitsUntouched(before.machineSnapshot, request)
			f.requireNoForkRecorded()

			// At its turn the request is decided as it always was.
			f.applyNow()
			if c.code == "" {
				f.requireAnswered(release, UpdateOutcomeCommitted, "")
				return
			}
			f.requireAnswered(release, outcomeOf(c.code, true), c.code)
			f.requireUnchanged(before.machineSnapshot)
		})
	}
}

// The step takes nothing the agent says: what it records it finds itself, in statements
// that verify under a key the host pins, in the manifest the request names.
func TestTheStepRecordsAForkOnlyWhenItFindsOneItselfInStatementsAPinnedKeySigned(t *testing.T) {
	other := testPrivateKey(t, 21)
	for _, c := range []struct {
		name string
		// stage stages what the agent handed over, and returns the release.
		stage func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease
		// code is how an automatic host answers the request when the early look finds no
		// fork and the request goes on to its turn, "" when that leaves it unanswered.
		code string
	}{
		{"two statements the pinned key didn't sign", func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease {
			unsignedB := statementNotSignedBy(t, f.public, fork.keyB, fork.c)
			unsignedC := statementNotSignedBy(t, f.public, fork.keyC, fork.b)
			release := f.newRelease("0.1.1", "good", releaseOptions{signer: &fork.b, signerKey: &fork.keyB, rollovers: []RolloverEnvelope{unsignedB, unsignedC}})
			f.stageEvidence(release)
			return release
		}, "KEY_NOT_PINNED"},
		{"two statements that name one successor", func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease {
			release := f.newRelease("0.1.1", "good", releaseOptions{signer: &fork.b, signerKey: &fork.keyB, rollovers: []RolloverEnvelope{fork.toB, fork.toB}})
			f.stageEvidence(release)
			return release
		}, ""},
		{"two statements from a key the host doesn't pin", func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease {
			fromOtherToB, err := SignRollover(other, fork.keyB, f.start.Add(-time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			fromOtherToC, err := SignRollover(other, fork.keyC, f.start.Add(-time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			release := f.newRelease("0.1.1", "good", releaseOptions{signer: &fork.b, signerKey: &fork.keyB, rollovers: []RolloverEnvelope{fromOtherToB, fromOtherToC}})
			f.stageEvidence(release)
			return release
		}, "KEY_NOT_PINNED"},
		{"a release.json that isn't the manifest the request names", func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease {
			dir := f.stage(fork.release)
			f.host.writeAsAccount(filepath.Join(dir, UpdateReleaseFile), []byte("not the manifest"), f.clock.Now())
			return fork.release
		}, "MANIFEST_INVALID"},
		{"a rollovers.json that isn't a list of statements", func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease {
			dir := f.stage(fork.release)
			f.host.writeAsAccount(filepath.Join(dir, UpdateRolloversFile), []byte(`{"not":"statements"}`), f.clock.Now())
			return fork.release
		}, "MANIFEST_INVALID"},
		{"evidence whose signature file isn't there", func(t *testing.T, f *stepFixture, fork stepFork) *fakeRelease {
			f.stageEvidence(fork.release)
			dir, err := UpdateExchangeFor(f.stateDir).IncomingDir(fork.release.manifestSHA())
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(dir, UpdateSignaturesFile)); err != nil {
				t.Fatal(err)
			}
			return fork.release
		}, ""},
	} {
		// An ask host leaves the request waiting; an automatic host goes on to its turn.
		for _, consent := range []string{UpdateConsentAsk, UpdateConsentAuto} {
			t.Run(c.name+", "+consent, func(t *testing.T) {
				f := newStepFixture(t)
				f.setPolicy(func(p *UpdatePolicy) { p.Consent = consent })
				release := c.stage(t, f, f.newFork())
				before := f.keepsNow()
				request := seeFile(t, UpdateExchangeFor(f.stateDir).Request)

				f.mustRun()

				f.requireNoForkRecorded()
				if consent == UpdateConsentAsk || c.code == "" {
					f.requestWaits(before.machineSnapshot, request)
					return
				}
				f.requireAnswered(release, outcomeOf(c.code, true), c.code)
				f.requireUnchanged(before.machineSnapshot)
			})
		}
	}
}

// What the step recorded is what keeps the host frozen: a good release signed by one of
// the two successors, with the one statement that hands the key over, verifies for a host
// that never saw the fork, and is refused by the agent and by the step for a host that
// did, until the host is pinned again.
func TestAfterTheStepRecordedAForkALaterOfferWithOneStatementIsRefusedUntilTheHostIsPinnedAgain(t *testing.T) {
	f := newStepFixture(t)
	fork := f.newFork()
	f.stageEvidence(fork.release)
	f.mustRun()
	f.requireAnswered(fork.release, UpdateOutcomeRefused, "KEY_ROLLOVER_CONFLICT")
	frozenFloors := maps.Clone(f.counters().HighestCounters)

	later := f.newRelease("0.1.2", "good", releaseOptions{counter: 9, signer: &fork.b, signerKey: &fork.keyB, rollovers: []RolloverEnvelope{fork.toB}})
	if _, err := VerifyRelease(VerifyInput{
		Manifest: later.manifest, Signatures: later.signature, Rollovers: later.rollovers, Pins: f.policy().PinnedKeys(), Floors: frozenFloors,
		Now: f.clock.Now(), RunningVersion: "0.1.0", OS: runtime.GOOS, Arch: runtime.GOARCH, Track: UpdateTrackPatch, ServiceDefinition: 1,
	}); err != nil {
		t.Fatalf("the later release doesn't verify for a host that saw no fork, so this proves nothing: %v", err)
	}

	// The agent reads the record from the step's status, and the step from its own file.
	if conflict := ReadUpdateView(f.stateDir, f.clock.Now()).Conflict(); conflict == nil || *conflict != *fork.conflict {
		t.Fatalf("the agent's view of the host: %+v, want %+v", conflict, fork.conflict)
	}
	executable := f.executableDigest()
	f.clock.advance(time.Hour)
	f.stage(later)
	f.mustRun()
	f.requireAnswered(later, UpdateOutcomeRefused, "KEY_ROLLOVER_CONFLICT")
	if f.executableDigest() != executable {
		t.Fatal("a frozen host took an update")
	}

	// Pinned again, as setup does it: the record goes and the floors stay.
	recovery := testPrivateKey(t, 40)
	recoveryKey := testPublicKey(t, recovery, "recovery")
	f.setPolicy(func(p *UpdatePolicy) { p.Keys = []PinnedKey{{Key: recoveryKey, PinnedAt: f.clock.Now()}} })
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	if got := f.counters(); got.RolloverConflict != nil || !maps.Equal(got.HighestCounters, frozenFloors) {
		t.Fatalf("after pinning again: %+v, want no fork and the floors %v", got, frozenFloors)
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	if conflict := ReadUpdateView(f.stateDir, f.clock.Now()).Conflict(); conflict != nil {
		t.Errorf("the host is still frozen after it was pinned again: %+v", conflict)
	}
}

// The record is on disk before the step answers: a kill between the two leaves the fork,
// and the next run, which finds the same request, answers it and changes nothing else.
func TestKillingTheStepAfterItRecordedAForkLeavesTheRecordAndTheNextRunAnswersTheRequest(t *testing.T) {
	f := newStepFixture(t)
	fork := f.newFork()
	f.stageEvidence(fork.release)
	before := f.keepsNow()

	if !f.runChildUntil("fork:recorded") {
		t.Fatal("the step never reached the end of its look at the offer")
	}
	if got := f.counters().RolloverConflict; got == nil || *got != *fork.conflict {
		t.Fatalf("the fork on disk at the kill: %+v", got)
	}
	if _, found := f.journal(); found {
		t.Fatal("the step made a journal for a request it only looked at")
	}
	killed, err := os.Stat(f.paths.Counters)
	if err != nil {
		t.Fatal(err)
	}

	f.clock.advance(30 * time.Second)
	f.mustRun()

	f.requireOnlyTheForkWasRecorded(fork.release, fork.conflict, before)
	// The fork that was already on disk is not written again.
	if now, err := os.Stat(f.paths.Counters); err != nil || !os.SameFile(killed, now) || !killed.ModTime().Equal(now.ModTime()) {
		t.Errorf("counters.json was written again for a fork it already held: %v", err)
	}
}
