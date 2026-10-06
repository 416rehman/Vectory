package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// What happens to a staged build when the offer changes, is withdrawn, or the
// host is busy or paused, and how the agent tells the privileged step it is done.

func (r *offerRig) stageIt() {
	r.t.Helper()
	r.settle()
	r.poll()
	if beat := r.beat(); beat["state"] != "staged" {
		r.t.Fatalf("the build didn't get staged: %v", beat)
	}
}

func TestAWithdrawnOfferDeletesWhatWasStaged(t *testing.T) {
	rig := newOfferRig(t)
	rig.stageIt()
	rig.withdraw()
	rig.poll()
	if got := rig.staged(); len(got) != 0 {
		t.Fatalf("what was staged is still there: %v", got)
	}
	if _, err := os.Lstat(rig.exchange().Request); !os.IsNotExist(err) {
		t.Fatalf("the request is still there: %v", err)
	}
	rig.poll()
	if beat := rig.beat(); beat["state"] != "idle" || beat["release"] != nil {
		t.Fatalf("a host whose offer was withdrawn reports %v", beat)
	}
	if !rig.said1("The server no longer offers agent update " + rig.defaultVersion + ". What was staged for it is deleted.") {
		t.Fatalf("the log said %q", rig.said)
	}
	if health, err := ReadUpdateHealth(rig.exchange().Health); err != nil || health.Offer != "" {
		t.Fatalf("health.json says the manifest offers %q (%v)", health.Offer, err)
	}
	// What the agent deleted is only what it had staged: nothing else of the state.
	if _, err := os.Lstat(rig.exchange().Health); err != nil {
		t.Fatalf("health.json went with it: %v", err)
	}
}

// The step started on a build: the agent leaves it alone, whatever the manifest
// says, and deletes it once the step has a result for it.
func TestAWithdrawnOfferKeepsWhatTheStepStartedOnUntilItHasAResult(t *testing.T) {
	rig := newOfferRig(t)
	rig.stageIt()
	rig.step(func(s *UpdateStatus) {
		s.Stage, s.Release, s.FromVersion, s.ToVersion = UpdateStageSwapping, rig.releaseSHA, rig.e.State.Agent.Version, rig.defaultVersion
	})
	rig.withdraw()
	rig.poll()
	rig.poll()
	if got := rig.staged(); !slices.Equal(got, []string{rig.releaseSHA}) {
		t.Fatalf("the step is applying this build and the agent touched it: %v", got)
	}
	if _, err := ReadUpdateRequest(rig.exchange().Request); err != nil {
		t.Fatal(err)
	}
	if beat := rig.beat(); beat["state"] != "applying" || beat["release"] != rig.releaseSHA {
		t.Fatalf("the host reports %v", beat)
	}

	// The step ends: committed, and idle.
	rig.step(func(s *UpdateStatus) {
		s.Last = &UpdateLast{Release: rig.releaseSHA, Outcome: UpdateOutcomeCommitted, At: time.Now().UTC().Truncate(time.Second), FromVersion: rig.e.State.Agent.Version, ToVersion: rig.defaultVersion}
	})
	rig.poll()
	if got := rig.staged(); len(got) != 0 {
		t.Fatalf("the step has its result and the staged build is still there: %v", got)
	}
	if _, err := os.Lstat(rig.exchange().Request); !os.IsNotExist(err) {
		t.Fatalf("the request is still there: %v", err)
	}
	rig.poll()
	beat := rig.beat()
	last, _ := beat["last"].(map[string]any)
	if beat["state"] != "idle" || last == nil || last["outcome"] != "committed" || last["release"] != rig.releaseSHA {
		t.Fatalf("the host reports %v", beat)
	}
}

// A release the step has a result for is never staged again: a failed or refused
// one isn't covered by the host's counter floor, but the host has done with it.
func TestAReleaseTheStepHasAResultForIsNotStagedAgain(t *testing.T) {
	for _, outcome := range []struct{ outcome, code string }{
		{UpdateOutcomeFailed, "PROBE_FAILED"}, {UpdateOutcomeRefused, "UNTRUSTED_LOCATION"}, {UpdateOutcomeFailed, "DISK_FULL"},
	} {
		t.Run(outcome.outcome+" "+outcome.code, func(t *testing.T) {
			rig := newOfferRig(t)
			rig.stageIt()
			requests := rig.requests()
			rig.step(func(s *UpdateStatus) {
				s.Last = &UpdateLast{Release: rig.releaseSHA, Outcome: outcome.outcome, Code: outcome.code, At: time.Now().UTC().Truncate(time.Second), FromVersion: rig.e.State.Agent.Version, ToVersion: rig.defaultVersion}
			})
			for i := 0; i < 3; i++ {
				rig.poll()
			}
			if got := rig.staged(); len(got) != 0 || rig.requests() != requests || rig.e.update.download != nil {
				t.Fatalf("the release was staged again: %v, %d requests", got, rig.requests())
			}
			if _, err := os.Lstat(rig.exchange().Request); !os.IsNotExist(err) {
				t.Fatalf("a request for it was written again: %v", err)
			}
			beat := rig.beat()
			last, _ := beat["last"].(map[string]any)
			if beat["state"] != "idle" || last == nil || last["outcome"] != outcome.outcome || last["code"] != outcome.code {
				t.Fatalf("the host reports %v", beat)
			}
			// The next release is another matter.
			rig.build = append(bytes.Clone(rig.build), "next"...)
			rig.release(func(m *ReleaseManifest) {
				m.Version, m.Counter = rig.followingVersion, 8
				m.Artifacts = []ReleaseArtifact{platformArtifact(rig.build, rig.followingVersion)}
			})
			rig.stageIt()
		})
	}
}

func TestAChangedOfferReplacesWhatWasStaged(t *testing.T) {
	rig := newOfferRig(t)
	rig.stageIt()
	first := rig.releaseSHA
	rig.build = append(bytes.Clone(rig.build), "next"...)
	rig.release(func(m *ReleaseManifest) {
		m.Version, m.Counter = rig.followingVersion, 8
		m.Artifacts = []ReleaseArtifact{platformArtifact(rig.build, rig.followingVersion)}
	})
	rig.stageIt()
	if got := rig.staged(); !slices.Equal(got, []string{rig.releaseSHA}) || rig.releaseSHA == first {
		t.Fatalf("what is staged is %v", got)
	}
	request, err := ReadUpdateRequest(rig.exchange().Request)
	if err != nil || request.ManifestSHA256 != rig.releaseSHA {
		t.Fatalf("the request is %+v (%v)", request, err)
	}
}

// ---------------------------------------------------------------- deferral

func TestWhileAConfigurationApplyIsInProgressNothingIsStarted(t *testing.T) {
	rig := newOfferRig(t)
	journal := filepath.Join(rig.state, "journal.json")
	if err := os.WriteFile(journal, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		_ = rig.e.Poll(t.Context())
	}
	if rig.requests() != 0 || rig.e.update.download != nil {
		t.Fatalf("a build was asked for during an apply: %d requests", rig.requests())
	}
	if beat := rig.beat(); beat["state"] != "idle" || beat["code"] != nil {
		t.Fatalf("a deferred offer is no state: the host reports %v", beat)
	}
	if err := os.Remove(journal); err != nil {
		t.Fatal(err)
	}
	rig.stageIt()
}

// Progress between the start of an apply and its outcome defers too: the apply
// itself finishes before an offer is looked at, so this is the unit.
func TestProgressOfAnApplyDefersAnOffer(t *testing.T) {
	rig := newOfferRig(t)
	facts := rig.e.readUpdateFacts()
	for _, state := range []string{"desired", "downloaded", "validated", "written", "reload_requested"} {
		rig.e.State.ApplyState = state
		if !rig.e.updateDeferred(facts, nil) {
			t.Errorf("an apply that is %s doesn't defer an offer", state)
		}
	}
	for _, state := range []string{"verified_applied", "failed", "rolled_back", "unmanaged", "verification_unknown"} {
		rig.e.State.ApplyState = state
		if rig.e.updateDeferred(facts, nil) {
			t.Errorf("an apply that is %s defers an offer", state)
		}
	}
}

func TestAStagedBuildIsLeftAloneWhileTheHostIsBusy(t *testing.T) {
	rig := newOfferRig(t)
	rig.stageIt()
	if err := os.WriteFile(filepath.Join(rig.state, "journal.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		_ = rig.e.Poll(t.Context())
	}
	if beat := rig.beat(); beat["state"] != "staged" || rig.requests() != 1 {
		t.Fatalf("the host reports %v after %d requests", beat, rig.requests())
	}
	if _, err := ReadUpdateRequest(rig.exchange().Request); err != nil {
		t.Fatal(err)
	}
}

func TestWhileTheStepIsBusyNothingIsStarted(t *testing.T) {
	for _, stage := range []string{UpdateStagePreparing, UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack} {
		t.Run(stage, func(t *testing.T) {
			rig := newOfferRig(t)
			other := strings.Repeat("9", 64)
			rig.step(func(s *UpdateStatus) {
				s.Stage, s.Release, s.FromVersion, s.ToVersion = stage, other, "0.0.9", "0.1.0"
				if stage == UpdateStageTrial {
					s.Deadline = time.Now().UTC().Add(4 * time.Minute).Truncate(time.Second)
				}
			})
			rig.poll()
			rig.poll()
			if rig.requests() != 0 || len(rig.staged()) != 0 {
				t.Fatalf("a build was staged while the step works on another: %d requests, %v", rig.requests(), rig.staged())
			}
			want := "applying"
			if stage == UpdateStageTrial {
				want = "trial"
			}
			if beat := rig.beat(); beat["state"] != want || beat["release"] != other {
				t.Fatalf("the host reports %v", beat)
			}
		})
	}
}

func TestAnUnansweredCheckOnRequestDefersAndAnAnsweredOneDoesNot(t *testing.T) {
	rig := newOfferRig(t)
	request := &ValidationRequest{ID: checkID}
	if rig.e.deviceCheckOpen(nil) {
		t.Fatal("no check, and a check is open")
	}
	if !rig.e.deviceCheckOpen(request) {
		t.Fatal("a check nobody answered isn't open")
	}
	rig.e.validation.pending = &ValidationResult{ID: checkID}
	if rig.e.deviceCheckOpen(request) {
		t.Fatal("a check with its result pending is still open")
	}
	rig.e.validation.pending = nil
	rig.e.rememberValidation(checkID)
	if rig.e.deviceCheckOpen(request) {
		t.Fatal("a check that was delivered is still open")
	}
	if !rig.e.deviceCheckOpen(&ValidationRequest{ID: checkID2}) {
		t.Fatal("another check is not open")
	}
}

func TestAPauseOnTheHostStopsEveryDownloadAndKeepsWhatIsStaged(t *testing.T) {
	for name, pause := range map[string]struct{ on, off func(*offerRig) }{
		"vectory update pause": {
			func(r *offerRig) { r.policy(func(p *UpdatePolicy) { p.Paused = true }) },
			func(r *offerRig) { r.policy(func(p *UpdatePolicy) { p.Paused = false }) },
		},
		"vectory pause": {
			func(r *offerRig) {
				if err := SetPause(r.state, true); err != nil {
					t.Fatal(err)
				}
			},
			func(r *offerRig) {
				if err := SetPause(r.state, false); err != nil {
					t.Fatal(err)
				}
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			pause.on(rig)
			for i := 0; i < 3; i++ {
				rig.poll()
			}
			if rig.requests() != 0 || rig.e.update.download != nil {
				t.Fatalf("a paused host asked for the build %d times", rig.requests())
			}
			beat := rig.beat()
			if beat["state"] != "idle" || beat["code"] != "UPDATES_PAUSED" || beat["release"] != nil {
				t.Fatalf("a paused host reports %v", beat)
			}
			if _, err := os.Lstat(rig.exchange().Request); !os.IsNotExist(err) {
				t.Fatalf("a request was written: %v", err)
			}
			// Resumed: it goes on where it was.
			pause.off(rig)
			rig.stageIt()
			// And paused again with a build staged: the stage stays, the host
			// says it is paused, and resuming needs no new transfer.
			pause.on(rig)
			rig.poll()
			rig.poll()
			if got := rig.staged(); !slices.Equal(got, []string{rig.releaseSHA}) {
				t.Fatalf("a pause deleted what was staged: %v", got)
			}
			if beat := rig.beat(); beat["code"] != "UPDATES_PAUSED" || beat["state"] != "idle" {
				t.Fatalf("a paused host reports %v", beat)
			}
			pause.off(rig)
			rig.poll()
			rig.poll()
			if beat := rig.beat(); beat["state"] != "staged" || rig.requests() != 1 {
				t.Fatalf("the host reports %v after %d requests", beat, rig.requests())
			}
		})
	}
}

func TestAPauseEndsATransferInProgress(t *testing.T) {
	rig := newOfferRig(t)
	started := make(chan struct{})
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000000")
		_, _ = w.Write(rig.build[:100])
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	})
	rig.poll()
	<-started
	rig.policy(func(p *UpdatePolicy) { p.Paused = true })
	rig.poll()
	if rig.e.update.download != nil {
		t.Fatal("the transfer went on after the pause")
	}
	rig.neverLeftAFileUnderAFinalName()
}

// ---------------------------------------------------------------- the order of things

// orderDriver records when the configuration was activated.
type orderDriver struct {
	*candidateDriver
	mu     *sync.Mutex
	events *[]string
}

func (d orderDriver) Activate(ctx context.Context, path string) error {
	d.mu.Lock()
	*d.events = append(*d.events, "apply")
	d.mu.Unlock()
	return d.candidateDriver.Activate(ctx, path)
}

// An offer and a configuration apply in one check-in: the apply finishes first,
// and the build is asked for after it.
func TestAnOfferAndAConfigurationApplyInOneCheckInTheApplyFinishesFirst(t *testing.T) {
	rig := newOfferRig(t)
	var mu sync.Mutex
	var events []string
	rig.e.Driver = orderDriver{candidateDriver: rig.driver, mu: &mu, events: &events}
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		events = append(events, "download")
		mu.Unlock()
		rig.sendBuild(w, r)
	})
	// The same manifest carries a new configuration and the offer.
	rig.plane.offer("/agent/v1/artifacts/"+Digest(newConfig), newConfig)
	rig.plane.with(func(m *Manifest) {
		m.Generation++
		m.Desired = &Desired{VersionID: "v2", SHA256: Digest(newConfig), Size: int64(len(newConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(newConfig), VectorVersion: VectorVersion}
	})
	rig.poll()
	if rig.e.State.ApplyState != "verified_applied" || rig.e.actual() != Digest(newConfig) {
		t.Fatalf("the configuration wasn't applied: %s", rig.e.State.ApplyState)
	}
	rig.settle()
	rig.poll()
	mu.Lock()
	got := slices.Clone(events)
	mu.Unlock()
	if !slices.Equal(got, []string{"apply", "download"}) {
		t.Fatalf("the order of things was %v", got)
	}
	if beat := rig.beat(); beat["state"] != "staged" {
		t.Fatalf("the host reports %v", beat)
	}
	// The configuration is what the offer found it.
	data, err := os.ReadFile(rig.managed)
	if err != nil || !bytes.Equal(data, newConfig) {
		t.Fatalf("%v", err)
	}
}

// An apply that is still in flight when the offer is looked at makes the build
// wait for the next check-in.
func TestAnApplyThatIsNotDoneMakesTheBuildWait(t *testing.T) {
	rig := newOfferRig(t)
	rig.e.State.ApplyState = "written" // as an apply that stopped at a boundary leaves it
	_ = rig.e.Poll(t.Context())
	if rig.requests() != 0 {
		t.Fatalf("a build was asked for while an apply was in progress")
	}
	rig.e.State.ApplyState = "verified_applied"
	rig.stageIt()
}

// ---------------------------------------------------------------- what the report says

func TestTheReportsOfAFullRunInOrder(t *testing.T) {
	rig := newOfferRig(t)
	var states []string
	seen := func() {
		beat := rig.beat()
		state, _ := beat["state"].(string)
		if len(states) == 0 || states[len(states)-1] != state {
			states = append(states, state)
		}
	}
	rig.poll()
	seen()
	rig.settle()
	seen()
	rig.poll()
	seen()
	rig.step(func(s *UpdateStatus) {
		s.Stage, s.Release, s.FromVersion, s.ToVersion = UpdateStageSwapping, rig.releaseSHA, rig.e.State.Agent.Version, rig.defaultVersion
	})
	rig.poll()
	seen()
	rig.step(func(s *UpdateStatus) {
		s.Stage, s.Release, s.FromVersion, s.ToVersion, s.Deadline = UpdateStageTrial, rig.releaseSHA, rig.e.State.Agent.Version, rig.defaultVersion, time.Now().UTC().Add(5*time.Minute).Truncate(time.Second)
	})
	rig.poll()
	seen()
	rig.step(func(s *UpdateStatus) {
		s.Last = &UpdateLast{Release: rig.releaseSHA, Outcome: UpdateOutcomeCommitted, At: time.Now().UTC().Truncate(time.Second), FromVersion: rig.e.State.Agent.Version, ToVersion: rig.defaultVersion}
	})
	rig.poll()
	rig.poll()
	seen()
	want := []string{"idle", "downloading", "staged", "applying", "trial", "idle"}
	if !slices.Equal(states, want) {
		t.Fatalf("the host reported %v, want %v", states, want)
	}
	// Every heartbeat on the way was a member the server accepts.
	for _, body := range rig.plane.rawBodies() {
		var beat struct {
			AgentUpdate json.RawMessage `json:"agent_update"`
		}
		if err := json.Unmarshal(body, &beat); err != nil {
			t.Fatal(err)
		}
		if len(beat.AgentUpdate) == 0 {
			continue
		}
		if err := validateAgentUpdateMember(beat.AgentUpdate); err != nil {
			t.Fatalf("%v: %s", err, beat.AgentUpdate)
		}
	}
	_ = runtime.GOOS
}

// A change in where an update stands is for the server to hear at once: the run
// loop checks in again soon, once, and not for a state that stays.
func TestAChangeInTheStateOfAnUpdateAsksForOneFollowUpCheckIn(t *testing.T) {
	rig := newOfferRig(t)
	rig.poll()
	if !rig.e.update.unreported {
		t.Fatal("a build began downloading and the run loop isn't told to check in")
	}
	rig.poll() // the heartbeat that reports it
	if rig.e.update.unreported && rig.e.update.decision.state == UpdateStateDownloading && rig.e.update.download != nil && !rig.e.update.download.finished() {
		t.Fatal("the same state asks for a follow-up again")
	}
	rig.settle()
	rig.poll()
	rig.poll()
	rig.poll()
	if rig.e.update.unreported {
		t.Fatal("a state that stays still asks for follow-ups")
	}
}

// A server that doesn't list the feature gets no follow-ups either.
func TestAServerWithoutTheFeatureGetsNoFollowUps(t *testing.T) {
	rig := newOfferRig(t)
	rig.plane.with(func(m *Manifest) { m.Features = []string{featureValidation} })
	rig.poll() // learns that the feature is gone
	rig.poll()
	rig.poll()
	if rig.e.update.unreported {
		t.Fatal("the run loop is asked to check in about a report nobody gets")
	}
}
