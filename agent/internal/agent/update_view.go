package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

// What this host says about agent updates, read without changing anything. One
// view feeds `vectory status` (one line), `vectory update status` (the detail),
// `vectory update apply` (what the agent last reported) and the doctor, so that
// every command says the same thing the same way.
//
// The files the privileged step writes (status.json) are read through the path
// check: they are root's and trustworthy. The files the agent writes in its state
// directory (request.json, health.json and what it staged) belong to the service
// account, so everything read from them is advice for a person, never a decision:
// the step verifies the signed manifest, the pins and the policy itself.

// updateStepFresh is how recently the privileged step must have run to count as
// running: it runs every 30 seconds, and a status older than two minutes means it
// does not.
const updateStepFresh = 2 * time.Minute

// StagedUpdate is the build the agent staged and asked the step to apply.
type StagedUpdate struct {
	// ManifestSHA256 names the release, and OfferedAt says when the agent staged it.
	ManifestSHA256 string
	OfferedAt      time.Time
	RolloutID      string
	// Version is read from the staged release.json for display; empty when that
	// file can't be read. Size is the staged build's size, and Complete says the
	// build is there under its final name.
	Version  string
	Size     int64
	Complete bool
}

// UpdateView is what a host says about agent updates.
type UpdateView struct {
	StateDir string
	ReadAt   time.Time

	// LocalPaused says `vectory pause` is in force: the host changes nothing,
	// updates included.
	LocalPaused bool

	// Policy is the host's consent; with no policy file, or one that can't be
	// used, it is the default, which takes no update. PolicyFile says there is a
	// file, and PolicyProblem says why a file that is there can't be used.
	Policy        UpdatePolicy
	PolicyFile    bool
	PolicyProblem string

	// Status is what the step last wrote, nil when it never ran here or its
	// status can't be read (StatusProblem). StepRunning says it ran in the last two
	// minutes.
	Status        *UpdateStatus
	StatusProblem string
	StepRunning   bool

	// Eligibility is what this host reports: eligible, or the code that says why it
	// can't take an update.
	Eligibility string

	Staged *StagedUpdate
	// Health is what the agent last wrote after a check-in, nil when it wrote none.
	Health *UpdateHealth
}

// ReadUpdateView reads the host's update policy, the step's status and what the
// agent staged and last reported, at the time now. It never fails: what it can't
// read is left empty and, where it matters, explained.
func ReadUpdateView(dir string, now time.Time) UpdateView {
	return readUpdateView(dir, now, UpdateEligibility)
}

// readUpdateView is ReadUpdateView with the step's own answer about a host that
// has not installed it passed in.
func readUpdateView(dir string, now time.Time, probe func(dir string) string) UpdateView {
	v := UpdateView{StateDir: dir, ReadAt: now, Policy: DefaultUpdatePolicy(), LocalPaused: dir != "" && LocalPaused(dir)}
	policy, basis, err := readUpdatePolicy(UpdateLocations())
	switch {
	case err == nil:
		v.Policy, v.PolicyFile = policy, basis != ""
	case errors.Is(err, ErrUpdatePolicyInvalid):
		v.PolicyFile, v.PolicyProblem = true, invalidPolicyWords(err)
	default:
		v.PolicyFile, v.PolicyProblem = true, untrustedDetail(err)
	}
	if status, err := ReadUpdateStatus(); err == nil {
		v.Status = &status
		v.StepRunning = updateStepFreshAt(status.RunAt, now)
	} else if !notExist(err) {
		v.StatusProblem = untrustedDetail(err)
	}
	if dir != "" {
		exchange := UpdateExchangeFor(dir)
		if health, err := ReadUpdateHealth(exchange.Health); err == nil {
			v.Health = &health
		}
		v.Staged = readStagedUpdate(exchange)
	}
	v.Eligibility = hostEligibility(dir, v.Policy.Consent, v.Status, now, probe)
	return v
}

// updateStepFreshAt reports whether a status written at runAt shows a step that
// runs, judged on this host's clock.
func updateStepFreshAt(runAt, now time.Time) bool {
	age := now.Sub(runAt)
	return age <= updateStepFresh && age >= -updateStepFresh
}

// hostEligibility is the eligibility a host reports. The step's own answer, in the
// status it wrote lately, wins. A host that consented but whose step hasn't run
// lately says so (HELPER_NOT_RUNNING). A host that has not consented has no step,
// which is no fault: it says what the step would say about the host, and eligible
// where all that is missing is the step.
func hostEligibility(dir, consent string, status *UpdateStatus, now time.Time, probe func(dir string) string) string {
	switch {
	case status != nil && updateStepFreshAt(status.RunAt, now):
		return status.Eligibility
	case consent != UpdateConsentOff:
		return "HELPER_NOT_RUNNING"
	}
	if code := probe(dir); code != "HELPER_NOT_RUNNING" {
		return code
	}
	return UpdateEligible
}

// readStagedUpdate describes what the agent staged, from request.json, which it
// writes last; nil when there is no request.
func readStagedUpdate(exchange UpdateExchange) *StagedUpdate {
	request, err := ReadUpdateRequest(exchange.Request)
	if err != nil {
		return nil
	}
	staged := &StagedUpdate{ManifestSHA256: request.ManifestSHA256, OfferedAt: request.OfferedAt, RolloutID: request.RolloutID}
	incoming, err := exchange.IncomingDir(request.ManifestSHA256)
	if err != nil {
		return staged
	}
	if raw, err := readUpdateFile(filepath.Join(incoming, UpdateReleaseFile), MaxReleaseManifest); err == nil {
		if manifest, err := ParseReleaseManifest(raw); err == nil {
			staged.Version = manifest.Version
		}
	}
	if info, err := os.Lstat(filepath.Join(incoming, UpdateBuildFile(runtime.GOOS))); err == nil && info.Mode().IsRegular() {
		staged.Size, staged.Complete = info.Size(), true
	}
	return staged
}

// ---------------------------------------------------------------- what it says

// Conflict is the fork that stops this host's updates, or nil. It is the step's
// own record, and counts only while the key it names is still pinned: setting the
// host up again with another key ends it.
func (v UpdateView) Conflict() *RolloverConflict {
	if v.Status == nil || v.Status.RolloverConflict == nil {
		return nil
	}
	conflict := v.Status.RolloverConflict
	if !slices.Contains(v.Policy.Fingerprints(), conflict.From) {
		return nil
	}
	return conflict
}

// fingerprintPrefix is the short ID of a fingerprint.
func fingerprintPrefix(fingerprint string) string {
	if len(fingerprint) > 16 {
		return fingerprint[:16]
	}
	return fingerprint
}

// windowState says whether a window is open now and, if not, when the next opens.
func (v UpdateView) windowState() (open bool, next time.Time, hasNext bool) {
	windows, err := v.Policy.ParsedWindows()
	if err != nil {
		return true, time.Time{}, false
	}
	now := v.ReadAt.Local()
	if windows.OpenAt(now) {
		return true, time.Time{}, false
	}
	next, hasNext = windows.NextStart(now)
	return false, next, hasNext
}

// PolicyLine says what the host consented to: "automatic · patch releases ·
// Mon–Fri 02:00–04:00 (next in 6 h) · key 3f9a1c0277de9b41", and that it is paused
// when it is.
func (v UpdateView) PolicyLine() string {
	p := v.Policy
	windows := UpdateWindowsWords(p.Windows)
	if len(p.Windows) > 0 {
		if open, next, hasNext := v.windowState(); open {
			windows += " (open now)"
		} else if hasNext {
			windows += " (next " + untilWords(next.Sub(v.ReadAt)) + ")"
		}
	}
	line := strings.Join([]string{UpdateConsentWords(p.Consent), UpdateTrackWords(p.Track), windows, UpdateKeysWords(p.PinnedKeys())}, " · ")
	switch {
	case p.Paused:
		line += " · paused: " + AdminCommandFor(v.StateDir, "vectory update resume")
	case v.LocalPaused:
		line += " · paused with vectory pause: " + AdminCommandFor(v.StateDir, "vectory resume")
	}
	return line
}

// stagedWords says what a staged build waits for.
func (v UpdateView) stagedWords() string {
	staged := v.Staged
	what := "an update"
	if staged.Version != "" {
		what = staged.Version
	}
	switch {
	case v.Policy.Consent == UpdateConsentAsk:
		return "staged " + what + ", waiting for you: " + AdminCommandFor(v.StateDir, "vectory update apply")
	case !v.StepRunning:
		return "staged " + what + ", but the update step isn't running: " + AdminCommandFor(v.StateDir, "vectory doctor") + " says why"
	}
	if open, next, hasNext := v.windowState(); !open {
		words := "staged " + what + ", waiting for its window"
		if hasNext {
			words += " (opens " + untilWords(next.Sub(v.ReadAt)) + ")"
		}
		return words
	}
	return "staged " + what + ", the update step applies it within a minute"
}

// lastWords says how the last update ended, in a sentence that stands alone: "0.1.0
// → 0.1.1 at 02:14 · first check-in 2.1 s after restart". ok is false when the
// result isn't one worth a line yet (an update that committed more than a day ago).
func (v UpdateView) lastWords() (words string, ok bool) {
	if v.Status == nil || v.Status.Last == nil {
		return "", false
	}
	last := v.Status.Last
	at := humanDayClock(last.At, v.ReadAt)
	to := last.ToVersion
	switch last.Outcome {
	case UpdateOutcomeCommitted:
		if v.ReadAt.Sub(last.At) > 24*time.Hour {
			return "", false
		}
		words = last.FromVersion + " → " + to + " at " + at
		if last.FirstCheckInMS != nil {
			words += " · first check-in " + humanLatency(time.Duration(*last.FirstCheckInMS)*time.Millisecond) + " after restart"
		}
		return words, true
	case UpdateOutcomeRolledBack:
		from := to
		if from == "" {
			from = "an update"
		}
		if last.Code == "ROLLBACK_UNHEALTHY" {
			words = "rolled back from " + from + " at " + at + ", and the previous build hasn't checked in either: check the network and the server"
		} else {
			words = "rolled back from " + from + " at " + at + ": " + updateCodeWords(last.Code)
		}
		if to != "" {
			words += "; this host won't try " + to + " again"
		}
		return words, true
	case UpdateOutcomeFailed:
		if to == "" {
			return "couldn't apply an update at " + at + ": " + updateCodeWords(last.Code), true
		}
		return "couldn't update to " + to + " at " + at + ": " + updateCodeWords(last.Code), true
	}
	if to == "" {
		return "refused an update at " + at + ": " + updateCodeWords(last.Code), true
	}
	return "refused " + to + " at " + at + ": " + updateCodeWords(last.Code), true
}

// LastResultWords says how the last update ended, in a clause that stands alone,
// or reports false when there is no result worth a line.
func (v UpdateView) LastResultWords() (string, bool) { return v.lastWords() }

// busyWords says what the step is doing, or "" while it is idle.
func (v UpdateView) busyWords() string {
	s := v.Status
	if s == nil {
		return ""
	}
	switch s.Stage {
	case UpdateStagePreparing, UpdateStageSwapping:
		return "applying " + s.FromVersion + " → " + s.ToVersion
	case UpdateStageTrial:
		words := "trying " + s.ToVersion + " (from " + s.FromVersion + ")"
		if !s.Deadline.IsZero() {
			words += " · ends by " + humanClock(s.Deadline)
		}
		return words
	case UpdateStageRollingBack:
		return "rolling back from " + s.ToVersion
	}
	return ""
}

// conflictSentence says what a fork is and what to do about it.
func conflictSentence(conflict *RolloverConflict) string {
	return "two successors of key " + fingerprintPrefix(conflict.From) + " were seen, " + fingerprintPrefix(conflict.To[0]) + " and " + fingerprintPrefix(conflict.To[1]) + ": run the Upgrade agent command with the right key"
}

// Headline is the one line `vectory status` shows: what needs attention first,
// and otherwise what the host consented to.
func (v UpdateView) Headline() string {
	p := v.Policy
	switch {
	case v.PolicyProblem != "":
		return "off · the update policy can't be used: " + v.PolicyProblem
	case p.Consent == UpdateConsentOff:
		switch v.Eligibility {
		case "PLATFORM_NOT_IN_RELEASE":
			return "not in this release for " + platformName(runtime.GOOS) + ": hosts of this kind update by hand"
		case "PACKAGE_MANAGED":
			return "off on this host · installed from a package, so the package manager updates it"
		}
		return "off on this host"
	}
	if conflict := v.Conflict(); conflict != nil {
		return "stopped · " + conflictSentence(conflict)
	}
	if words := v.busyWords(); words != "" {
		return words
	}
	if p.Paused || v.LocalPaused {
		return v.PolicyLine()
	}
	if v.Staged != nil && v.Staged.Complete {
		return v.stagedWords()
	}
	if words, ok := v.lastWords(); ok {
		return words
	}
	return v.PolicyLine()
}

// UpdateRow is one labelled line of `vectory update status`.
type UpdateRow struct{ Label, Value string }

// Rows are the lines of `vectory update status`: the policy, then whatever is
// true of this host's update step, what is staged and how the last update ended.
func (v UpdateView) Rows() []UpdateRow {
	rows := []UpdateRow{{"Updates", v.updatesRow()}}
	for _, pinned := range v.Policy.Keys {
		rows = append(rows, UpdateRow{"Key", pinned.Key.ShortID() + " · " + pinned.Key.Name() + " · pinned " + pinned.PinnedAt.Local().Format("2 Jan 2006 15:04")})
	}
	if v.PolicyProblem == "" {
		rows = append(rows, UpdateRow{"Eligibility", v.eligibilityRow()})
	}
	if step := v.stepRow(); step != "" {
		rows = append(rows, UpdateRow{"Update step", step})
	}
	if conflict := v.Conflict(); conflict != nil {
		rows = append(rows, UpdateRow{"Stopped", conflictSentence(conflict)})
	}
	if words := v.busyWords(); words != "" {
		rows = append(rows, UpdateRow{"In progress", words})
	}
	if v.Staged != nil {
		rows = append(rows, UpdateRow{"Staged", v.stagedRow()})
	}
	if words, ok := v.lastWords(); ok {
		rows = append(rows, UpdateRow{"Last result", words})
	}
	return rows
}

func (v UpdateView) updatesRow() string {
	if v.PolicyProblem != "" {
		return "off · the update policy can't be used: " + v.PolicyProblem
	}
	if v.Policy.Consent == UpdateConsentOff {
		if v.PolicyFile && len(v.Policy.Keys) > 0 {
			return "off on this host · " + UpdateKeysWords(v.Policy.PinnedKeys()) + " kept for turning updates on again"
		}
		return "off on this host"
	}
	return v.PolicyLine()
}

func (v UpdateView) eligibilityRow() string {
	if v.Eligibility == UpdateEligible {
		if v.Policy.Consent == UpdateConsentOff {
			return "this host could take updates: the Upgrade agent command turns them on"
		}
		return "this host can take updates"
	}
	return updateEligibilityWords(v.Eligibility) + " (" + v.Eligibility + ")"
}

func (v UpdateView) stepRow() string {
	switch {
	case v.Status != nil && v.StepRunning:
		return "running · last ran " + ago(v.ReadAt, v.Status.RunAt) + " · service definition " + fmt.Sprint(v.Status.ServiceDefinition)
	case v.Status != nil:
		return "not running · last ran " + ago(v.ReadAt, v.Status.RunAt)
	case v.StatusProblem != "":
		return "its status can't be read: " + v.StatusProblem
	case v.Policy.Consent != UpdateConsentOff:
		return "not running · it hasn't written a status yet"
	}
	return ""
}

func (v UpdateView) stagedRow() string {
	staged := v.Staged
	what := "an update"
	if staged.Version != "" {
		what = staged.Version
	}
	if staged.Size > 0 {
		what += " (" + byteSize(staged.Size) + ")"
	}
	state := "offered " + humanDayClock(staged.OfferedAt, v.ReadAt)
	if !staged.Complete {
		state += " · the build isn't complete"
	}
	return what + " · " + state
}

// ---------------------------------------------------------------- advice for apply

// OfferAdvice is what the agent last reported about the offer in front of it,
// against what is staged: advice for the person at the keyboard, never evidence.
// The file it is read from belongs to the service account, so a forged one can at
// worst make this command ask a question or stay quiet; the step verifies the
// signed manifest, the pins and the policy itself before anything is installed.
type OfferAdvice struct {
	// Reported says the agent wrote a report at all, and ReportedAt is when its
	// last check-in was answered.
	Reported   bool
	ReportedAt time.Time
	Age        time.Duration
	// OfferGone says the report names no offer, or another one, than the staged
	// build.
	OfferGone bool
	// Stale says the report is more than five minutes old.
	Stale bool
}

// offerStale is how old a report may be before `vectory update apply` asks.
const offerStale = 5 * time.Minute

// Advice compares the agent's last report with the staged build.
func (v UpdateView) Advice() OfferAdvice {
	advice := OfferAdvice{}
	if v.Health == nil {
		advice.OfferGone, advice.Stale = true, true
		return advice
	}
	advice.Reported, advice.ReportedAt = true, v.Health.CheckedInAt
	advice.Age = v.ReadAt.Sub(v.Health.CheckedInAt)
	advice.Stale = advice.Age > offerStale
	advice.OfferGone = v.Staged == nil || v.Health.Offer != v.Staged.ManifestSHA256
	return advice
}

// Refuses says whether apply should refuse without --force.
func (a OfferAdvice) Refuses() bool { return a.OfferGone || a.Stale }

// Words say what the agent last reported about the offer and how old that is, as
// apply shows it before it starts.
func (a OfferAdvice) Words(version string) string {
	if !a.Reported {
		return "The agent hasn't reported on the offer yet."
	}
	what := "the staged build"
	if version != "" {
		what = version
	}
	age := humanDuration(a.Age)
	if a.Age < 5*time.Second {
		age = "just now"
	} else {
		age += " ago"
	}
	if a.OfferGone {
		return "The agent reported " + age + " (" + humanClock(a.ReportedAt) + ") that the server no longer offers " + what + ": a rollout that was paused or cancelled, or Stop all updates, takes the offer away."
	}
	return "The agent reported " + age + " (" + humanClock(a.ReportedAt) + ") that the server offers " + what + "."
}
