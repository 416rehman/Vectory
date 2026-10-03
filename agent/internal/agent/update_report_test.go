package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The heartbeat member `agent_update` against the shared fixture the server's
// parser reads too (contracts/fixtures/agent-release/report.json): the agent's
// bounds are the fixture's, the agent's validator gives every member the
// verdict the fixture gives it, and the report the agent builds is accepted at
// each bound and refused beyond it.

type reportFixture struct {
	Bounds struct {
		Keys                  int    `json:"keys"`
		Windows               int    `json:"windows"`
		WindowCharacters      int    `json:"window_characters"`
		FingerprintCharacters int    `json:"fingerprint_characters"`
		HighestCounter        uint64 `json:"highest_counter"`
		ServiceDefinition     int    `json:"service_definition"`
		FirstCheckInMS        int    `json:"first_check_in_ms"`
		VersionBytes          int    `json:"version_bytes"`
	} `json:"bounds"`
	Members []struct {
		Name     string          `json:"name"`
		Member   json.RawMessage `json:"member"`
		Accepted bool            `json:"accepted"`
		Why      string          `json:"why"`
	} `json:"members"`
}

func readReportFixture(t *testing.T) reportFixture {
	t.Helper()
	var fixture reportFixture
	if err := json.Unmarshal(repoFile(t, "contracts/fixtures/agent-release/report.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Members) < 70 {
		t.Fatalf("the fixture holds %d members", len(fixture.Members))
	}
	return fixture
}

func TestTheReportBoundsAreTheSharedFixturesBoundsOfTheMember(t *testing.T) {
	b := readReportFixture(t).Bounds
	for name, pair := range map[string][2]uint64{
		"keys":                   {reportMaxKeys, uint64(b.Keys)},
		"windows":                {reportMaxWindows, uint64(b.Windows)},
		"window_characters":      {reportMaxWindowChars, uint64(b.WindowCharacters)},
		"fingerprint_characters": {reportFingerprintSize, uint64(b.FingerprintCharacters)},
		"highest_counter":        {MaxJSONCounter, b.HighestCounter},
		"service_definition":     {maxUpdateServiceGeneration, uint64(b.ServiceDefinition)},
		"first_check_in_ms":      {maxFirstCheckInMS, uint64(b.FirstCheckInMS)},
		"version_bytes":          {maxUpdateVersionBytes, uint64(b.VersionBytes)},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s: the agent keeps to %d, the fixture says the server accepts %d", name, pair[0], pair[1])
		}
	}
}

func TestEveryMemberOfTheSharedFixtureGetsTheVerdictTheFixtureGivesIt(t *testing.T) {
	for _, entry := range readReportFixture(t).Members {
		t.Run(entry.Name, func(t *testing.T) {
			err := validateAgentUpdateMember(entry.Member)
			switch {
			case entry.Accepted && err != nil:
				t.Fatalf("the server accepts it and the agent refuses it: %v", err)
			case !entry.Accepted && err == nil:
				t.Fatalf("the server refuses it (%s) and the agent accepts it", entry.Why)
			}
		})
	}
}

// What the server accepts, the agent's own type can say, so the agent can send
// every member there is. The one difference is the order of a fork's two
// successors: the member doesn't ask for one and the type holds them in ascending
// order, as the privileged step records them and as the release library finds
// them, so the test puts them in that order first.
func TestTheReportTypeSaysEveryMemberTheServerAccepts(t *testing.T) {
	for _, entry := range readReportFixture(t).Members {
		if !entry.Accepted {
			continue
		}
		t.Run(entry.Name, func(t *testing.T) {
			member := entry.Member
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(member, &fields); err != nil {
				t.Fatal(err)
			}
			if raw, ok := fields["rollover_conflict"]; ok && string(raw) != "null" {
				var fork struct {
					From string   `json:"from"`
					To   []string `json:"to"`
				}
				if err := json.Unmarshal(raw, &fork); err != nil {
					t.Fatal(err)
				}
				if len(fork.To) == 2 && fork.To[0] > fork.To[1] {
					fork.To[0], fork.To[1] = fork.To[1], fork.To[0]
				}
				sorted, err := json.Marshal(fork)
				if err != nil {
					t.Fatal(err)
				}
				fields["rollover_conflict"] = sorted
				if member, err = json.Marshal(fields); err != nil {
					t.Fatal(err)
				}
			}
			var report AgentUpdateReport
			if err := json.Unmarshal(member, &report); err != nil {
				t.Fatalf("the type can't hold it: %v", err)
			}
			if err := report.Validate(); err != nil {
				t.Fatalf("the type says it differently from the fixture: %v", err)
			}
			again, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateAgentUpdateMember(again); err != nil {
				t.Fatalf("what the agent sends for it: %v\n%s", err, again)
			}
		})
	}
}

// ---------------------------------------------------------------- the bounds, at and beyond

func fingerprints(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = strings.Repeat(string(rune('a'+i)), 64)
	}
	return out
}

func okReport() AgentUpdateReport {
	return AgentUpdateReport{
		Consent: UpdateConsentAuto, Track: UpdateTrackPatch, Windows: []string{}, Keys: fingerprints(1),
		Eligibility: UpdateEligible, State: UpdateStateIdle, WindowOpen: true,
	}
}

func TestTheReportIsAcceptedAtEachBoundAndRefusedBeyondIt(t *testing.T) {
	long := func(n int) string { return strings.Repeat("W", n) }
	version := func(n int) string { return "0." + strings.Repeat("1", n-2) }
	withLast := func(change func(*UpdateLast)) func(*AgentUpdateReport) {
		return func(r *AgentUpdateReport) {
			last := UpdateLast{Release: strings.Repeat("a", 64), Outcome: UpdateOutcomeCommitted, At: time.Date(2026, 10, 5, 2, 14, 9, 0, time.UTC), FromVersion: "0.1.0", ToVersion: "0.1.1"}
			change(&last)
			r.Last = &last
		}
	}
	ms := func(n uint32) *uint32 { return &n }
	for _, tc := range []struct {
		name   string
		change func(*AgentUpdateReport)
		want   bool
	}{
		{"4 keys", func(r *AgentUpdateReport) { r.Keys = fingerprints(4) }, true},
		{"5 keys", func(r *AgentUpdateReport) { r.Keys = fingerprints(5) }, false},
		{"7 windows", func(r *AgentUpdateReport) { r.Windows = []string{"a", "b", "c", "d", "e", "f", "g"} }, true},
		{"8 windows", func(r *AgentUpdateReport) { r.Windows = []string{"a", "b", "c", "d", "e", "f", "g", "h"} }, false},
		{"a window of 40 characters", func(r *AgentUpdateReport) { r.Windows = []string{long(40)} }, true},
		{"a window of 41 characters", func(r *AgentUpdateReport) { r.Windows = []string{long(41)} }, false},
		{"a window of 1 character", func(r *AgentUpdateReport) { r.Windows = []string{"d"} }, true},
		{"an empty window", func(r *AgentUpdateReport) { r.Windows = []string{""} }, false},
		{"a window with a tab", func(r *AgentUpdateReport) { r.Windows = []string{"Mon\t02:00"} }, false},
		{"a window with a character that isn't ASCII", func(r *AgentUpdateReport) { r.Windows = []string{"Mon 02:00–04:00"} }, false},
		{"the largest counter", func(r *AgentUpdateReport) { r.HighestCounter = MaxJSONCounter }, true},
		{"a counter above the largest", func(r *AgentUpdateReport) { r.HighestCounter = MaxJSONCounter + 1 }, false},
		{"a service definition of 1", func(r *AgentUpdateReport) { r.ServiceDefinition = 1 }, true},
		{"a service definition of 1,000", func(r *AgentUpdateReport) { r.ServiceDefinition = 1000 }, true},
		{"a service definition of 1,001", func(r *AgentUpdateReport) { r.ServiceDefinition = 1001 }, false},
		{"a result with a version of 128 bytes", withLast(func(l *UpdateLast) { l.FromVersion = version(128) }), true},
		{"a result with a first check-in of a day", withLast(func(l *UpdateLast) { l.FirstCheckInMS = ms(86_400_000) }), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report := okReport()
			tc.change(&report)
			err := report.Validate()
			if tc.want && err != nil {
				t.Fatalf("refused: %v", err)
			}
			if !tc.want && err == nil {
				t.Fatal("accepted")
			}
		})
	}

	// What a type with a bound of its own can't say, the member's bytes do: a
	// result a day and a millisecond after the first check-in, and a version of
	// 129 bytes.
	t.Run("results beyond their bounds", func(t *testing.T) {
		for name, member := range map[string]string{
			"a first check-in of a day and a millisecond": `{"release":"` + strings.Repeat("a", 64) + `","outcome":"committed","code":null,"at":"2026-10-05T02:14:09Z","from_version":"0.1.0","to_version":"0.1.1","first_check_in_ms":86400001}`,
			"a version of 129 bytes":                      `{"release":"` + strings.Repeat("a", 64) + `","outcome":"committed","code":null,"at":"2026-10-05T02:14:09Z","from_version":"` + version(129) + `","to_version":"0.1.1"}`,
		} {
			if err := validateLastMember(json.RawMessage(member)); err == nil {
				t.Errorf("%s: accepted", name)
			}
		}
	})
}

// ---------------------------------------------------------------- what it says

// reportEngine is an engine with the answer about a host that has not installed
// the step already known, so that a test says what a host reports without asking
// the operating system.
func reportEngine(now time.Time) *Engine {
	e := &Engine{Now: func() time.Time { return now }}
	e.update.probeCode, e.update.probedAt = UpdateEligible, now
	return e
}

func reportFacts(t *testing.T, now time.Time, consent string, windows ...string) updateFacts {
	t.Helper()
	return updateFacts{policy: viewPolicy(t, consent, windows...), policyOK: true, now: now}
}

func freshStatus(now time.Time, mutate func(*UpdateStatus)) *UpdateStatus {
	status := &UpdateStatus{RunAt: now.Add(-10 * time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1, HighestCounters: map[string]uint64{}}
	if mutate != nil {
		mutate(status)
	}
	return status
}

func TestWhatAHostReportsInEachCase(t *testing.T) {
	withLocalZone(t, time.UTC)
	now := viewNow // a Monday, 20:00 UTC
	release := strings.Repeat("c", 64)
	other := strings.Repeat("d", 64)
	fork := &RolloverConflict{From: viewPolicy(t, UpdateConsentAuto).Keys[0].Key.Fingerprint(), To: [2]string{strings.Repeat("2", 64), strings.Repeat("3", 64)}}
	for _, tc := range []struct {
		name         string
		facts        func(*testing.T) updateFacts
		decision     updateDecision
		state, code  string
		release      string
		eligibility  string
		windowOpen   bool
		nextWindowAt string
		counter      uint64
		definition   int
	}{
		{
			name:  "off, with no policy and nothing staged",
			facts: func(t *testing.T) updateFacts { return updateFacts{policy: DefaultUpdatePolicy(), now: now} },
			state: UpdateStateIdle, code: "UPDATES_OFF", eligibility: UpdateEligible, windowOpen: true,
		},
		{
			name: "off, though a build was decided on before",
			facts: func(t *testing.T) updateFacts {
				return updateFacts{policy: DefaultUpdatePolicy(), policyOK: true, now: now}
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateIdle, code: "UPDATES_OFF", eligibility: UpdateEligible, windowOpen: true,
		},
		{
			name: "an untrusted policy is off, and says where the problem is",
			facts: func(t *testing.T) updateFacts {
				return updateFacts{policy: DefaultUpdatePolicy(), untrusted: true, now: now}
			},
			state: UpdateStateIdle, code: "UPDATES_OFF", eligibility: "UNTRUSTED_LOCATION", windowOpen: true,
		},
		{
			name: "automatic with nothing offered",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, nil)
				f.stepFresh = true
				return f
			},
			state: UpdateStateIdle, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "downloading",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateDownloading, release: release},
			state:    UpdateStateDownloading, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "staged inside the window",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateStaged, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "staged outside the window",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto, "Mon-Fri 02:00-04:00 UTC")
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateWaitingForWindow, release: release, eligibility: UpdateEligible, windowOpen: false, nextWindowAt: "2026-10-06T02:00:00Z", definition: 1,
		},
		{
			name: "staged on a host that asks",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAsk)
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateWaitingForHost, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "the step applies a build",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) { s.Stage, s.Release = UpdateStageSwapping, release })
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateApplying, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "a build on trial",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) {
					s.Stage, s.Release, s.FromVersion, s.ToVersion, s.Deadline = UpdateStageTrial, release, "0.1.0", "0.1.1", now.Add(4*time.Minute)
				})
				return f
			},
			state: UpdateStateTrial, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "a build the step is taking back",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) { s.Stage, s.Release = UpdateStageRollingBack, release })
				return f
			},
			state: UpdateStateApplying, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name:     "an offer the agent refused",
			facts:    func(t *testing.T) updateFacts { return reportFacts(t, now, UpdateConsentAuto) },
			decision: updateDecision{state: UpdateStateRefused, release: release, code: "KEY_NOT_PINNED"},
			state:    UpdateStateRefused, code: "KEY_NOT_PINNED", release: release, eligibility: "HELPER_NOT_RUNNING", windowOpen: true,
		},
		{
			name: "a download that failed three times",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateFailed, release: release, code: "ARTIFACT_MISMATCH"},
			state:    UpdateStateFailed, code: "ARTIFACT_MISMATCH", release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "a fork the step recorded",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) { s.RolloverConflict = fork })
				return f
			},
			decision: updateDecision{state: UpdateStateDownloading, release: release},
			state:    UpdateStateRefused, code: "KEY_ROLLOVER_CONFLICT", release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "a fork of a key the host doesn't pin any more is over",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) {
					s.RolloverConflict = &RolloverConflict{From: strings.Repeat("9", 64), To: fork.To}
				})
				return f
			},
			state: UpdateStateIdle, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "paused",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.policy.Paused = true
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateIdle, code: "UPDATES_PAUSED", eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "paused with vectory pause",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.localStop = true
				f.status = freshStatus(now, nil)
				return f
			},
			decision: updateDecision{state: UpdateStateDownloading, release: release},
			state:    UpdateStateIdle, code: "UPDATES_PAUSED", eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "a build the step is done with",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) {
					s.Last = &UpdateLast{Release: release, Outcome: UpdateOutcomeRolledBack, Code: "NO_CHECK_IN", At: now, FromVersion: "0.1.0", ToVersion: "0.1.1"}
				})
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateIdle, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "a result for an earlier release doesn't end this one",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) {
					s.Last = &UpdateLast{Release: other, Outcome: UpdateOutcomeCommitted, At: now, FromVersion: "0.1.0", ToVersion: "0.1.1"}
				})
				return f
			},
			decision: updateDecision{state: UpdateStateStaged, release: release},
			state:    UpdateStateStaged, release: release, eligibility: UpdateEligible, windowOpen: true, definition: 1,
		},
		{
			name: "the counters are the highest attempted from any key",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) {
					s.HighestCounters = map[string]uint64{strings.Repeat("1", 64): 6, strings.Repeat("2", 64): 9, strings.Repeat("3", 64): 4}
				})
				return f
			},
			state: UpdateStateIdle, eligibility: UpdateEligible, windowOpen: true, counter: 9, definition: 1,
		},
		{
			name: "a step that hasn't run lately",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) { s.RunAt = now.Add(-10 * time.Minute) })
				return f
			},
			state: UpdateStateIdle, eligibility: "HELPER_NOT_RUNNING", windowOpen: true, definition: 1,
		},
		{
			name: "a step that says the host can't take updates",
			facts: func(t *testing.T) updateFacts {
				f := reportFacts(t, now, UpdateConsentAuto)
				f.status = freshStatus(now, func(s *UpdateStatus) { s.Eligibility = "PACKAGE_MANAGED" })
				return f
			},
			state: UpdateStateIdle, eligibility: "PACKAGE_MANAGED", windowOpen: true, definition: 1,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := reportEngine(now)
			e.update.decision = tc.decision
			facts := tc.facts(t)
			report := e.buildAgentUpdateReport(facts)
			if err := report.Validate(); err != nil {
				t.Fatalf("the server would refuse it: %v", err)
			}
			got := [...]string{report.State, report.Code, report.Release, report.Eligibility, report.NextWindowAt}
			want := [...]string{tc.state, tc.code, tc.release, tc.eligibility, tc.nextWindowAt}
			if got != want {
				t.Fatalf("state %q, code %q, release %q, eligibility %q, next window %q;\nwant      %q, %q, %q, %q, %q", got[0], got[1], got[2], got[3], got[4], want[0], want[1], want[2], want[3], want[4])
			}
			if report.WindowOpen != tc.windowOpen || report.HighestCounter != tc.counter || report.ServiceDefinition != tc.definition {
				t.Fatalf("window open %v, counter %d, service definition %d; want %v, %d, %d", report.WindowOpen, report.HighestCounter, report.ServiceDefinition, tc.windowOpen, tc.counter, tc.definition)
			}
			if tc.code == "KEY_ROLLOVER_CONFLICT" && (report.RolloverConflict == nil || report.RolloverConflict.From != fork.From || report.RolloverConflict.To != fork.To) {
				t.Fatalf("the fork: %+v", report.RolloverConflict)
			}
			if tc.code != "KEY_ROLLOVER_CONFLICT" && report.RolloverConflict != nil {
				t.Fatalf("a fork without its code: %+v", report.RolloverConflict)
			}
		})
	}
}

// The report carries the policy as the host wrote it, and the step's latest
// result as it wrote it.
func TestTheReportCarriesThePolicyAndTheLatestResultAsTheyAre(t *testing.T) {
	withLocalZone(t, time.UTC)
	now := viewNow
	e := reportEngine(now)
	facts := reportFacts(t, now, UpdateConsentAsk, "Sat,Sun 01:00-05:00", "daily 12:00-12:30 UTC")
	facts.policy.Track = UpdateTrackMinor
	ms := uint32(2100)
	last := &UpdateLast{Release: strings.Repeat("a", 64), Outcome: UpdateOutcomeCommitted, At: time.Date(2026, 10, 5, 2, 14, 9, 0, time.UTC), FromVersion: "0.1.0", ToVersion: "0.1.1", FirstCheckInMS: &ms}
	facts.status = freshStatus(now, func(s *UpdateStatus) { s.Last = last })
	report := e.buildAgentUpdateReport(facts)
	if err := report.Validate(); err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var member map[string]json.RawMessage
	if err := json.Unmarshal(wire, &member); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"consent": `"ask"`, "track": `"minor"`, "paused": `false`, "windows": `["Sat,Sun 01:00-05:00","daily 12:00-12:30 UTC"]`,
		"window_open": `false`, "next_window_at": `"2026-10-06T12:00:00Z"`, "keys": `["` + facts.policy.Keys[0].Key.Fingerprint() + `"]`, "state": `"idle"`,
		"last": `{"release":"` + strings.Repeat("a", 64) + `","outcome":"committed","code":null,"at":"2026-10-05T02:14:09Z","from_version":"0.1.0","to_version":"0.1.1","first_check_in_ms":2100}`,
	} {
		if string(member[name]) != want {
			t.Errorf("%s is %s, want %s", name, member[name], want)
		}
	}
	for _, absent := range []string{"release", "code", "rollover_conflict"} {
		if _, present := member[absent]; present {
			t.Errorf("%s is in a report that has nothing to say about it", absent)
		}
	}
}

// A member the agent can't build the way the server accepts it is left out of
// the check-in, never sent: no report takes a device off the control plane.
func TestAReportTheAgentCannotBuildRightIsLeftOutAndSaidOnce(t *testing.T) {
	useUpdateRoots(t)
	e := reportEngine(viewNow)
	e.Dir = realTempDir(t)
	var said []string
	e.Notice = func(line string) { said = append(said, line) }
	// A policy the reader accepts but whose window the server would refuse can't be
	// written; a status can't hold a bad value either. The one thing the agent
	// can get wrong is its own state: a decision naming no release for a state that
	// needs one.
	e.update.decision = updateDecision{state: UpdateStateRefused}
	if err := WriteUpdatePolicy(viewPolicy(t, UpdateConsentAuto)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if report := e.agentUpdateReport(); report != nil {
			// A refusal without a code is the case; a refusal needs one.
			t.Fatalf("a member the server would refuse was built: %+v", report)
		}
	}
	if len(said) != 1 || !strings.HasPrefix(said[0], "The agent update report was left out of a check-in: ") {
		t.Fatalf("the log said %q", said)
	}
}
