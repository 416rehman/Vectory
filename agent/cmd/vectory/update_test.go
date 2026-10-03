package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vectory/vectory/agent/internal/agent"
)

// updateHost is a fake of everything `vectory update` reaches: it records what
// the verbs did to the policy and the step, and answers with the view a test sets.
type updateHost struct {
	t         *testing.T
	dir       string
	root      bool
	now       time.Time
	view      agent.UpdateView
	afterView *agent.UpdateView // what the host says after apply ran
	policy    agent.UpdatePolicy
	changes   int
	withdrawn int
	applied   []bool
	progress  []string
	applyErr  error
	withdraw  agent.UpdateWithdrawal
	withErr   error
	changeErr error
}

func newUpdateHost(t *testing.T) *updateHost {
	t.Helper()
	dir := t.TempDir()
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), agent.Settings{}); err != nil {
		t.Fatal(err)
	}
	key, err := agent.ParseReleaseKey("vectory-release-key ed25519 3n1kX5uZnEN2wf+ZrjTlfd3sqUPQff1ANP0I/elZz7o= team")
	if err != nil {
		t.Fatal(err)
	}
	h := &updateHost{t: t, dir: dir, root: true, now: time.Date(2026, 10, 5, 2, 20, 0, 0, time.UTC)}
	h.policy = agent.UpdatePolicy{Consent: agent.UpdateConsentAsk, Track: agent.UpdateTrackPatch, Keys: []agent.PinnedKey{{Key: key, PinnedAt: h.now}}}
	h.view = agent.UpdateView{StateDir: dir, ReadAt: h.now, Policy: h.policy, StepRunning: true, Eligibility: agent.UpdateEligible}
	return h
}

func (h *updateHost) env() updateEnv {
	return updateEnv{
		elevated: func() bool { return h.root },
		now:      func() time.Time { return h.now },
		view: func(dir string, now time.Time) agent.UpdateView {
			if len(h.applied) > 0 && h.afterView != nil {
				return *h.afterView
			}
			return h.view
		},
		change: func(edit func(*agent.UpdatePolicy) error) error {
			if h.changeErr != nil {
				return h.changeErr
			}
			h.changes++
			return edit(&h.policy)
		},
		withdraw: func(dir string) (agent.UpdateWithdrawal, error) {
			h.withdrawn++
			return h.withdraw, h.withErr
		},
		apply: func(ctx context.Context, dir string, force bool, progress func(string)) error {
			h.applied = append(h.applied, force)
			for _, step := range []string{"copying the build", "verifying the release", "swapping the executable"} {
				progress(step)
			}
			return h.applyErr
		},
	}
}

// stage puts a complete staged build in the view, with a report from the agent.
func (h *updateHost) stage(reportAge time.Duration, offerKept bool) {
	manifest := strings.Repeat("a", 64)
	h.view.Staged = &agent.StagedUpdate{ManifestSHA256: manifest, OfferedAt: h.now.Add(-6 * time.Minute), Version: "0.1.1", Size: 15204352, Complete: true}
	offer := ""
	if offerKept {
		offer = manifest
	}
	h.view.Health = &agent.UpdateHealth{CheckedInAt: h.now.Add(-reportAge), Offer: offer}
}

// runUpdate runs one verb of the group the fake host builds.
func (h *updateHost) run(ask func(string) (string, bool), verb string, args ...string) (int, string, string) {
	h.t.Helper()
	group := []command{newUpdateCommand(h.env())}
	linkVerbs(group)
	command := group[0].verb(verb)
	var stdout, stderr bytes.Buffer
	c := newCLI(command, &stdout, &stderr)
	c.ask = ask
	code := executeWith(c, command, append([]string{"--state-dir", h.dir}, args...))
	return code, stdout.String(), stderr.String()
}

func yes(string) (string, bool)          { return "y", true }
func no(string) (string, bool)           { return "n", true }
func noTerminalAt(string) (string, bool) { return "", false }

// asAdmin is a command that needs root as a person types it on this system: with
// sudo on Linux and macOS, as it stands in an elevated PowerShell on Windows. The
// text these tests expect is built with it, and with the quoting of a state
// directory for the shell of the system, so one test is right on every system.
func asAdmin(command string) string {
	if runtime.GOOS == "windows" {
		return command
	}
	return "sudo " + command
}

func TestUpdateStatusPrintsWhatTheHostSays(t *testing.T) {
	h := newUpdateHost(t)
	h.view.Policy.Windows = []string{"Mon-Fri 02:00-04:00 UTC"}
	h.view.Staged = &agent.StagedUpdate{ManifestSHA256: strings.Repeat("a", 64), OfferedAt: h.now.Add(-6 * time.Minute), Version: "0.1.1", Size: 15204352, Complete: true}
	h.view.Status = &agent.UpdateStatus{RunAt: h.now.Add(-9 * time.Second), Stage: agent.UpdateStageIdle, Eligibility: agent.UpdateEligible, ServiceDefinition: 1}
	code, stdout, stderr := h.run(noTerminalAt, "status")
	if code != 0 || stderr != "" {
		t.Fatalf("%d %q", code, stderr)
	}
	for _, want := range []string{
		"Updates      ask on this host · patch releases · Mon–Fri 02:00–04:00 UTC (open now) · key 05cc6c02351af0cb\n",
		"Eligibility  this host can take updates\n",
		"Update step  running · last ran 9 s ago · service definition 1\n",
		"Staged       0.1.1 (14.5 MB) · offered ",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("the status lacks %q:\n%s", want, stdout)
		}
	}
	// It needs no root, and says nothing about sudo.
	h.root = false
	if code, _, _ := h.run(noTerminalAt, "status"); code != 0 {
		t.Fatal("status refused a person who isn't root")
	}
}

func TestUpdateStatusJSON(t *testing.T) {
	h := newUpdateHost(t)
	code, stdout, stderr := h.run(noTerminalAt, "status", "--json")
	var out map[string]any
	if code != 0 || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil || out["consent"] != "ask" || out["staged"] != nil || out["eligibility"] != "eligible" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
}

func TestUpdateStatusOnAHostWithoutAnAgentSaysSo(t *testing.T) {
	h := newUpdateHost(t)
	missing := filepath.Join(t.TempDir(), "missing")
	group := []command{newUpdateCommand(h.env())}
	linkVerbs(group)
	var stdout, stderr bytes.Buffer
	c := newCLI(group[0].verb("status"), &stdout, &stderr)
	if code := executeWith(c, group[0].verb("status"), []string{"--state-dir", missing}); code != 1 || !strings.Contains(stderr.String(), "No agent is installed at "+missing) {
		t.Fatalf("%d %q", code, stderr.String())
	}
}

func TestUpdateVerbsThatChangeTheHostNeedRoot(t *testing.T) {
	h := newUpdateHost(t)
	h.root = false
	for _, verb := range []string{"apply", "pause", "resume", "off"} {
		code, stdout, stderr := h.run(noTerminalAt, verb)
		how := "Run it with sudo: "
		if runtime.GOOS == "windows" {
			how = "Run it from an elevated PowerShell: "
		}
		want := "vectory: this changes what only an administrator can change. " + how + asAdmin("vectory update "+verb) + " --state-dir " + agent.ShellQuote(h.dir) + "\n"
		if code != 1 || stdout != "" || stderr != want {
			t.Errorf("%s: %d %q %q, want %q", verb, code, stdout, stderr, want)
		}
	}
	if h.changes != 0 || h.withdrawn != 0 || len(h.applied) != 0 {
		t.Fatal("a person who isn't root changed the host")
	}
}

// ---------------------------------------------------------------- apply

func TestUpdateApplyShowsTheReportAndAppliesWhenItIsFresh(t *testing.T) {
	h := newUpdateHost(t)
	h.stage(90*time.Second, true)
	manifest := h.view.Staged.ManifestSHA256
	h.afterView = &agent.UpdateView{ReadAt: h.now, Policy: h.policy, Staged: h.view.Staged, Eligibility: agent.UpdateEligible, StepRunning: true,
		Status: &agent.UpdateStatus{Stage: agent.UpdateStageIdle, Last: &agent.UpdateLast{Release: manifest, Outcome: agent.UpdateOutcomeCommitted, At: h.now.Add(-time.Minute), FromVersion: "0.1.0", ToVersion: "0.1.1"}}}
	code, stdout, stderr := h.run(noTerminalAt, "apply")
	if code != 0 || stderr != "" {
		t.Fatalf("%d %q", code, stderr)
	}
	if len(h.applied) != 1 || h.applied[0] {
		t.Fatalf("a fresh report needs no force: %v", h.applied)
	}
	for _, want := range []string{
		"Staged: 0.1.1 (14.5 MB), offered ",
		"The agent reported 2 min ago (",
		"that the server offers 0.1.1.\n",
		"  copying the build\n  verifying the release\n  swapping the executable\n",
		"Updated: 0.1.0 → 0.1.1 at ",
		"The dashboard shows this device as updated once the server has seen the new build check in.\n",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("lacks %q:\n%s", want, stdout)
		}
	}
}

func TestUpdateApplyRefusesWhenTheReportSaysTheOfferIsGone(t *testing.T) {
	h := newUpdateHost(t)
	h.stage(40*time.Second, false)
	code, stdout, stderr := h.run(noTerminalAt, "apply")
	if code != 1 || len(h.applied) != 0 {
		t.Fatalf("%d %v", code, h.applied)
	}
	if !strings.Contains(stdout, "that the server no longer offers 0.1.1: a rollout that was paused or cancelled, or Stop all updates, takes the offer away.") {
		t.Errorf("%q", stdout)
	}
	for _, want := range []string{"vectory: not applying. The agent reported 40 s ago", "This check is advice: the update step verifies the signed release, the pinned keys and this host's policy again before it installs anything.", "run it again with --force."} {
		if !strings.Contains(stderr, want) {
			t.Errorf("lacks %q:\n%s", want, stderr)
		}
	}
}

func TestUpdateApplyRefusesAnOldReportAndAMissingOne(t *testing.T) {
	for name, set := range map[string]func(h *updateHost){
		"an old report":  func(h *updateHost) { h.stage(6*time.Minute, true) },
		"no report":      func(h *updateHost) { h.stage(0, true); h.view.Health = nil },
		"a long silence": func(h *updateHost) { h.stage(3*time.Hour, true) },
	} {
		t.Run(name, func(t *testing.T) {
			h := newUpdateHost(t)
			set(h)
			if code, _, stderr := h.run(yes, "apply"); code != 1 || len(h.applied) != 0 || !strings.Contains(stderr, "not applying.") {
				t.Fatalf("%d %v %q", code, h.applied, stderr)
			}
		})
	}
}

// --force asks, on a terminal, before it goes on past a report that says no; it
// never answers for the person, and the question is the only thing that passes
// force to the update step.
func TestUpdateApplyForceAsksOnATerminal(t *testing.T) {
	asked := ""
	record := func(answer string, terminal bool) func(string) (string, bool) {
		return func(question string) (string, bool) { asked = question; return answer, terminal }
	}
	t.Run("a yes goes on", func(t *testing.T) {
		h := newUpdateHost(t)
		h.stage(8*time.Minute, true)
		if code, _, stderr := h.run(record("yes", true), "apply", "--force"); code != 0 || len(h.applied) != 1 || !h.applied[0] || asked != "Apply it anyway? [y/N] " {
			t.Fatalf("%d %v %q %q", code, h.applied, asked, stderr)
		}
	})
	t.Run("anything else stops", func(t *testing.T) {
		h := newUpdateHost(t)
		h.stage(8*time.Minute, true)
		for _, answer := range []string{"n", "", "no", "maybe"} {
			if code, _, stderr := h.run(record(answer, true), "apply", "--force"); code != 1 || len(h.applied) != 0 || !strings.Contains(stderr, "not applied") {
				t.Fatalf("%q: %d %v %q", answer, code, h.applied, stderr)
			}
		}
	})
	t.Run("without a terminal --force refuses", func(t *testing.T) {
		h := newUpdateHost(t)
		h.stage(8*time.Minute, false)
		code, _, stderr := h.run(noTerminalAt, "apply", "--force")
		if code != 1 || len(h.applied) != 0 || !strings.Contains(stderr, "there is no terminal to ask on, and --force needs your answer.") {
			t.Fatalf("%d %v %q", code, h.applied, stderr)
		}
	})
	t.Run("a fresh report needs no question and no force", func(t *testing.T) {
		h := newUpdateHost(t)
		h.stage(time.Minute, true)
		asked = ""
		if code, _, _ := h.run(record("n", true), "apply", "--force"); code != 0 || asked != "" || len(h.applied) != 1 || h.applied[0] {
			t.Fatalf("%d %q %v", code, asked, h.applied)
		}
	})
}

func TestUpdateApplyIsRefusedWhereThereIsNothingToApply(t *testing.T) {
	for name, tc := range map[string]struct {
		set  func(h *updateHost)
		want string
	}{
		"updates are off": {func(h *updateHost) { h.view.Policy.Consent = agent.UpdateConsentOff },
			"vectory: updates are off on this host. Turn them on with the Upgrade agent command from the dashboard"},
		"the policy can't be used": {func(h *updateHost) { h.view.PolicyProblem = "/etc/vectory is writable by its group" },
			"vectory: the update policy can't be used (/etc/vectory is writable by its group), so this host takes no update"},
		"updates are paused": {func(h *updateHost) { h.view.Policy.Paused = true },
			"vectory: updates are paused on this host. Resume them first: " + asAdmin("vectory update resume") + " --state-dir "},
		"the host is paused": {func(h *updateHost) { h.view.LocalPaused = true },
			"vectory: vectory pause holds back every change on this host, updates included. Resume it first: " + asAdmin("vectory resume") + " --state-dir "},
		"an update that already began is being settled": {func(h *updateHost) {
			h.stage(time.Minute, true)
			h.view.Status = &agent.UpdateStatus{Stage: agent.UpdateStageTrial, FromVersion: "0.1.0", ToVersion: "0.1.1"}
		}, "vectory: an update that already began is being settled by the background update step. This command leaves it to that step, which finishes it by itself, usually within a minute or two. See where it stands: " + asAdmin("vectory update status") + " --state-dir "},
		"nothing is staged": {func(h *updateHost) {},
			"vectory: nothing is staged on this host. The agent stages a build when an update rollout reaches it; " + asAdmin("vectory update status") + " --state-dir "},
		"a request with no build beside it": {func(h *updateHost) {
			h.stage(time.Minute, true)
			h.view.Staged.Complete = false
		}, "vectory: no build is staged for the offer, so there is nothing to apply. See where things stand: " + asAdmin("vectory update status") + " --state-dir "},
	} {
		t.Run(name, func(t *testing.T) {
			h := newUpdateHost(t)
			tc.set(h)
			code, stdout, stderr := h.run(yes, "apply", "--force")
			if code != 1 || stdout != "" || !strings.HasPrefix(stderr, tc.want) || len(h.applied) != 0 {
				t.Fatalf("%d %q %q", code, stdout, stderr)
			}
		})
	}
}

// An update the step is trying or taking back is the step's to settle, whatever the agent last
// reported about the offer: the offer is withdrawn while an update is under way, which
// would otherwise send a person to --force, and apply says so before it asks anything.
// It fails like every other refusal does, and nothing is applied.
func TestUpdateApplyLeavesAnUpdateThatHasSwappedToTheStepBeforeItAsksAnything(t *testing.T) {
	for _, stage := range []string{agent.UpdateStageSwapping, agent.UpdateStageTrial, agent.UpdateStageRollingBack} {
		t.Run(stage, func(t *testing.T) {
			h := newUpdateHost(t)
			h.stage(10*time.Minute, false)
			h.view.Status = &agent.UpdateStatus{Stage: stage, FromVersion: "0.1.0", ToVersion: "0.1.1"}
			want := agent.UpdateBeingSettledError(h.dir).Error()

			code, stdout, stderr := h.run(noTerminalAt, "apply")
			if code != 1 || stdout != "" || stderr != "vectory: "+want+"\n" || len(h.applied) != 0 {
				t.Fatalf("%d %q %q", code, stdout, stderr)
			}
			code, stdout, stderr = h.run(noTerminalAt, "apply", "--json")
			var out map[string]any
			if code != 1 || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil || out["error"] != want || len(out) != 1 || len(h.applied) != 0 {
				t.Fatalf("%d %q %q", code, stdout, stderr)
			}
		})
	}
	// An update that is only being prepared has swapped nothing: apply goes on.
	h := newUpdateHost(t)
	h.stage(time.Minute, true)
	h.view.Status = &agent.UpdateStatus{Stage: agent.UpdateStagePreparing, FromVersion: "0.1.0", ToVersion: "0.1.1"}
	if code, _, stderr := h.run(noTerminalAt, "apply"); code != 0 || stderr != "" || len(h.applied) != 1 {
		t.Fatalf("an update that was only being prepared: %d %q %v", code, stderr, h.applied)
	}
}

// What happened is what the step recorded: an update the step took back is a
// failure even though apply returned no error, and one it recorded nothing
// about is not called a success.
func TestUpdateApplyReportsWhatTheStepRecorded(t *testing.T) {
	for name, tc := range map[string]struct {
		last     *agent.UpdateLast
		applyErr error
		code     int
		stdout   string
		stderr   string
	}{
		"it rolled back": {last: &agent.UpdateLast{Outcome: agent.UpdateOutcomeRolledBack, Code: "NO_CHECK_IN", At: time.Date(2026, 10, 5, 2, 19, 0, 0, time.UTC), FromVersion: "0.1.0", ToVersion: "0.1.1"}, code: 1,
			stderr: "vectory: rolled back from 0.1.1 at "},
		"it recorded nothing": {code: 0, stdout: "Done. " + asAdmin("vectory update status") + " --state-dir "},
		"the step refused": {applyErr: errors.New("UNTRUSTED_LOCATION: /usr/local is writable by its group"), code: 1,
			stderr: "vectory: UNTRUSTED_LOCATION: /usr/local is writable by its group"},
	} {
		t.Run(name, func(t *testing.T) {
			h := newUpdateHost(t)
			h.stage(time.Minute, true)
			h.applyErr = tc.applyErr
			after := agent.UpdateView{ReadAt: h.now, Policy: h.policy, StepRunning: true, Staged: h.view.Staged, Status: &agent.UpdateStatus{Stage: agent.UpdateStageIdle}}
			if tc.last != nil {
				tc.last.Release = h.view.Staged.ManifestSHA256
				after.Status.Last = tc.last
			}
			h.afterView = &after
			code, stdout, stderr := h.run(noTerminalAt, "apply")
			if code != tc.code || !strings.Contains(stdout, tc.stdout) || !strings.Contains(stderr, tc.stderr) {
				t.Fatalf("%d\n%s\n%s", code, stdout, stderr)
			}
			if strings.Contains(stdout, "Updated:") {
				t.Fatal("a build that wasn't kept was called updated")
			}
		})
	}
}

// When the update step won't be taken over, because it is busy or because it is settling
// an update that already began, apply fails the one way every refusal of the step does:
// the words on standard error and exit 1, or with --json an error member and exit 1.
func TestUpdateApplyThatTheStepAnswersWithATryAgainFailsAndSaysWhyInJSON(t *testing.T) {
	for name, message := range map[string]string{
		"the step is working":                    "another run of the update step is working now; try again in a minute",
		"the step is settling an earlier update": "an update that already began is being settled by the background update step. This command leaves it to that step, which finishes it by itself, usually within a minute or two. See where it stands: sudo vectory update status",
	} {
		t.Run(name, func(t *testing.T) {
			h := newUpdateHost(t)
			h.stage(time.Minute, true)
			h.applyErr = errors.New(message)
			code, stdout, stderr := h.run(noTerminalAt, "apply", "--json")
			var out map[string]any
			if code != 1 || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil || out["error"] != message || len(out) != 1 {
				t.Fatalf("%d %q %q", code, stdout, stderr)
			}
			code, stdout, stderr = h.run(noTerminalAt, "apply")
			if code != 1 || !strings.HasSuffix(stderr, message+"\n") || !strings.HasPrefix(stderr, "vectory: ") || strings.Contains(stdout, "Updated:") {
				t.Fatalf("%d %q %q", code, stdout, stderr)
			}
		})
	}
}

func TestUpdateApplyJSON(t *testing.T) {
	h := newUpdateHost(t)
	h.stage(time.Minute, true)
	h.afterView = &agent.UpdateView{ReadAt: h.now, Policy: h.policy, StepRunning: true, Staged: h.view.Staged,
		Status: &agent.UpdateStatus{Stage: agent.UpdateStageIdle, Last: &agent.UpdateLast{Release: h.view.Staged.ManifestSHA256, Outcome: agent.UpdateOutcomeCommitted, At: h.now, FromVersion: "0.1.0", ToVersion: "0.1.1"}}}
	code, stdout, stderr := h.run(noTerminalAt, "apply", "--json")
	var out map[string]any
	if code != 0 || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil || out["status"] != "ok" || out["outcome"] != "committed" || out["forced"] != false {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	if strings.Contains(stdout, "copying") {
		t.Fatal("the progress lines are in the JSON document")
	}
}

// ---------------------------------------------------------------- pause, resume, off

func TestUpdatePauseAndResume(t *testing.T) {
	h := newUpdateHost(t)
	code, stdout, stderr := h.run(noTerminalAt, "pause")
	if code != 0 || stderr != "" || !h.policy.Paused || h.changes != 1 {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	for _, want := range []string{"Paused. The agent stops downloading and applying agent updates at its next check-in; no restart is needed.", "A build the update step is already applying finishes.", "Resume with: " + asAdmin("vectory update resume") + " --state-dir " + agent.ShellQuote(h.dir)} {
		if !strings.Contains(stdout, want) {
			t.Errorf("lacks %q:\n%s", want, stdout)
		}
	}
	h.view.Policy.Paused = true
	if code, stdout, _ := h.run(noTerminalAt, "pause"); code != 0 || stdout != "Updates are already paused. Nothing changed.\n" || h.changes != 1 {
		t.Fatalf("%d %q %d", code, stdout, h.changes)
	}
	code, stdout, stderr = h.run(noTerminalAt, "resume")
	if code != 0 || stderr != "" || h.policy.Paused || h.changes != 2 || stdout != "Resumed. At its next check-in the agent downloads and applies updates again.\n" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	h.view.Policy.Paused = false
	if code, stdout, _ := h.run(noTerminalAt, "resume"); code != 0 || stdout != "Updates aren't paused. Nothing changed.\n" || h.changes != 2 {
		t.Fatalf("%d %q", code, stdout)
	}
}

func TestUpdateResumeNamesTheWindowAndAnotherPause(t *testing.T) {
	h := newUpdateHost(t)
	h.view.Policy.Paused = true
	h.view.Policy.Windows = []string{"daily 01:00-03:00"}
	h.view.LocalPaused = true
	_, stdout, _ := h.run(noTerminalAt, "resume")
	if want := "Resumed. At its next check-in the agent downloads and applies updates again, inside its window.\nvectory pause is also in force and still holds updates back: " + asAdmin("vectory resume") + " --state-dir " + agent.ShellQuote(h.dir) + "\n"; stdout != want {
		t.Fatalf("%q", stdout)
	}
}

func TestUpdatePauseAndResumeOnAHostThatTakesNoUpdates(t *testing.T) {
	h := newUpdateHost(t)
	h.view.Policy.Consent = agent.UpdateConsentOff
	for _, verb := range []string{"pause", "resume"} {
		code, stdout, _ := h.run(noTerminalAt, verb)
		if want := "Agent updates are off on this host, so there is nothing to " + verb + ". The Upgrade agent command with --updates turns them on.\n"; code != 0 || stdout != want || h.changes != 0 {
			t.Fatalf("%s: %d %q", verb, code, stdout)
		}
	}
	h.view.PolicyProblem = "its policy file isn't valid"
	if code, _, stderr := h.run(noTerminalAt, "pause"); code != 1 || !strings.Contains(stderr, "the update policy can't be used (its policy file isn't valid)") {
		t.Fatalf("%d %q", code, stderr)
	}
}

func TestUpdatePauseJSONAndAWriteThatFails(t *testing.T) {
	h := newUpdateHost(t)
	code, stdout, _ := h.run(noTerminalAt, "pause", "--json")
	var out map[string]any
	if code != 0 || json.Unmarshal([]byte(stdout), &out) != nil || out["command"] != "update pause" || out["changed"] != true || out["paused"] != true {
		t.Fatalf("%d %q", code, stdout)
	}
	h.changeErr = errors.New("the update policy changed while it was being edited")
	if code, _, stderr := h.run(noTerminalAt, "pause"); code != 1 || stderr != "vectory: the update policy changed while it was being edited\n" {
		t.Fatalf("%d %q", code, stderr)
	}
}

func TestUpdateOffSaysWhatItDid(t *testing.T) {
	h := newUpdateHost(t)
	h.withdraw = agent.UpdateWithdrawal{PolicyOff: true, Discarded: true, StepRemoved: true, KeysKept: 1}
	code, stdout, stderr := h.run(noTerminalAt, "off")
	want := "Agent updates are off on this host: the policy says off, the staged build is deleted, the update step is removed.\nThe pinned key is kept. To turn updates on again, run the Upgrade agent command with --updates.\n"
	if code != 0 || stdout != want || stderr != "" || h.withdrawn != 1 {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	h.withdraw = agent.UpdateWithdrawal{PolicyOff: true, KeysKept: 3}
	if _, stdout, _ = h.run(noTerminalAt, "off"); !strings.Contains(stdout, "The pinned keys are kept.") {
		t.Fatalf("%q", stdout)
	}
	h.withdraw = agent.UpdateWithdrawal{}
	if code, stdout, _ = h.run(noTerminalAt, "off"); code != 0 || stdout != "Agent updates are already off on this host. Nothing changed.\n" {
		t.Fatalf("%d %q", code, stdout)
	}
}

func TestUpdateOffJSON(t *testing.T) {
	h := newUpdateHost(t)
	h.withdraw = agent.UpdateWithdrawal{PolicyOff: true, StepRemoved: true, KeysKept: 2}
	_, stdout, _ := h.run(noTerminalAt, "off", "--json")
	var out map[string]any
	if json.Unmarshal([]byte(stdout), &out) != nil || out["command"] != "update off" || out["changed"] != true || out["policy_off"] != true || out["discarded"] != false || out["step_removed"] != true || out["keys_kept"] != float64(2) {
		t.Fatalf("%q", stdout)
	}
	// Nothing was left, and the document says so.
	if left, there := out["staged_left"]; !there || left != nil {
		t.Fatalf("staged_left is %v (there: %v) when nothing was left", left, there)
	}
}

// Where root may not delete through the directory above the state directory, the
// agent's staged files are left. update off still withdraws consent and removes
// the step, and says in words and in JSON that the files are for a person to
// delete.
func TestUpdateOffSaysWhenTheStagedFilesWereLeft(t *testing.T) {
	h := newUpdateHost(t)
	left := &agent.UpdateLeft{Path: filepath.Join(h.dir, "updates"), Code: "UNTRUSTED_LOCATION", Detail: filepath.Dir(h.dir) + " is writable by its group (mode 0775)"}
	root := "root"
	if runtime.GOOS == "windows" {
		root = "an administrator"
	}
	message := "The staged files in " + left.Path + " were not deleted: the directory above the agent's state isn't owned by " + root + ", so " + root + " won't delete through it. Delete them yourself."
	h.withdraw = agent.UpdateWithdrawal{PolicyOff: true, StepRemoved: true, KeysKept: 1, StagedLeft: left}
	code, stdout, stderr := h.run(noTerminalAt, "off")
	want := "Agent updates are off on this host: the policy says off, the update step is removed.\nThe pinned key is kept. To turn updates on again, run the Upgrade agent command with --updates.\n" + message + "\n"
	if code != 0 || stdout != want || stderr != "" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	// Run again with the files still there: nothing else changed, and the files are
	// still said to be left.
	h.withdraw = agent.UpdateWithdrawal{StagedLeft: left}
	if code, stdout, _ = h.run(noTerminalAt, "off"); code != 0 || stdout != "Agent updates are already off on this host. Nothing changed.\n"+message+"\n" {
		t.Fatalf("%d %q", code, stdout)
	}
	h.withdraw = agent.UpdateWithdrawal{PolicyOff: true, StepRemoved: true, KeysKept: 1, StagedLeft: left}
	code, stdout, stderr = h.run(noTerminalAt, "off", "--json")
	var out struct {
		Changed    bool              `json:"changed"`
		Discarded  bool              `json:"discarded"`
		StagedLeft map[string]string `json:"staged_left"`
	}
	if code != 0 || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil || !out.Changed || out.Discarded {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	if got := out.StagedLeft; len(got) != 4 || got["path"] != left.Path || got["code"] != "UNTRUSTED_LOCATION" || got["detail"] != left.Detail || got["message"] != message {
		t.Fatalf("%q", stdout)
	}
}

// Taking the step away while it applies or tries a build could leave a build
// that was never proven in place of the one that was: it is refused, and the
// command says when to come back.
func TestUpdateOffIsRefusedWhileABuildIsBeingTried(t *testing.T) {
	h := newUpdateHost(t)
	h.withErr = &agent.UpdateBusyError{Message: "an update is being tried on this host; it ends by 02:19"}
	code, stdout, stderr := h.run(noTerminalAt, "off")
	if code != 1 || stdout != "" || stderr != "vectory: an update is being tried on this host; it ends by 02:19. Run the command again after that\n" {
		t.Fatalf("%d %q %q", code, stdout, stderr)
	}
	h.withErr = errors.New("systemctl refused")
	if code, _, stderr = h.run(noTerminalAt, "off"); code != 1 || stderr != "vectory: systemctl refused\n" {
		t.Fatalf("%d %q", code, stderr)
	}
}

func TestUpdateIsAGroupInTheDayToDayList(t *testing.T) {
	code, stdout, _ := invoke("help")
	if code != 0 || !strings.Contains(stdout, "  update              Show, apply, pause or turn off agent updates on this host\n") {
		t.Fatalf("%d\n%s", code, stdout)
	}
	if code, _, stderr := invoke("update"); code != 2 || !strings.Contains(stderr, "Verbs:\n  status  Show what this host consented to and where an update stands") {
		t.Fatalf("%d %q", code, stderr)
	}
	if code, _, stderr := invoke("update", "stop"); code != 2 || !strings.Contains(stderr, `unknown verb "stop"`) {
		t.Fatalf("%d %q", code, stderr)
	}
}
