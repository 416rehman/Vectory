package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// `vectory status` and `vectory doctor` say what the host consented to and how
// updates stand, from the view `vectory update status` prints.

func TestStatusShowsWhatTheHostConsentedTo(t *testing.T) {
	requireRootOwnedWriter(t)
	withLocalZone(t, time.UTC)
	_, dir := enrolledInstallation(t)
	useUpdateRoots(t)
	if err := WriteUpdatePolicy(viewPolicy(t, UpdateConsentAuto, "Mon-Fri 02:00-04:00")); err != nil {
		t.Fatal(err)
	}
	view, err := ReadStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	text := RenderStatus(view, time.Now())
	if !strings.Contains(text, "Updates    automatic · patch releases · Mon–Fri 02:00–04:00 ") || !strings.Contains(text, " · key "+teamShortID+"\n") {
		t.Fatalf("status says nothing about updates:\n%s", text)
	}
	// The row sits between what the agent runs and when it checks in.
	if strings.Index(text, "Pipeline") > strings.Index(text, "Updates") || strings.Index(text, "Updates") > strings.Index(text, "Next") {
		t.Fatalf("the Updates row is out of place:\n%s", text)
	}
	raw, err := json.Marshal(StatusJSON(view))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Updates struct {
			Consent string   `json:"consent"`
			Windows []string `json:"windows"`
			Keys    []struct {
				Fingerprint string `json:"fingerprint"`
			} `json:"keys"`
		} `json:"updates"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if document.Updates.Consent != "auto" || len(document.Updates.Windows) != 1 || len(document.Updates.Keys) != 1 {
		t.Fatalf("status --json: %s", raw)
	}
}

// A view nobody read says nothing: a status built by hand renders as it always did.
func TestAStatusWithNoUpdateViewHasNoUpdatesRow(t *testing.T) {
	v := &StatusView{StateDir: "/var/lib/vectory-agent", Settings: Settings{Name: "edge-01"}}
	if text := RenderStatus(v, time.Now()); strings.Contains(text, "Updates") {
		t.Fatalf("%s", text)
	}
	if _, present := StatusJSON(v)["updates"]; present {
		t.Fatal("status --json has an updates key with nothing read")
	}
}

func checkByID(checks []DoctorCheck, id string) *DoctorCheck {
	for i := range checks {
		if checks[i].ID == id {
			return &checks[i]
		}
	}
	return nil
}

func TestDoctorChecksWhatAnUpdateNeeds(t *testing.T) {
	withLocalZone(t, time.UTC)
	now := viewNow
	step := func(change func(*UpdateStatus)) *UpdateStatus {
		status := &UpdateStatus{RunAt: now.Add(-20 * time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1}
		if change != nil {
			change(status)
		}
		return status
	}
	fork := &RolloverConflict{From: viewPolicy(t, UpdateConsentAuto).Keys[0].Key.Fingerprint(), To: [2]string{strings.Repeat("2", 64), strings.Repeat("3", 64)}}
	type verdict struct{ status, detail, fix string }
	for _, tc := range []struct {
		name  string
		view  UpdateView
		want  map[string]verdict
		other []string // ids that must not be there
	}{
		{
			name:  "a host that never consented",
			view:  UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: DefaultUpdatePolicy(), Eligibility: UpdateEligible},
			want:  map[string]verdict{"updates": {"info", "off on this host", "Upgrade agent command from the dashboard again with updates on, once."}},
			other: []string{"updates-step", "updates-host"},
		},
		{
			name: "a host that can't take updates and says why",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: DefaultUpdatePolicy(), Eligibility: "PACKAGE_MANAGED"},
			want: map[string]verdict{"updates": {"info", "off on this host · installed from a package, so the package manager updates it", ""}},
		},
		{
			name:  "a policy that can't be used",
			view:  UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: DefaultUpdatePolicy(), PolicyFile: true, PolicyProblem: "/etc/vectory/updates is writable by its group (mode 0775)"},
			want:  map[string]verdict{"updates": {"fail", "The update policy can't be used, so this host takes no update: /etc/vectory/updates is writable by its group (mode 0775).", "Make it, and every directory above it, writable by root alone"}},
			other: []string{"updates-step"},
		},
		{
			name: "a host whose step runs",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Status: step(nil), StepRunning: true, Eligibility: UpdateEligible},
			want: map[string]verdict{
				"updates":      {"ok", "automatic · patch releases · any time · key " + teamShortID, ""},
				"updates-step": {"ok", "running · last ran 20 s ago · service definition 1", ""},
			},
			other: []string{"updates-host", "updates-key", "updates-last"},
		},
		{
			name: "a step that has never run",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Eligibility: "HELPER_NOT_RUNNING"},
			want: map[string]verdict{"updates-step": {"fail", "It hasn't run on this host: it has written no status.", "Run the Upgrade agent command from the dashboard again; it installs the update step."}},
		},
		{
			name: "a step that stopped",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Status: step(func(s *UpdateStatus) { s.RunAt = now.Add(-10 * time.Minute) }), Eligibility: "HELPER_NOT_RUNNING"},
			want: map[string]verdict{"updates-step": {"fail", "Not running: it last ran 10 min ago, and it runs every 30 seconds.", "Run the Upgrade agent command from the dashboard again if it doesn't start by itself"}},
		},
		{
			name: "a step whose status can't be trusted",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), StatusProblem: "/var/lib/vectory-update is writable by everyone (mode 0777)", Eligibility: "HELPER_NOT_RUNNING"},
			want: map[string]verdict{"updates-step": {"fail", "Its status can't be read: /var/lib/vectory-update is writable by everyone (mode 0777).", "Make every directory on its path root's alone."}},
		},
		{
			name: "a package-managed host that consented",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Status: step(func(s *UpdateStatus) { s.Eligibility = "PACKAGE_MANAGED" }), StepRunning: true, Eligibility: "PACKAGE_MANAGED"},
			want: map[string]verdict{"updates-host": {"fail", "this agent is installed from a package, so the package manager owns its file (PACKAGE_MANAGED).", "Update the agent with its package manager."}},
		},
		{
			name: "a service that doesn't run this agent",
			view: UpdateView{StateDir: "/srv/agent state", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Status: step(func(s *UpdateStatus) { s.Eligibility = "NO_SERVICE" }), StepRunning: true, Eligibility: "NO_SERVICE"},
			want: map[string]verdict{"updates-host": {"fail", "no service manager runs this agent, or the registered service doesn't run this executable for this state directory (NO_SERVICE).", "sudo vectory service-install --state-dir '/srv/agent state'"}},
		},
		{
			name: "an operating system whose updates are not in this release",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Status: step(func(s *UpdateStatus) { s.Eligibility = "PLATFORM_NOT_IN_RELEASE" }), StepRunning: true, Eligibility: "PLATFORM_NOT_IN_RELEASE"},
			want: map[string]verdict{"updates-host": {"info", "", ""}},
		},
		{
			name: "a fork of a pinned key",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), Status: step(func(s *UpdateStatus) { s.RolloverConflict = fork }), StepRunning: true, Eligibility: UpdateEligible},
			want: map[string]verdict{"updates-key": {"fail", "Stopped: two successors of key " + teamShortID + " were seen, " + strings.Repeat("2", 16) + " and " + strings.Repeat("3", 16) + ": run the Upgrade agent command with the right key.", "Run the Upgrade agent command from the dashboard again with the right key; it pins that key and ends the stop."}},
		},
		{
			name: "a build waiting for someone on an ask host",
			view: UpdateView{StateDir: "/srv/agent state", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAsk), Status: step(nil), StepRunning: true, Eligibility: UpdateEligible,
				Staged: &StagedUpdate{ManifestSHA256: strings.Repeat("a", 64), OfferedAt: now.Add(-time.Hour), Version: "0.1.1", Complete: true}},
			want: map[string]verdict{"updates-staged": {"info", "Staged 0.1.1, offered 19:00, and waiting for someone on this host.", "Apply it: sudo vectory update apply --state-dir '/srv/agent state'"}},
		},
		{
			name: "an update that committed",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Eligibility: UpdateEligible,
				Status: step(func(s *UpdateStatus) {
					s.Last = lastResult(UpdateOutcomeCommitted, "", "0.1.0", "0.1.1")
					s.Last.At = now.Add(-2 * time.Hour)
				})},
			want: map[string]verdict{"updates-last": {"ok", "0.1.0 → 0.1.1 at 18:00", ""}},
		},
		{
			name: "an update that rolled back",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Eligibility: UpdateEligible,
				Status: step(func(s *UpdateStatus) {
					s.Last = lastResult(UpdateOutcomeRolledBack, "NO_CHECK_IN", "0.1.0", "0.1.1")
					s.Last.At = now.Add(-2 * time.Hour)
				})},
			want: map[string]verdict{"updates-last": {"warn", "Rolled back from 0.1.1 at 18:00: it didn't check in within 5 minutes; this host won't try 0.1.1 again.", "Nothing to do here: the next release reaches this host."}},
		},
		{
			name: "a rollback whose previous build is unhealthy too",
			view: UpdateView{StateDir: "/var/lib/vectory-agent", ReadAt: now, Policy: viewPolicy(t, UpdateConsentAuto), StepRunning: true, Eligibility: UpdateEligible,
				Status: step(func(s *UpdateStatus) {
					s.Last = lastResult(UpdateOutcomeRolledBack, "ROLLBACK_UNHEALTHY", "0.1.0", "0.1.1")
					s.Last.At = now.Add(-2 * time.Hour)
				})},
			want: map[string]verdict{"updates-last": {"fail", "Rolled back from 0.1.1 at 18:00, and the previous build hasn't checked in either: check the network and the server; this host won't try 0.1.1 again.", "Check the network and the server"}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checks := updateChecks(tc.view)
			for id, want := range tc.want {
				got := checkByID(checks, id)
				if got == nil {
					t.Fatalf("no %s check in %+v", id, checks)
				}
				if got.Status != want.status || (want.detail != "" && got.Detail != want.detail) || !strings.Contains(got.Fix, want.fix) {
					t.Errorf("%s: %s %q fix %q\nwant %s %q fix %q", id, got.Status, got.Detail, got.Fix, want.status, want.detail, want.fix)
				}
			}
			for _, id := range tc.other {
				if got := checkByID(checks, id); got != nil {
					t.Errorf("a %s check where there should be none: %+v", id, got)
				}
			}
		})
	}
}

// The doctor of an installed host includes the update checks, and a host with a
// policy this agent can't trust fails them.
func TestTheDoctorIncludesTheUpdateChecks(t *testing.T) {
	requireRootOwnedWriter(t)
	_, dir := enrolledInstallation(t)
	paths := useUpdateRoots(t)
	if err := WriteUpdatePolicy(viewPolicy(t, UpdateConsentAsk)); err != nil {
		t.Fatal(err)
	}
	report, err := RunDoctor(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := checkByID(report.Checks, "updates"); got == nil || got.Status != "ok" || !strings.HasPrefix(got.Detail, "ask on this host · patch releases") {
		t.Fatalf("the update check is %+v\n%s", got, RenderDoctor(report))
	}
	// The step never ran here: a host that consented without one can't apply anything.
	if got := checkByID(report.Checks, "updates-step"); got == nil || got.Status != "fail" {
		t.Fatalf("the step check is %+v\n%s", got, RenderDoctor(report))
	}
	if !report.Failed() || !strings.Contains(RenderDoctor(report), "Fix: Run the Upgrade agent command from the dashboard again; it installs the update step.") {
		t.Fatalf("%s", RenderDoctor(report))
	}
	document, err := json.Marshal(DoctorJSON(report))
	if err != nil || !strings.Contains(string(document), `"id":"updates-step"`) {
		t.Fatalf("%s %v", document, err)
	}
	_ = paths
}
