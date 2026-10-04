package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// withLocalZone makes the host's time zone zone until the test ends: windows and
// the clock times a person reads are in it.
func withLocalZone(t *testing.T, zone *time.Location) {
	t.Helper()
	old := time.Local
	time.Local = zone
	t.Cleanup(func() { time.Local = old })
}

var viewNow = time.Date(2026, 10, 5, 20, 0, 0, 0, time.UTC) // a Monday evening

func viewPolicy(t *testing.T, consent string, windows ...string) UpdatePolicy {
	t.Helper()
	key, err := ParseReleaseKey("vectory-release-key ed25519 3n1kX5uZnEN2wf+ZrjTlfd3sqUPQff1ANP0I/elZz7o= team")
	if err != nil {
		t.Fatal(err)
	}
	return UpdatePolicy{Consent: consent, Track: UpdateTrackPatch, Windows: windows, Keys: []PinnedKey{{Key: key, PinnedAt: time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC)}}}
}

const teamShortID = "05cc6c02351af0cb"

func lastResult(outcome, code, from, to string) *UpdateLast {
	last := &UpdateLast{Release: strings.Repeat("a", 64), Outcome: outcome, Code: code, At: time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC), FromVersion: from, ToVersion: to}
	return last
}

func TestTheHeadlineSaysWhatNeedsAttentionFirst(t *testing.T) {
	withLocalZone(t, time.UTC)
	fork := &RolloverConflict{From: strings.Repeat("1", 64), To: [2]string{strings.Repeat("2", 64), strings.Repeat("3", 64)}}
	committed := lastResult(UpdateOutcomeCommitted, "", "0.1.0", "0.1.1")
	committed.At = time.Date(2026, 10, 5, 2, 14, 9, 0, time.UTC)
	ms := uint32(2100)
	committed.FirstCheckInMS = &ms
	for name, tc := range map[string]struct {
		view UpdateView
		want string
	}{
		"automatic, in its window's absence": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), Eligibility: UpdateEligible},
			"automatic · patch releases · any time · key " + teamShortID,
		},
		"automatic, outside its window": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto, "Mon-Fri 02:00-04:00 UTC"), Eligibility: UpdateEligible},
			"automatic · patch releases · Mon–Fri 02:00–04:00 UTC (next in 6 h) · key " + teamShortID,
		},
		"automatic, inside its window": {
			UpdateView{ReadAt: time.Date(2026, 10, 6, 3, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto, "Mon-Fri 02:00-04:00 UTC"), Eligibility: UpdateEligible},
			"automatic · patch releases · Mon–Fri 02:00–04:00 UTC (open now) · key " + teamShortID,
		},
		"off": {UpdateView{Policy: DefaultUpdatePolicy(), Eligibility: UpdateEligible}, "off on this host"},
		"off on an operating system whose updates are not in this release": {
			UpdateView{Policy: DefaultUpdatePolicy(), Eligibility: "PLATFORM_NOT_IN_RELEASE"},
			"not in this release for " + platformName(runtime.GOOS) + ": hosts of this kind update by hand",
		},
		"off in a package": {
			UpdateView{Policy: DefaultUpdatePolicy(), Eligibility: "PACKAGE_MANAGED"},
			"off on this host · installed from a package, so the package manager updates it",
		},
		"a policy that can't be used": {
			UpdateView{Policy: DefaultUpdatePolicy(), PolicyProblem: "/etc/vectory/updates is writable by its group (mode 0775)"},
			"off · the update policy can't be used: /etc/vectory/updates is writable by its group (mode 0775)",
		},
		"staged, waiting for you": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAsk), StepRunning: true, Eligibility: UpdateEligible, Staged: &StagedUpdate{Version: "0.1.1", Complete: true}},
			"staged 0.1.1, waiting for you: " + asAdmin("vectory update apply"),
		},
		"staged, waiting for you with a state directory of its own": {
			UpdateView{StateDir: "/srv/agent state", Policy: viewPolicy(t, UpdateConsentAsk), StepRunning: true, Staged: &StagedUpdate{Version: "0.1.1", Complete: true}},
			"staged 0.1.1, waiting for you: " + asAdmin("vectory update apply") + " --state-dir '/srv/agent state'",
		},
		"staged, waiting for its window": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto, "Mon-Fri 02:00-04:00 UTC"), StepRunning: true, Staged: &StagedUpdate{Version: "0.1.1", Complete: true}},
			"staged 0.1.1, waiting for its window (opens in 6 h)",
		},
		"staged, applied by the step within a minute": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Staged: &StagedUpdate{Version: "0.1.1", Complete: true}},
			"staged 0.1.1, the update step applies it within a minute",
		},
		"staged, with no step running": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), Staged: &StagedUpdate{Version: "0.1.1", Complete: true}},
			"staged 0.1.1, but the update step isn't running: " + asAdmin("vectory doctor") + " says why",
		},
		"a build that isn't complete is not staged": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Staged: &StagedUpdate{Version: "0.1.1"}},
			"automatic · patch releases · any time · key " + teamShortID,
		},
		"an update that committed": {
			UpdateView{ReadAt: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: committed}},
			"0.1.0 → 0.1.1 at 02:14 · first check-in 2.1 s after restart",
		},
		"an update that committed a while ago is no news": {
			UpdateView{ReadAt: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: committed}},
			"automatic · patch releases · any time · key " + teamShortID,
		},
		"a rollback is told until a newer result replaces it": {
			UpdateView{ReadAt: time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: lastResult(UpdateOutcomeRolledBack, "NO_CHECK_IN", "0.1.0", "0.1.1")}},
			"rolled back from 0.1.1 at 5 Oct 02:19: it didn't check in within 5 minutes; this host won't try 0.1.1 again",
		},
		"a rollback the same day": {
			UpdateView{ReadAt: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: lastResult(UpdateOutcomeRolledBack, "NO_CHECK_IN", "0.1.0", "0.1.1")}},
			"rolled back from 0.1.1 at 02:19: it didn't check in within 5 minutes; this host won't try 0.1.1 again",
		},
		"a rollback whose previous build didn't come back either": {
			UpdateView{ReadAt: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: lastResult(UpdateOutcomeRolledBack, "ROLLBACK_UNHEALTHY", "0.1.0", "0.1.1")}},
			"rolled back from 0.1.1 at 02:19, but the previous build isn't healthy either (it didn't report healthy within 5 minutes of its start, or it couldn't be put back): look at the agent's service and the update step's log, then at the network and the server; this host won't try 0.1.1 again",
		},
		"an update that failed before the swap": {
			UpdateView{ReadAt: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: lastResult(UpdateOutcomeFailed, "PROBE_FAILED", "0.1.0", "0.1.1")}},
			"couldn't update to 0.1.1 at 02:19: the new build didn't report the version and platform it was signed for",
		},
		"an update the step refused": {
			UpdateView{ReadAt: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, Last: lastResult(UpdateOutcomeRefused, "UNTRUSTED_LOCATION", "0.1.0", "")}},
			"refused an update at 02:19: a directory on its path can be changed by other accounts",
		},
		"an update being applied": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageSwapping, FromVersion: "0.1.0", ToVersion: "0.1.1"}},
			"applying 0.1.0 → 0.1.1",
		},
		"a build on trial": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageTrial, FromVersion: "0.1.0", ToVersion: "0.1.1", Deadline: time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC)}},
			"trying 0.1.1 (from 0.1.0) · ends by 02:19",
		},
		"a rollback in progress": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageRollingBack, FromVersion: "0.1.0", ToVersion: "0.1.1"}},
			"rolling back from 0.1.1",
		},
		"a rollback in progress with the agent's service running": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageRollingBack, FromVersion: "0.1.0", ToVersion: "0.1.1"},
				AgentService: &ServiceInfo{Manager: "service manager", Name: "vectory", Installed: true, State: "running", PID: 812}},
			"rolling back from 0.1.1",
		},
		// The journal says rolling_back for as long as the previous build can't be started,
		// and the step tries again every 30 seconds: what is true is said, and not that the
		// network or the server is at fault.
		"a rollback in progress with the agent's service not running": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageRollingBack, FromVersion: "0.1.0", ToVersion: "0.1.1"},
				AgentService: &ServiceInfo{Manager: "service manager", Name: "vectory", Installed: true, State: "stopped"}},
			"rolling back from 0.1.1 · the agent's service isn't running, and the update step is trying to start the previous build again (every 30 seconds until it can)",
		},
		"a build on trial whose service isn't running yet": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageTrial, FromVersion: "0.1.0", ToVersion: "0.1.1", Deadline: time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC)},
				AgentService: &ServiceInfo{Manager: "service manager", Name: "vectory", Installed: true, State: "stopped"}},
			"trying 0.1.1 (from 0.1.0) · ends by 02:19",
		},
		"a fork": {
			UpdateView{Policy: func() UpdatePolicy {
				p := viewPolicy(t, UpdateConsentAuto)
				fork.From = p.Keys[0].Key.Fingerprint()
				return p
			}(), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, RolloverConflict: fork}},
			"stopped · two successors of key " + teamShortID + " were seen, " + strings.Repeat("2", 16) + " and " + strings.Repeat("3", 16) + ": run the Upgrade agent command with the right key",
		},
		"a fork of a key that isn't pinned any more is over": {
			UpdateView{Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Status: &UpdateStatus{Stage: UpdateStageIdle, RolloverConflict: &RolloverConflict{From: strings.Repeat("9", 64), To: fork.To}}},
			"automatic · patch releases · any time · key " + teamShortID,
		},
		"paused": {
			UpdateView{Policy: func() UpdatePolicy { p := viewPolicy(t, UpdateConsentAuto); p.Paused = true; return p }(), StepRunning: true, Staged: &StagedUpdate{Version: "0.1.1", Complete: true}},
			"automatic · patch releases · any time · key " + teamShortID + " · paused: " + asAdmin("vectory update resume"),
		},
		"paused with vectory pause": {
			UpdateView{LocalPaused: true, Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true},
			"automatic · patch releases · any time · key " + teamShortID + " · paused with vectory pause: " + asAdmin("vectory resume"),
		},
		"the minor track and two windows": {
			UpdateView{Policy: func() UpdatePolicy {
				p := viewPolicy(t, UpdateConsentAsk, "Sat,Sun 06:00-07:30 UTC", "daily 01:00-03:00 UTC")
				p.Track = UpdateTrackMinor
				return p
			}(), ReadAt: time.Date(2026, 10, 5, 1, 30, 0, 0, time.UTC)},
			"ask on this host · minor and patch releases · Sat,Sun 06:00–07:30 UTC, daily 01:00–03:00 UTC (open now) · key " + teamShortID,
		},
	} {
		t.Run(name, func(t *testing.T) {
			if tc.view.ReadAt.IsZero() {
				tc.view.ReadAt = viewNow
			}
			if got := tc.view.Headline(); got != tc.want {
				t.Fatalf("\n%s\nwant\n%s", got, tc.want)
			}
		})
	}
}

func TestTheClockTimesAreInTheHostsOwnZone(t *testing.T) {
	withLocalZone(t, time.FixedZone("test", 2*3600))
	view := UpdateView{ReadAt: time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC), Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true,
		Status: &UpdateStatus{Stage: UpdateStageIdle, Last: lastResult(UpdateOutcomeRolledBack, "NO_CHECK_IN", "0.1.0", "0.1.1")}}
	if got := view.Headline(); !strings.Contains(got, "rolled back from 0.1.1 at 04:19:") {
		t.Fatalf("%s", got)
	}
}

func TestTheDetailListsTheRowsThatApply(t *testing.T) {
	withLocalZone(t, time.UTC)
	ms := uint32(1900)
	committed := lastResult(UpdateOutcomeCommitted, "", "0.0.9", "0.1.0")
	committed.At = time.Date(2026, 10, 5, 19, 0, 0, 0, time.UTC)
	committed.FirstCheckInMS = &ms
	view := UpdateView{
		StateDir: DefaultPaths().StateDir, ReadAt: viewNow, Policy: viewPolicy(t, UpdateConsentAuto, "Mon-Fri 02:00-04:00 UTC"), StepRunning: true, Eligibility: UpdateEligible,
		Status: &UpdateStatus{RunAt: viewNow.Add(-12 * time.Second), Stage: UpdateStageIdle, ServiceDefinition: 1, Last: committed},
		Staged: &StagedUpdate{ManifestSHA256: strings.Repeat("b", 64), OfferedAt: time.Date(2026, 10, 5, 19, 30, 0, 0, time.UTC), Version: "0.1.1", Size: 15204352, Complete: true},
	}
	var got []string
	for _, row := range view.Rows() {
		got = append(got, row.Label+"|"+row.Value)
	}
	want := []string{
		"Updates|automatic · patch releases · Mon–Fri 02:00–04:00 UTC (next in 6 h) · key " + teamShortID,
		"Key|" + teamShortID + " · team · pinned 3 Oct 2026 12:30",
		"Eligibility|this host can take updates",
		"Update step|running · last ran 12 s ago · service definition 1",
		"Staged|0.1.1 (14.5 MB) · offered 19:30",
		"Last result|0.0.9 → 0.1.0 at 19:00 · first check-in 1.9 s after restart",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// A request with no build beside it is how the agent hands the update step the evidence
// of a fork, so the row says no build is staged and never that one is still arriving.
func TestTheDetailSaysWhenARequestHasNoBuildBesideIt(t *testing.T) {
	withLocalZone(t, time.UTC)
	view := UpdateView{
		StateDir: DefaultPaths().StateDir, ReadAt: viewNow, Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Eligibility: UpdateEligible,
		Staged: &StagedUpdate{ManifestSHA256: strings.Repeat("b", 64), OfferedAt: time.Date(2026, 10, 5, 19, 30, 0, 0, time.UTC), Version: "0.1.1"},
	}
	var staged string
	for _, row := range view.Rows() {
		if row.Label == "Staged" {
			staged = row.Value
		}
	}
	if want := "0.1.1 · offered 19:30 · no build is staged for it"; staged != want {
		t.Fatalf("the Staged row says %q, want %q", staged, want)
	}
}

func TestTheDetailOfAHostThatCantTakeUpdates(t *testing.T) {
	view := UpdateView{ReadAt: viewNow, Policy: viewPolicy(t, UpdateConsentAuto), Eligibility: "UNTRUSTED_LOCATION"}
	var got []string
	for _, row := range view.Rows() {
		got = append(got, row.Label+"|"+row.Value)
	}
	for _, want := range []string{
		"Eligibility|a directory on the path of the agent, the policy or the update step can be changed by other accounts (UNTRUSTED_LOCATION)",
		"Update step|not running · it hasn't written a status yet",
	} {
		if !strings.Contains(strings.Join(got, "\n"), want) {
			t.Errorf("%q is missing from\n%s", want, strings.Join(got, "\n"))
		}
	}
	off := UpdateView{ReadAt: viewNow, Policy: func() UpdatePolicy { p := viewPolicy(t, UpdateConsentOff); return p }(), PolicyFile: true, Eligibility: UpdateEligible}
	rows := off.Rows()
	if rows[0].Value != "off on this host · key "+teamShortID+" kept for turning updates on again" {
		t.Fatalf("%+v", rows)
	}
	if rows[len(rows)-1].Label != "Eligibility" || rows[len(rows)-1].Value != "this host could take updates: the Upgrade agent command turns them on" {
		t.Fatalf("%+v", rows)
	}
}

// A rollback that keeps showing while the agent's service isn't running is one that can't
// start the previous build yet: `vectory update status` says so in words and says what to look
// at, and says nothing of the kind while the service runs, or at any other stage.
func TestTheDetailOfARollbackThatCantStartThePreviousBuildSaysWhatToLookAt(t *testing.T) {
	withLocalZone(t, time.UTC)
	view := func(stage string, service *ServiceInfo) UpdateView {
		return UpdateView{
			StateDir: DefaultPaths().StateDir, ReadAt: viewNow, Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Eligibility: UpdateEligible,
			Status:       &UpdateStatus{RunAt: viewNow.Add(-12 * time.Second), Stage: stage, FromVersion: "0.1.0", ToVersion: "0.1.1", ServiceDefinition: 1},
			AgentService: service,
		}
	}
	rows := func(v UpdateView) map[string]string {
		got := map[string]string{}
		for _, row := range v.Rows() {
			got[row.Label] = row.Value
		}
		return got
	}
	stopped := &ServiceInfo{Manager: "service manager", Name: "vectory", Installed: true, State: "stopped"}
	running := &ServiceInfo{Manager: "service manager", Name: "vectory", Installed: true, State: "running", PID: 812}

	got := rows(view(UpdateStageRollingBack, stopped))
	if want := "rolling back from 0.1.1 · the agent's service isn't running, and the update step is trying to start the previous build again (every 30 seconds until it can)"; got["In progress"] != want {
		t.Errorf("In progress says %q, want %q", got["In progress"], want)
	}
	if want := "the agent's service (" + agentServiceLook() + ") and the update step's log (" + updateStepLogWords() + ")"; got["Look at"] != want {
		t.Errorf("Look at says %q, want %q", got["Look at"], want)
	}

	for name, v := range map[string]UpdateView{
		"a rollback with the service running":         view(UpdateStageRollingBack, running),
		"a rollback with the service not read":        view(UpdateStageRollingBack, nil),
		"a trial with the service not running":        view(UpdateStageTrial, stopped),
		"a step that is idle with no service":         view(UpdateStageIdle, stopped),
		"an update being applied and service stopped": view(UpdateStageSwapping, stopped),
	} {
		if value, found := rows(v)["Look at"]; found {
			t.Errorf("%s: a Look at row says %q", name, value)
		}
		if strings.Contains(rows(v)["In progress"], "trying to start the previous build") {
			t.Errorf("%s: it is said that the step is trying to start the previous build", name)
		}
	}
}

// What the agent last reported is advice for apply, and it reads a missing or
// forged report as the cautious answer.
func TestTheAdviceForApplyReadsTheAgentsReport(t *testing.T) {
	staged := &StagedUpdate{ManifestSHA256: strings.Repeat("a", 64), Version: "0.1.1", Complete: true}
	report := func(offer string, age time.Duration) *UpdateHealth {
		return &UpdateHealth{CheckedInAt: viewNow.Add(-age), Offer: offer}
	}
	for name, tc := range map[string]struct {
		health  *UpdateHealth
		refuses bool
		gone    bool
		stale   bool
		words   string
	}{
		"no report":                {nil, true, true, true, "The agent hasn't reported on the offer yet."},
		"a fresh report of it":     {report(staged.ManifestSHA256, 90*time.Second), false, false, false, "The agent reported 2 min ago (19:58) that the server offers 0.1.1."},
		"just now":                 {report(staged.ManifestSHA256, 2*time.Second), false, false, false, "The agent reported just now (19:59) that the server offers 0.1.1."},
		"an old report of it":      {report(staged.ManifestSHA256, 7*time.Minute), true, false, true, "The agent reported 7 min ago (19:53) that the server offers 0.1.1."},
		"exactly five minutes":     {report(staged.ManifestSHA256, 5*time.Minute), false, false, false, "The agent reported 5 min ago (19:55) that the server offers 0.1.1."},
		"no offer any more":        {report("", 3*time.Minute), true, true, false, "The agent reported 3 min ago (19:57) that the server no longer offers 0.1.1: a rollout that was paused or cancelled, or Stop all updates, takes the offer away."},
		"another release":          {report(strings.Repeat("c", 64), time.Minute), true, true, false, ""},
		"an offer and an age":      {report("", 10*time.Minute), true, true, true, ""},
		"a report from the future": {report(staged.ManifestSHA256, -time.Hour), false, false, false, ""},
	} {
		t.Run(name, func(t *testing.T) {
			withLocalZone(t, time.UTC)
			advice := UpdateView{ReadAt: viewNow, Staged: staged, Health: tc.health}.Advice()
			if advice.Refuses() != tc.refuses || advice.OfferGone != tc.gone || advice.Stale != tc.stale {
				t.Fatalf("%+v", advice)
			}
			if tc.words != "" && advice.Words("0.1.1") != tc.words {
				t.Fatalf("%q\nwant %q", advice.Words("0.1.1"), tc.words)
			}
		})
	}
}

// ---------------------------------------------------------------- reading the host

func TestTheViewReadsThePolicyTheStepAndWhatTheAgentStaged(t *testing.T) {
	requireRootOwnedWriter(t) // the policy and step status are written as root-owned files
	withLocalZone(t, time.UTC)
	paths := useUpdateRoots(t)
	dir := realTempDir(t)
	policy := viewPolicy(t, UpdateConsentAsk, "daily 01:00-03:00 UTC")
	if err := WriteUpdatePolicy(policy); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	step, err := ensureRootOwnedDir(paths.StepDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer step.Close()
	status := UpdateStatus{RunAt: now.Add(-10 * time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1, HighestCounters: map[string]uint64{policy.Keys[0].Key.Fingerprint(): 6}}
	if err := WriteUpdateStatus(step, status); err != nil {
		t.Fatal(err)
	}
	// What the agent staged: the release, the build and, last, the request.
	manifestSHA := strings.Repeat("d", 64)
	exchange := UpdateExchangeFor(dir)
	incoming, _ := exchange.IncomingDir(manifestSHA)
	if err := os.MkdirAll(incoming, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest, err := BuildReleaseManifest(ReleaseManifest{Version: "0.1.1", Counter: 7, IssuedAt: now, ExpiresAt: now.Add(24 * time.Hour), ServiceDefinition: 1,
		Artifacts: []ReleaseArtifact{{OS: "linux", Arch: "amd64", Format: "executable", File: "vectory-0.1.1-linux-amd64", Size: 3, SHA256: strings.Repeat("e", 64)}}})
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{UpdateReleaseFile: manifest, UpdateBuildFile(runtime.GOOS): []byte("abc")} {
		if err := os.WriteFile(filepath.Join(incoming, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteUpdateRequest(exchange.Request, UpdateRequest{ManifestSHA256: manifestSHA, ArtifactSHA256: strings.Repeat("e", 64), RolloutID: "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4", OfferedAt: now.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if err := WriteUpdateHealth(exchange.Health, UpdateHealth{AgentSHA256: strings.Repeat("f", 64), AgentVersion: Version, BootID: strings.Repeat("0", 64), CheckedInAt: now.Add(-3 * time.Second), Vector: UpdateVectorRunning, Offer: manifestSHA}); err != nil {
		t.Fatal(err)
	}
	view := readUpdateView(dir, now, func(string) string { t.Fatal("a host that took the step needs no probe"); return "" })
	if !view.PolicyFile || view.PolicyProblem != "" || view.Policy.Consent != UpdateConsentAsk || !view.StepRunning || view.Eligibility != UpdateEligible {
		t.Fatalf("%+v", view)
	}
	if view.Staged == nil || view.Staged.Version != "0.1.1" || !view.Staged.Complete || view.Staged.Size != 3 || view.Staged.ManifestSHA256 != manifestSHA {
		t.Fatalf("%+v", view.Staged)
	}
	if advice := view.Advice(); advice.Refuses() {
		t.Fatalf("%+v", advice)
	}
	if want := "staged 0.1.1, waiting for you: " + asAdmin("vectory update apply") + " --state-dir " + ShellQuote(dir); view.Headline() != want {
		t.Fatalf("%q want %q", view.Headline(), want)
	}
	// The step stopped: its status is old, and the host says so.
	step2 := UpdateStatus{RunAt: now.Add(-10 * time.Minute), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1}
	if err := WriteUpdateStatus(step, step2); err != nil {
		t.Fatal(err)
	}
	if stale := readUpdateView(dir, now, nil); stale.StepRunning || stale.Eligibility != "HELPER_NOT_RUNNING" {
		t.Fatalf("%+v", stale)
	}
}

func TestAHostThatNeverConsentedAsksTheStepAboutItselfAndIsNoFaultForLackingIt(t *testing.T) {
	useUpdateRoots(t)
	dir := realTempDir(t)
	asked := 0
	for probe, want := range map[string]string{
		"PACKAGE_MANAGED":         "PACKAGE_MANAGED",
		"PLATFORM_NOT_IN_RELEASE": "PLATFORM_NOT_IN_RELEASE",
		"HELPER_NOT_RUNNING":      UpdateEligible,
		UpdateEligible:            UpdateEligible,
	} {
		view := readUpdateView(dir, time.Now(), func(string) string { asked++; return probe })
		if view.Policy.Consent != UpdateConsentOff || view.PolicyFile || view.Eligibility != want {
			t.Errorf("%s: %+v", probe, view)
		}
	}
	if asked != 4 {
		t.Fatalf("asked %d times", asked)
	}
}

func TestAPolicyThatCantBeUsedIsNamedAndTakesNoUpdate(t *testing.T) {
	requireRootOwnedWriter(t) // the invalid policy is still stored under a root-owned directory
	paths := useUpdateRoots(t)
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteFile(updatePolicyFile, []byte(`{"schema":"vectory.update-policy.v1","consent":"maybe","track":"patch","windows":[],"paused":false,"keys":[],"updated_at":"2026-10-03T12:30:00Z"}`), rootReadable); err != nil {
		t.Fatal(err)
	}
	dir.Close()
	view := readUpdateView(realTempDir(t), time.Now(), func(string) string { return UpdateEligible })
	if view.Policy.Consent != UpdateConsentOff || !view.PolicyFile || !strings.HasPrefix(view.PolicyProblem, `consent "maybe" isn't off, auto or ask`) {
		t.Fatalf("%+v", view)
	}
	if !strings.HasPrefix(view.Headline(), "off · the update policy can't be used: consent") {
		t.Fatalf("%s", view.Headline())
	}
}

func TestTheJSONViewHasEveryMemberNullWhereNothingApplies(t *testing.T) {
	withLocalZone(t, time.UTC)
	off := UpdateStatusJSON(UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: viewNow, Policy: DefaultUpdatePolicy(), Eligibility: UpdateEligible})
	for _, member := range []string{"state_dir", "consent", "paused", "local_pause", "track", "windows", "window_open", "next_window_at", "keys", "policy_problem", "eligibility", "step", "staged", "in_progress", "last", "rollover_conflict", "line"} {
		if _, ok := off[member]; !ok {
			t.Errorf("%q is missing", member)
		}
	}
	if off["step"] != nil || off["staged"] != nil || off["last"] != nil || off["next_window_at"] != nil || off["consent"] != "off" {
		t.Fatalf("%v", off)
	}
	busy := UpdateStatusJSON(UpdateView{ReadAt: viewNow, Policy: viewPolicy(t, UpdateConsentAuto, "Mon-Fri 02:00-04:00 UTC"), StepRunning: true,
		Status: &UpdateStatus{RunAt: viewNow, Stage: UpdateStageTrial, ServiceDefinition: 1, FromVersion: "0.1.0", ToVersion: "0.1.1", Release: strings.Repeat("a", 64), Deadline: viewNow.Add(5 * time.Minute)},
		Staged: &StagedUpdate{ManifestSHA256: strings.Repeat("a", 64), OfferedAt: viewNow, Version: "0.1.1", Size: 3, Complete: true}})
	progress, _ := busy["in_progress"].(map[string]any)
	if progress["stage"] != "trial" || progress["to_version"] != "0.1.1" || busy["next_window_at"] != "2026-10-06T02:00:00Z" {
		t.Fatalf("%v", busy)
	}
	if staged, _ := busy["staged"].(map[string]any); staged["version"] != "0.1.1" || staged["complete"] != true {
		t.Fatalf("%v", busy["staged"])
	}
}

// A person at the keyboard can settle an update that is only being prepared, which has
// swapped nothing, and can't settle one that has begun to swap: that is the update
// step's, and every command that would otherwise offer to apply says so first.
func TestTheViewSaysTheStepIsSettlingAnUpdateOnlyOnceItHasBegunToSwap(t *testing.T) {
	for stage, want := range map[string]bool{
		UpdateStageIdle: false, UpdateStagePreparing: false,
		UpdateStageSwapping: true, UpdateStageTrial: true, UpdateStageRollingBack: true,
	} {
		if got := (UpdateView{Status: &UpdateStatus{Stage: stage}}).StepIsSettlingAnUpdate(); got != want {
			t.Errorf("with the step in %s: %v, want %v", stage, got, want)
		}
	}
	if (UpdateView{}).StepIsSettlingAnUpdate() {
		t.Error("a host whose step never wrote a status has no update to settle")
	}
	dir := "/var/lib/vectory-agent-other"
	words := UpdateBeingSettledError(dir).Error()
	// The command is the one the system's own words give: an administrator's shell on
	// Windows has no sudo.
	for _, want := range []string{"an update that already began is being settled by the background update step", "usually within a minute or two", AdminCommandFor(dir, "vectory update status")} {
		if !strings.Contains(words, want) {
			t.Errorf("%q doesn't say %q", words, want)
		}
	}
}
