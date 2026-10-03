package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// The heartbeat member `agent_update`: what this host says about agent updates in
// every check-in while the server's manifest lists the feature. It is a report,
// never a request: the server decides what to offer from it, and what the agent
// does with an offer comes from the host's root-owned policy and the privileged
// step's status, which the report only repeats.
//
// A malformed member is a 400 for the whole heartbeat, and no report may take a
// device off the control plane. So the agent checks what it is about to send with
// the rules the server applies (validateAgentUpdateMember, whose bounds are the
// shared fixture's) and leaves the member out of a check-in it can't make right;
// and if a server refuses a heartbeat that carries it anyway, exchange leaves it
// out first and for the rest of the process.

// featureAgentUpdate is listed in the signed manifest's features while the server
// has agent updates on. Agents send the member only to a server that lists it.
const featureAgentUpdate = "agent_update"

// The states a host reports.
const (
	UpdateStateIdle             = "idle"
	UpdateStateDownloading      = "downloading"
	UpdateStateStaged           = "staged"
	UpdateStateWaitingForHost   = "waiting_for_host"
	UpdateStateWaitingForWindow = "waiting_for_window"
	UpdateStateApplying         = "applying"
	UpdateStateTrial            = "trial"
	UpdateStateRefused          = "refused"
	UpdateStateFailed           = "failed"
)

var updateStates = []string{
	UpdateStateIdle, UpdateStateDownloading, UpdateStateStaged, UpdateStateWaitingForHost, UpdateStateWaitingForWindow,
	UpdateStateApplying, UpdateStateTrial, UpdateStateRefused, UpdateStateFailed,
}

// AgentUpdateReport is the heartbeat member. Its members come in the contract's
// order; Windows and Keys are never null, and a member that has nothing to say is
// left out.
type AgentUpdateReport struct {
	Consent           string            `json:"consent"`
	Paused            bool              `json:"paused"`
	Track             string            `json:"track"`
	Windows           []string          `json:"windows"`
	WindowOpen        bool              `json:"window_open"`
	NextWindowAt      string            `json:"next_window_at,omitempty"`
	Keys              []string          `json:"keys"`
	HighestCounter    uint64            `json:"highest_counter"`
	Eligibility       string            `json:"eligibility"`
	ServiceDefinition int               `json:"service_definition,omitempty"`
	State             string            `json:"state"`
	Release           string            `json:"release,omitempty"`
	Code              string            `json:"code,omitempty"`
	RolloverConflict  *RolloverConflict `json:"rollover_conflict,omitempty"`
	Last              *UpdateLast       `json:"last,omitempty"`
}

// The bounds of the member, which the server's parser keeps to and the shared
// fixture (contracts/fixtures/agent-release/report.json) states. A test fails when
// one of them stops being the fixture's.
const (
	reportMaxKeys         = maxPinnedKeys
	reportMaxWindows      = maxUpdateWindows
	reportMaxWindowChars  = maxUpdateWindowChars
	reportFingerprintSize = 64
)

// statesAboutARelease are the states that name the release they are about.
var statesAboutARelease = []string{
	UpdateStateDownloading, UpdateStateStaged, UpdateStateWaitingForHost, UpdateStateWaitingForWindow, UpdateStateApplying, UpdateStateTrial,
}

// Validate refuses a report the server would refuse, by the rules of the member.
func (r AgentUpdateReport) Validate() error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return validateAgentUpdateMember(data)
}

// validateAgentUpdateMember applies the server's rules to the bytes of a member:
// the members it holds and no others, each of the kind and within the bounds the
// contract lists, and the combinations the contract forbids (a host that is off
// reports idle, a state about a release names it, a refusal has a code, a fork and
// its code go together). A null counts as absent for an optional member.
func validateAgentUpdateMember(data []byte) error {
	var member map[string]json.RawMessage
	if err := decodeObject(data, &member); err != nil {
		return fmt.Errorf("the member isn't an object: %w", err)
	}
	known := map[string]bool{
		"consent": true, "paused": true, "track": true, "windows": true, "window_open": true, "next_window_at": true, "keys": true,
		"highest_counter": true, "eligibility": true, "service_definition": true, "state": true, "release": true, "code": true,
		"rollover_conflict": true, "last": true,
	}
	for name := range member {
		if !known[name] {
			return fmt.Errorf("%q isn't a member of the report", name)
		}
	}
	present := func(name string) (json.RawMessage, bool) {
		raw, ok := member[name]
		return raw, ok && string(bytes.TrimSpace(raw)) != "null"
	}
	for _, name := range []string{"consent", "paused", "track", "windows", "window_open", "keys", "highest_counter", "eligibility", "state"} {
		if _, ok := present(name); !ok {
			return fmt.Errorf("%q is required", name)
		}
	}
	text := func(name string) (string, error) {
		var value string
		if err := decodeValue(member[name], &value); err != nil {
			return "", fmt.Errorf("%q isn't a string", name)
		}
		return value, nil
	}
	consent, err := text("consent")
	if err != nil {
		return err
	}
	if !oneOf(consent, []string{UpdateConsentOff, UpdateConsentAuto, UpdateConsentAsk}) {
		return fmt.Errorf("consent %q isn't off, auto or ask", consent)
	}
	track, err := text("track")
	if err != nil {
		return err
	}
	if !oneOf(track, []string{UpdateTrackPatch, UpdateTrackMinor}) {
		return fmt.Errorf("track %q isn't patch or minor", track)
	}
	for _, name := range []string{"paused", "window_open"} {
		var value bool
		if err := decodeValue(member[name], &value); err != nil {
			return fmt.Errorf("%q isn't true or false", name)
		}
	}
	var windows []json.RawMessage
	if err := decodeValue(member["windows"], &windows); err != nil {
		return errors.New("windows isn't a list")
	}
	if len(windows) > reportMaxWindows {
		return fmt.Errorf("%d windows, and at most %d are allowed", len(windows), reportMaxWindows)
	}
	for _, raw := range windows {
		var window string
		if err := decodeValue(raw, &window); err != nil {
			return errors.New("a window isn't a string")
		}
		if err := printableASCII(window, 1, reportMaxWindowChars); err != nil {
			return fmt.Errorf("window %q: %w", window, err)
		}
	}
	if raw, ok := present("next_window_at"); ok {
		var instant string
		if decodeValue(raw, &instant) != nil {
			return errors.New("next_window_at isn't a string")
		}
		if _, ok := parseUpdateInstant(instant, false); !ok {
			return fmt.Errorf("next_window_at %q isn't a UTC time", instant)
		}
	}
	var keys []string
	if err := decodeValue(member["keys"], &keys); err != nil {
		return errors.New("keys isn't a list of fingerprints")
	}
	if len(keys) > reportMaxKeys {
		return fmt.Errorf("%d keys, and at most %d are allowed", len(keys), reportMaxKeys)
	}
	for i, key := range keys {
		if !isLowerHex64(key) {
			return fmt.Errorf("key %d isn't 64 lowercase hexadecimal characters", i+1)
		}
		if slices.Contains(keys[:i], key) {
			return fmt.Errorf("key %d is listed twice", i+1)
		}
	}
	if err := wholeNumber(member["highest_counter"], "highest_counter", 0, MaxJSONCounter); err != nil {
		return err
	}
	eligibility, err := text("eligibility")
	if err != nil {
		return err
	}
	if !oneOf(eligibility, updateEligibilities) {
		return fmt.Errorf("eligibility %q isn't eligible or the code of a reason", eligibility)
	}
	if raw, ok := present("service_definition"); ok {
		if err := wholeNumber(raw, "service_definition", 1, maxUpdateServiceGeneration); err != nil {
			return err
		}
	}
	state, err := text("state")
	if err != nil {
		return err
	}
	if !oneOf(state, updateStates) {
		return fmt.Errorf("state %q isn't a state of an update", state)
	}
	release := ""
	if raw, ok := present("release"); ok {
		if err := decodeValue(raw, &release); err != nil || !isLowerHex64(release) {
			return errors.New("release isn't a 64-character lowercase digest")
		}
	}
	code := ""
	if raw, ok := present("code"); ok {
		if err := decodeValue(raw, &code); err != nil || !IsUpdateCode(code) {
			return fmt.Errorf("code %q isn't an agent code", code)
		}
	}
	switch {
	case consent == UpdateConsentOff && state != UpdateStateIdle:
		return errors.New("a host that is off reports idle")
	case slices.Contains(statesAboutARelease, state) && release == "":
		return fmt.Errorf("the state %s is about a release, and the report names none", state)
	case (state == UpdateStateRefused || state == UpdateStateFailed) && code == "":
		return fmt.Errorf("the state %s has no code", state)
	}
	raw, conflict := present("rollover_conflict")
	if conflict != (code == "KEY_ROLLOVER_CONFLICT") {
		return errors.New("rollover_conflict and the code KEY_ROLLOVER_CONFLICT go together")
	}
	if conflict {
		if err := validateConflictMember(raw); err != nil {
			return err
		}
	}
	if raw, ok := present("last"); ok {
		if err := validateLastMember(raw); err != nil {
			return err
		}
	}
	return nil
}

// decodeObject and decodeValue read JSON as the server does: a number is a number
// (never a string that looks like one), and the whole value is read.
func decodeObject(data []byte, into *map[string]json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	if *into == nil {
		return errors.New("it is null")
	}
	return nil
}

func decodeValue(raw json.RawMessage, into any) error {
	if raw == nil {
		return errors.New("it is missing")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	return nil
}

// wholeNumber checks a JSON number that must be an integer from low to high.
func wholeNumber(raw json.RawMessage, name string, low, high uint64) error {
	var number json.Number
	if err := decodeValue(raw, &number); err != nil {
		return fmt.Errorf("%s isn't a number", name)
	}
	text := number.String()
	if text == "" || strings.Trim(text, "0123456789") != "" {
		return fmt.Errorf("%s is %s, and it is a whole number from %d to %d", name, text, low, high)
	}
	var value uint64
	for _, digit := range text {
		if value > high/10+1 {
			return fmt.Errorf("%s is above %d", name, high)
		}
		value = value*10 + uint64(digit-'0')
	}
	if len(text) > 1 && text[0] == '0' || value < low || value > high {
		return fmt.Errorf("%s is %s, and it is a whole number from %d to %d", name, text, low, high)
	}
	return nil
}

// printableASCII checks that text is from low to high printable ASCII characters.
func printableASCII(text string, low, high int) error {
	if len(text) < low || len(text) > high {
		return fmt.Errorf("it is %d characters, and it is from %d to %d", len(text), low, high)
	}
	for i := 0; i < len(text); i++ {
		if text[i] < 0x20 || text[i] > 0x7e {
			return errors.New("it holds a character other than printable ASCII")
		}
	}
	return nil
}

func validateConflictMember(raw json.RawMessage) error {
	var conflict struct {
		From string   `json:"from"`
		To   []string `json:"to"`
	}
	if err := decodeStrictJSON(raw, &conflict); err != nil {
		return fmt.Errorf("rollover_conflict %w", err)
	}
	if !isLowerHex64(conflict.From) || len(conflict.To) != 2 || !isLowerHex64(conflict.To[0]) || !isLowerHex64(conflict.To[1]) {
		return errors.New("rollover_conflict is a fingerprint and exactly two successors")
	}
	if conflict.To[0] == conflict.To[1] || conflict.From == conflict.To[0] || conflict.From == conflict.To[1] {
		return errors.New("the successors of a fork differ from each other and from the key")
	}
	return nil
}

// validateLastMember applies the rules of a result: exactly its members, an
// outcome that agrees with its code, and values within their bounds.
func validateLastMember(raw json.RawMessage) error {
	var member map[string]json.RawMessage
	if err := decodeObject(raw, &member); err != nil {
		return errors.New("last isn't an object")
	}
	for name := range member {
		if !oneOf(name, []string{"release", "outcome", "code", "at", "from_version", "to_version", "first_check_in_ms"}) {
			return fmt.Errorf("%q isn't a member of a result", name)
		}
	}
	for _, name := range []string{"release", "outcome", "code", "at", "from_version", "to_version"} {
		if _, ok := member[name]; !ok {
			return fmt.Errorf("a result has no %q", name)
		}
	}
	null := func(name string) bool { return string(bytes.TrimSpace(member[name])) == "null" }
	var release, outcome, at, from string
	for name, into := range map[string]*string{"release": &release, "outcome": &outcome, "at": &at, "from_version": &from} {
		if decodeValue(member[name], into) != nil {
			return fmt.Errorf("%q of a result isn't a string", name)
		}
	}
	switch {
	case !isLowerHex64(release):
		return errors.New("the release of a result isn't a 64-character lowercase digest")
	case !oneOf(outcome, updateOutcomes):
		return fmt.Errorf("the outcome %q isn't committed, rolled_back, failed or refused", outcome)
	}
	if _, ok := parseUpdateInstant(at, false); !ok {
		return fmt.Errorf("the time of a result, %q, isn't a UTC time", at)
	}
	if !validUpdateText(from) {
		return errors.New("from_version of a result isn't 1 to 128 bytes without control characters")
	}
	if !null("code") {
		var code string
		if decodeValue(member["code"], &code) != nil || !IsUpdateCode(code) {
			return errors.New("the code of a result isn't an agent code")
		}
	}
	if (outcome == UpdateOutcomeCommitted) != null("code") {
		return errors.New("a result that committed has no code, and every other result has one")
	}
	if !null("to_version") {
		var to string
		if decodeValue(member["to_version"], &to) != nil || !validUpdateVersion(to) {
			return errors.New("to_version of a result is a version or null")
		}
	}
	if raw, ok := member["first_check_in_ms"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		if err := wholeNumber(raw, "first_check_in_ms", 0, maxFirstCheckInMS); err != nil {
			return err
		}
	}
	if !utf8.ValidString(from) {
		return errors.New("from_version isn't UTF-8")
	}
	return nil
}

// ---------------------------------------------------------------- building it

// updateFacts is what a report is made from, read once for a check-in.
type updateFacts struct {
	policy   UpdatePolicy
	policyOK bool // false: the policy can't be used, and the host takes no update
	// untrusted says the policy couldn't be read because its place can't be trusted.
	untrusted bool
	status    *UpdateStatus
	stepFresh bool
	localStop bool // vectory pause
	now       time.Time
}

// readUpdateFacts reads the host's policy and the step's status.
func (e *Engine) readUpdateFacts() updateFacts {
	facts := updateFacts{policy: DefaultUpdatePolicy(), now: e.now(), localStop: LocalPaused(e.Dir)}
	policy, _, err := readUpdatePolicy(UpdateLocations())
	switch {
	case err == nil:
		facts.policy, facts.policyOK = policy, true
	default:
		var refusal *UpdateRefusal
		facts.untrusted = errors.As(err, &refusal) && refusal.Code == codeUntrustedLocation
	}
	if status, err := ReadUpdateStatus(); err == nil {
		facts.status = &status
		facts.stepFresh = updateStepFreshAt(status.RunAt, facts.now)
	}
	return facts
}

// agentUpdateReport builds the member for this check-in, or nil when it can't be
// built the way the server accepts it (the check-in then goes without it).
func (e *Engine) agentUpdateReport() *AgentUpdateReport {
	run := &e.update
	run.unreported = false
	facts := e.readUpdateFacts()
	report := e.buildAgentUpdateReport(facts)
	if err := report.Validate(); err != nil {
		e.sayOnce("report", "The agent update report was left out of a check-in: "+err.Error()+".")
		return nil
	}
	// What this report carries is what the next check-in doesn't need to be asked
	// for early: a result of the step, and a build on trial that the step will
	// judge (updateAttention).
	run.sentLast = resultKey(report.Last)
	run.trial = report.State == UpdateStateTrial && facts.status != nil && facts.status.ToVersion == Version
	return &report
}

func (e *Engine) buildAgentUpdateReport(facts updateFacts) AgentUpdateReport {
	policy := facts.policy
	report := AgentUpdateReport{
		Consent: policy.Consent, Paused: policy.Paused, Track: policy.Track,
		Windows: slices.Clone(policy.Windows), Keys: policy.Fingerprints(), WindowOpen: true,
	}
	if report.Windows == nil {
		report.Windows = []string{}
	}
	if windows, err := policy.ParsedWindows(); err == nil && len(windows) > 0 {
		local := facts.now.Local()
		if report.WindowOpen = windows.OpenAt(local); !report.WindowOpen {
			if next, ok := windows.NextStart(local); ok {
				report.NextWindowAt = next.UTC().Format(updateSecondsLayout)
			}
		}
	}
	if status := facts.status; status != nil {
		for _, counter := range status.HighestCounters {
			report.HighestCounter = max(report.HighestCounter, counter)
		}
		report.ServiceDefinition = status.ServiceDefinition
		if status.Last != nil {
			last := *status.Last
			report.Last = &last
		}
	}
	report.Eligibility = e.reportEligibility(facts)
	report.State, report.Release, report.Code, report.RolloverConflict = e.reportState(facts)
	if report.Consent == UpdateConsentOff {
		// A host that is off reports idle, and names nothing it is about.
		report.State, report.Release = UpdateStateIdle, ""
	}
	return report
}

// probeAge is how long the step's own answer about a host that has not installed
// it is kept: it is read from the file system and the service manager, and a host
// does not change often.
const probeAge = 5 * time.Minute

// reportEligibility is what this host reports as its eligibility (hostEligibility),
// with the step's answer about a host that has no step kept for a few minutes.
func (e *Engine) reportEligibility(facts updateFacts) string {
	if facts.untrusted && (facts.status == nil || !facts.stepFresh) {
		return "UNTRUSTED_LOCATION"
	}
	probe := func(dir string) string {
		if e.update.probeCode != "" && facts.now.Sub(e.update.probedAt) < probeAge {
			return e.update.probeCode
		}
		e.update.probeCode, e.update.probedAt = UpdateEligibility(dir), facts.now
		return e.update.probeCode
	}
	return hostEligibility(e.Dir, facts.policy.Consent, facts.status, facts.now, probe)
}

// reportState is the state of an update on this host, and what it is about. A
// build the step is applying or trying wins, then a fork, then a pause, then what
// this agent decided about the offer in front of it. A build whose request the
// step has finished with (its result names the release) is no longer something
// this agent is waiting on.
func (e *Engine) reportState(facts updateFacts) (state, release, code string, conflict *RolloverConflict) {
	policy, status := facts.policy, facts.status
	decision := e.update.decision
	if policy.Consent == UpdateConsentOff {
		return UpdateStateIdle, "", "UPDATES_OFF", nil
	}
	if status != nil {
		inProgress := status.Release
		if inProgress == "" {
			inProgress = decision.release
		}
		switch {
		case status.Stage == UpdateStageTrial && inProgress != "":
			return UpdateStateTrial, inProgress, "", nil
		case slices.Contains([]string{UpdateStagePreparing, UpdateStageSwapping, UpdateStageRollingBack}, status.Stage) && inProgress != "":
			return UpdateStateApplying, inProgress, "", nil
		}
	}
	if fork := (UpdateView{Policy: policy, Status: status}).Conflict(); fork != nil {
		copied := *fork
		return UpdateStateRefused, decision.release, "KEY_ROLLOVER_CONFLICT", &copied
	}
	if policy.Paused || facts.localStop {
		return UpdateStateIdle, "", "UPDATES_PAUSED", nil
	}
	if status != nil && status.Last != nil && decision.release != "" && status.Last.Release == decision.release {
		return UpdateStateIdle, "", "", nil
	}
	switch decision.state {
	case UpdateStateRefused, UpdateStateFailed:
		var fork *RolloverConflict
		if decision.conflict != nil {
			copied := *decision.conflict
			fork = &copied
		}
		return decision.state, decision.release, decision.code, fork
	case UpdateStateDownloading:
		return UpdateStateDownloading, decision.release, "", nil
	case UpdateStateStaged:
		if policy.Consent == UpdateConsentAsk {
			return UpdateStateWaitingForHost, decision.release, "", nil
		}
		if windows, err := policy.ParsedWindows(); err == nil && !windows.OpenAt(facts.now.Local()) {
			return UpdateStateWaitingForWindow, decision.release, "", nil
		}
		return UpdateStateStaged, decision.release, "", nil
	}
	return UpdateStateIdle, "", "", nil
}

// resultKey identifies a result, so that the agent can tell when the step wrote
// one that no heartbeat has carried.
func resultKey(last *UpdateLast) string {
	if last == nil {
		return ""
	}
	return last.Release + "|" + last.Outcome + "|" + last.At.UTC().Format(updateSecondsLayout)
}
