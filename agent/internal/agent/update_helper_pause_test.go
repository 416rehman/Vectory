//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// `vectory pause` means "change nothing on this host", updates included. The update
// step's timer runs honor it: a request that is already staged waits, it is never
// refused, and nothing on the host changes until the host is resumed. A person at the
// keyboard is the consent itself, so apply goes on.

// pauseMarker is the file `vectory pause` leaves in the agent's state directory.
func (f *stepFixture) pauseMarker() string { return filepath.Join(f.stateDir, localPauseMarker) }

// pauseHost holds the host the way `sudo vectory pause` does: a file in the state
// directory that root owns.
func (f *stepFixture) pauseHost() {
	f.t.Helper()
	if err := os.WriteFile(f.pauseMarker(), []byte("local emergency pause\n"), 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *stepFixture) resumeHost() {
	f.t.Helper()
	if err := os.RemoveAll(f.pauseMarker()); err != nil {
		f.t.Fatal(err)
	}
}

// requestWaits says a request is where the agent wrote it and the step has answered
// nothing and changed nothing: the host is as it was.
func (f *stepFixture) requestWaits(before machineSnapshot, request fileSeen) {
	f.t.Helper()
	if status := f.status(); status.Last != nil || status.Stage != UpdateStageIdle || status.Eligibility != UpdateEligible {
		f.t.Fatalf("a request that waits left this status: %+v (last %+v)", status, status.Last)
	}
	f.requireUnchanged(before)
	if got := seeFile(f.t, UpdateExchangeFor(f.stateDir).Request); got.inode != request.inode || string(got.data) != string(request.data) {
		f.t.Error("the request was taken or rewritten")
	}
}

// requestWaitsUntouched is requestWaits for a request the step never began to prepare:
// not a byte of its build was copied, run or looked at.
func (f *stepFixture) requestWaitsUntouched(before machineSnapshot, request fileSeen) {
	f.t.Helper()
	f.requestWaits(before, request)
	if len(f.host.probeCalls) != 0 {
		f.t.Errorf("a build was probed while the host was paused: %v", f.host.probeCalls)
	}
}

func TestAStagedUpdateWaitsWhileVectoryPauseHoldsTheHostAndIsAppliedOnceItIsResumed(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	f.pauseHost()
	before := f.snapshot()
	request := seeFile(t, UpdateExchangeFor(f.stateDir).Request)

	// Run after run, as the timer does, for as long as the host is paused.
	for i := 0; i < 4; i++ {
		f.clock.advance(30 * time.Second)
		f.mustRun()
		f.requestWaitsUntouched(before, request)
	}

	// The host says what it waits for, in the words of `vectory update status`.
	view := ReadUpdateView(f.stateDir, f.clock.Now())
	if !view.LocalPaused || !strings.Contains(view.Headline(), "paused with vectory pause: sudo vectory resume") {
		t.Errorf("the host's own account of itself: %q", view.Headline())
	}

	// Resumed, the next run applies the same request: the pause decided nothing about the release.
	f.resumeHost()
	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	if f.executableDigest() != release.buildSHA() {
		t.Error("the update wasn't applied once the host was resumed")
	}
}

// What the marker is doesn't matter: a pause that can't be shown not to be is a pause,
// as the agent's own check counts it, and nothing the step finds there is followed.
func TestAMarkerThatIsNotAnOrdinaryFileStillHoldsTheHost(t *testing.T) {
	somewhere := func(f *stepFixture) string {
		path := filepath.Join(f.root, "somewhere-else")
		if err := os.WriteFile(path, []byte("not the marker"), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	for name, leave := range map[string]func(f *stepFixture, marker string){
		"an empty file": func(f *stepFixture, marker string) { writeMode(t, marker, "", 0o600) },
		"a file the service account owns": func(f *stepFixture, marker string) {
			f.host.writeAsAccount(marker, []byte("local emergency pause\n"), f.clock.Now())
		},
		"a directory": func(f *stepFixture, marker string) { mkdirMode(t, marker, 0o700) },
		"a directory with files in it": func(f *stepFixture, marker string) {
			mkdirMode(t, marker, 0o700)
			writeMode(t, filepath.Join(marker, "x"), "x", 0o600)
		},
		"a link to nothing": func(f *stepFixture, marker string) {
			if err := os.Symlink(filepath.Join(f.root, "nowhere"), marker); err != nil {
				t.Fatal(err)
			}
		},
		"a link to a file": func(f *stepFixture, marker string) {
			if err := os.Symlink(somewhere(f), marker); err != nil {
				t.Fatal(err)
			}
		},
		"a named pipe": func(f *stepFixture, marker string) {
			if err := mkfifo(marker); err != nil {
				t.Fatal(err)
			}
		},
		"a file that is readable by nobody": func(f *stepFixture, marker string) { writeMode(t, marker, "x", 0o000) },
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			leave(f, f.pauseMarker())
			before := f.snapshot()
			request := seeFile(t, UpdateExchangeFor(f.stateDir).Request)

			f.runWithTimeout()

			f.requestWaitsUntouched(before, request)
		})
	}
}

func TestApplyGoesOnWhileVectoryPauseHoldsTheHost(t *testing.T) {
	f := newStepFixture(t)
	f.setPolicy(func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk })
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	f.pauseHost()

	// The timer's run waits, and apply, which is a person at the keyboard, applies.
	f.mustRun()
	if f.status().Last != nil {
		t.Fatalf("the timer's run answered a request on a paused host: %+v", f.status().Last)
	}
	if err := ApplyStagedUpdate(bg(), f.stateDir, false, nil); err != nil {
		t.Fatal(err)
	}
	f.requireAnswered(release, UpdateOutcomeCommitted, "")
	if f.executableDigest() != release.buildSHA() {
		t.Error("apply didn't apply the update")
	}
}

// A pause that begins while the step prepares an update is honored before anything
// stops: the request waits where it was, as if the step hadn't started.
func TestAPauseThatBeginsWhileTheStepPreparesIsHonouredBeforeAnythingStops(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	before := f.snapshot()
	request := seeFile(t, UpdateExchangeFor(f.stateDir).Request)
	paused := false
	updateFault = func(point string) {
		// After the build is probed and staged, before the floor is raised.
		if point == "snapshot" && !paused {
			paused = true
			f.pauseHost()
		}
	}

	f.mustRun()

	if !paused {
		t.Fatal("the step never reached the end of its preparation")
	}
	f.requestWaits(before, request)
	if floors := f.counters().HighestCounters; floors[f.public.Fingerprint()] != 0 {
		t.Errorf("a floor was raised for an update that waits: %v", floors)
	}

	updateFault = nil
	f.resumeHost()
	f.clock.advance(30 * time.Second)
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeCommitted, "")
}

// A pause is a decision about nothing that is already under way: a build that is being
// tried finishes its trial, and one that is being taken back is taken back.
func TestVectoryPauseDoesNotInterruptAnUpdateThatHasSwapped(t *testing.T) {
	for _, row := range []struct {
		name, behavior, killedAt string
		outcome, code            string
	}{
		{"a trial", "good", "trial", UpdateOutcomeCommitted, ""},
		{"a rollback", "crash", "rolling_back", UpdateOutcomeRolledBack, "START_FAILED"},
	} {
		t.Run(row.name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", row.behavior, releaseOptions{})
			f.stage(release)
			if !f.runChildUntil(row.killedAt) {
				t.Fatalf("an update never reached %s", row.killedAt)
			}
			f.pauseHost()
			f.clock.advance(30 * time.Second)

			f.mustRun()

			f.requireAnswered(release, row.outcome, row.code)
		})
	}
}
