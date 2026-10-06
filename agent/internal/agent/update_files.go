package agent

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// The files the agent and the privileged step exchange. The agent, which runs as
// the service account, writes request.json, health.json and rollovers.json in
// <state>/updates; the step, which runs as root, writes status.json in its own
// directory (UpdateLocations) and reads the agent's files only by copying them.
// Each is one JSON object with exactly the members the contract lists, every one
// always written (null where nothing applies), at most 4 KiB (rollovers.json: 16).
//
// THE FORMATS OF THESE FILES ARE FIXED WITHIN A service_definition GENERATION.
// Any committed build of a generation drives an apply or a rollback from any
// state another build of it left, and a helper copy that an interrupted commit
// left one build behind must still read and write what the current build does. A
// member can't be renamed, removed, added, retyped or reordered in a build of
// generation 1: a change needs a new generation. testdata/update/*.json holds the
// bytes of generation 1, and a test fails when a field is renamed.
//
// The readers here are strict. A reader refuses a file that is not UTF-8 text, a
// member twice, a member that isn't listed (in any case: Go's decoder would match
// "Consent" to "consent"), a member that is missing, a value of another type, a
// number written as anything but an integer, and a value outside the contract's
// bounds. A writer never produces a file its readers refuse: it checks what it
// writes by reading it back.

const (
	updateRequestSchema   = "vectory.update-request.v1"
	updateHealthSchema    = "vectory.update-health.v1"
	updateStatusSchema    = "vectory.update-status.v1"
	updateRolloversSchema = "vectory.update-rollovers.v1"

	// MaxUpdateFile bounds request.json, health.json and status.json; a reader
	// refuses a longer file without reading the rest.
	MaxUpdateFile = 4 * 1024
	// MaxUpdateRollovers bounds rollovers.json.
	MaxUpdateRollovers = 16 * 1024

	// The bounds of a rollover chain are the release library's: what it refuses
	// to verify, this file never holds.
	maxUpdateRolloverStatement = MaxRolloverStatement
	maxUpdateEnvelopes         = MaxRolloverChain
	maxUpdateFingerprints      = 4
	maxUpdateVersionBytes      = 128
	maxUpdateServiceGeneration = 1000
	maxFirstCheckInMS          = 86_400_000
)

// The names of the files in <state>/updates and in a staged offer, in
// <state>/updates/incoming/<manifest sha256>/.
const (
	UpdateRequestFile    = "request.json"
	UpdateHealthFile     = "health.json"
	UpdateRolloversFile  = "rollovers.json"
	UpdateReleaseFile    = "release.json"
	UpdateSignaturesFile = "release.json.sig"
	UpdateBuildPartFile  = "vectory.part"

	updateExchangeDir = "updates"
	updateIncomingDir = "incoming"
)

// UpdateBuildFile is what a staged build is called: vectory, or vectory.exe on
// Windows. The agent writes it as UpdateBuildPartFile and renames it only when
// its size and SHA-256 are the signed ones.
func UpdateBuildFile(goos string) string {
	if goos == "windows" {
		return "vectory.exe"
	}
	return "vectory"
}

// UpdateExchange is where the agent writes for the step, inside its state
// directory.
type UpdateExchange struct {
	Dir      string // <state>/updates
	Request  string // request.json, written last, after the files of the offer
	Health   string // health.json, written after every successful check-in
	Incoming string // incoming/, one directory for each manifest
}

// UpdateExchangeFor returns the exchange paths for an agent's state directory.
func UpdateExchangeFor(stateDir string) UpdateExchange {
	dir := filepath.Join(stateDir, updateExchangeDir)
	return UpdateExchange{
		Dir:      dir,
		Request:  filepath.Join(dir, UpdateRequestFile),
		Health:   filepath.Join(dir, UpdateHealthFile),
		Incoming: filepath.Join(dir, updateIncomingDir),
	}
}

// IncomingDir is where the files of one offer are staged: incoming/<manifest
// sha256>. A name that isn't a digest is refused, so no path is ever built from
// anything but 64 lowercase hex characters.
func (e UpdateExchange) IncomingDir(manifestSHA256 string) (string, error) {
	if !isLowerHex64(manifestSHA256) {
		return "", fmt.Errorf("%q isn't a SHA-256 digest", manifestSHA256)
	}
	return filepath.Join(e.Incoming, manifestSHA256), nil
}

// The codes an agent and its step put in `code`, and what the files accept in
// the members that hold one.
var updateCodes = map[string]bool{
	"UPDATES_OFF": true, "UPDATES_PAUSED": true, "KEY_NOT_PINNED": true, "SIGNATURE_INVALID": true,
	"MANIFEST_INVALID": true, "MANIFEST_EXPIRED": true, "KEY_ROLLOVER_CONFLICT": true, "RELEASE_ALREADY_TRIED": true,
	"COUNTER_REPLAYED": true, "DOWNGRADE_REFUSED": true, "VERSION_NOT_ON_TRACK": true, "AGENT_TOO_OLD": true,
	"ALREADY_RUNNING": true, "PLATFORM_NOT_IN_RELEASE": true, "PACKAGE_MANAGED": true, "NO_SERVICE": true,
	"UNTRUSTED_LOCATION": true, "READ_ONLY": true, "HELPER_NOT_RUNNING": true, "SERVICE_DEFINITION_OUTDATED": true,
	"DOWNLOAD_FAILED": true, "ARTIFACT_MISMATCH": true, "DISK_FULL": true, "PROBE_FAILED": true,
	"START_FAILED": true, "NO_CHECK_IN": true, "UNHEALTHY": true, "INTERRUPTED": true,
	"BINARY_CHANGED": true, "ROLLBACK_UNHEALTHY": true,
}

// IsUpdateCode reports whether code is one of the agent codes of the contract.
func IsUpdateCode(code string) bool { return updateCodes[code] }

// The stages of the step in status.json, the outcomes of a result, the states of
// Vector in health.json and the eligibility of a host that can take an update.
const (
	UpdateStageIdle        = "idle"
	UpdateStagePreparing   = "preparing"
	UpdateStageSwapping    = "swapping"
	UpdateStageTrial       = "trial"
	UpdateStageRollingBack = "rolling_back"

	UpdateOutcomeCommitted  = "committed"
	UpdateOutcomeRolledBack = "rolled_back"
	UpdateOutcomeFailed     = "failed"
	UpdateOutcomeRefused    = "refused"

	UpdateVectorRunning = "running"
	UpdateVectorStopped = "stopped"
	UpdateVectorNone    = "none"

	UpdateEligible = "eligible"
)

var (
	updateStages    = []string{UpdateStageIdle, UpdateStagePreparing, UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack}
	updateOutcomes  = []string{UpdateOutcomeCommitted, UpdateOutcomeRolledBack, UpdateOutcomeFailed, UpdateOutcomeRefused}
	updateVectors   = []string{UpdateVectorRunning, UpdateVectorStopped, UpdateVectorNone}
	updateRolloutID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// updateEligibilities are the values of eligibility: eligible, or the code that
// says why the host can't take an update.
var updateEligibilities = []string{
	UpdateEligible, "PACKAGE_MANAGED", "NO_SERVICE", "UNTRUSTED_LOCATION", "READ_ONLY",
	"HELPER_NOT_RUNNING", "SERVICE_DEFINITION_OUTDATED", "PLATFORM_NOT_IN_RELEASE",
}

func oneOf(value string, allowed []string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- values

// validUpdateVersion reports whether text is a version, as the release library
// reads one: major.minor.patch.
func validUpdateVersion(text string) bool {
	_, err := ParseReleaseVersion(text)
	return err == nil
}

// validUpdateText accepts the text of a member that names or identifies
// something, such as a version a host reports: 1 to 128 bytes of UTF-8 with no
// control character, line or paragraph separator, text-direction control or byte
// order mark (the rule of every such member, refusedInName).
func validUpdateText(text string) bool {
	if text == "" || len(text) > maxUpdateVersionBytes || !utf8.ValidString(text) {
		return false
	}
	for _, r := range text {
		if refusedInName(r) {
			return false
		}
	}
	return true
}

const (
	updateSecondsLayout = "2006-01-02T15:04:05Z"
	updateMillisLayout  = "2006-01-02T15:04:05.000Z"
)

// parseUpdateInstant reads a UTC instant written as YYYY-MM-DDTHH:MM:SSZ, or with
// milliseconds as YYYY-MM-DDTHH:MM:SS.mmmZ: exactly these characters, years 1970
// to 9999.
func parseUpdateInstant(text string, millis bool) (time.Time, bool) {
	layout, length := updateSecondsLayout, 20
	if millis {
		layout, length = updateMillisLayout, 24
	}
	if len(text) != length {
		return time.Time{}, false
	}
	// The shape is checked by position first: time.Parse would also take a
	// fraction of a second or a zone where the layout has none.
	for i := 0; i < length; i++ {
		c := text[i]
		var ok bool
		switch {
		case i == 4 || i == 7:
			ok = c == '-'
		case i == 10:
			ok = c == 'T'
		case i == 13 || i == 16:
			ok = c == ':'
		case i == 19 && millis:
			ok = c == '.'
		case i == length-1:
			ok = c == 'Z'
		default:
			ok = c >= '0' && c <= '9'
		}
		if !ok {
			return time.Time{}, false
		}
	}
	instant, err := time.Parse(layout, text)
	if err != nil || instant.Year() < 1970 {
		return time.Time{}, false
	}
	return instant, true
}

func formatUpdateInstant(instant time.Time, millis bool) (string, error) {
	instant = instant.UTC()
	if instant.Year() < 1970 || instant.Year() > 9999 {
		return "", fmt.Errorf("%s is outside the years 1970 to 9999", instant.Format(time.RFC3339))
	}
	if millis {
		return instant.Format(updateMillisLayout), nil
	}
	return instant.Format(updateSecondsLayout), nil
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// checkNullableDigest accepts an absent value or a digest.
func checkNullableDigest(what string, value *string) error {
	if value != nil && !isLowerHex64(*value) {
		return fmt.Errorf("%s %q isn't a SHA-256 digest", what, *value)
	}
	return nil
}

// ---------------------------------------------------------------- request.json

// UpdateRequest is request.json: the agent's request that the step apply the
// build it staged, written last, after the files of the offer. It names the
// manifest and the artifact by digest. RolloutID and OfferedAt are for people
// and logs and never a decision: what authorizes an install is the signed
// manifest, the pins and the policy, which the step verifies itself, and consent
// is never read from here.
type UpdateRequest struct {
	ManifestSHA256 string
	ArtifactSHA256 string
	RolloutID      string
	OfferedAt      time.Time
}

type updateRequestWire struct {
	Schema         string `json:"schema"`
	ManifestSHA256 string `json:"manifest_sha256"`
	ArtifactSHA256 string `json:"artifact_sha256"`
	RolloutID      string `json:"rollout_id"`
	OfferedAt      string `json:"offered_at"`
}

// ParseUpdateRequest reads the bytes of a request.json.
func ParseUpdateRequest(data []byte) (UpdateRequest, error) {
	var wire updateRequestWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return UpdateRequest{}, fmt.Errorf("request.json %w", err)
	}
	invalid := func(format string, args ...any) (UpdateRequest, error) {
		return UpdateRequest{}, fmt.Errorf("request.json: "+format, args...)
	}
	switch {
	case wire.Schema != updateRequestSchema:
		return invalid("the schema is %q, and this agent reads %q", wire.Schema, updateRequestSchema)
	case !isLowerHex64(wire.ManifestSHA256):
		return invalid("manifest_sha256 %q isn't a SHA-256 digest", wire.ManifestSHA256)
	case !isLowerHex64(wire.ArtifactSHA256):
		return invalid("artifact_sha256 %q isn't a SHA-256 digest", wire.ArtifactSHA256)
	case !updateRolloutID.MatchString(wire.RolloutID):
		return invalid("rollout_id %q isn't a lowercase UUID", wire.RolloutID)
	}
	offered, ok := parseUpdateInstant(wire.OfferedAt, false)
	if !ok {
		return invalid("offered_at %q isn't a UTC time like 2026-10-04T01:58:10Z", wire.OfferedAt)
	}
	return UpdateRequest{ManifestSHA256: wire.ManifestSHA256, ArtifactSHA256: wire.ArtifactSHA256, RolloutID: wire.RolloutID, OfferedAt: offered}, nil
}

// MarshalUpdateRequest writes a request.json: one line, in the contract's order,
// refused when a reader would refuse it.
func MarshalUpdateRequest(r UpdateRequest) ([]byte, error) {
	offered, err := formatUpdateInstant(r.OfferedAt, false)
	if err != nil {
		return nil, fmt.Errorf("request.json: offered_at: %w", err)
	}
	data, err := marshalLine(updateRequestWire{updateRequestSchema, r.ManifestSHA256, r.ArtifactSHA256, r.RolloutID, offered})
	if err != nil {
		return nil, err
	}
	if _, err := ParseUpdateRequest(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- health.json

// UpdateHealth is health.json, which every agent writes after each successful
// check-in. The step reads it every two seconds during a trial: the new build is
// healthy when this names its SHA-256, a BootID written after the trial began and
// a check-in after it. Offer is the manifest SHA-256 that the verified manifest of
// that check-in offered, or empty (null) when it offered nothing; `vectory update
// apply` shows it, and the age of CheckedInAt, as advice before it applies. The
// file is written by the service account, so it is advice and never evidence of
// freshness.
type UpdateHealth struct {
	AgentSHA256  string
	AgentVersion string
	BootID       string
	CheckedInAt  time.Time // written with milliseconds
	Vector       string    // UpdateVectorRunning, UpdateVectorStopped or UpdateVectorNone
	Offer        string
}

type updateHealthWire struct {
	Schema       string  `json:"schema"`
	AgentSHA256  string  `json:"agent_sha256"`
	AgentVersion string  `json:"agent_version"`
	BootID       string  `json:"boot_id"`
	CheckedInAt  string  `json:"checked_in_at"`
	Vector       string  `json:"vector"`
	Offer        *string `json:"offer"`
}

// ParseUpdateHealth reads the bytes of a health.json.
func ParseUpdateHealth(data []byte) (UpdateHealth, error) {
	var wire updateHealthWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return UpdateHealth{}, fmt.Errorf("health.json %w", err)
	}
	invalid := func(format string, args ...any) (UpdateHealth, error) {
		return UpdateHealth{}, fmt.Errorf("health.json: "+format, args...)
	}
	switch {
	case wire.Schema != updateHealthSchema:
		return invalid("the schema is %q, and this agent reads %q", wire.Schema, updateHealthSchema)
	case !isLowerHex64(wire.AgentSHA256):
		return invalid("agent_sha256 %q isn't a SHA-256 digest", wire.AgentSHA256)
	case !validUpdateText(wire.AgentVersion):
		return invalid("agent_version isn't 1 to %d bytes of text without control characters", maxUpdateVersionBytes)
	case !isLowerHex64(wire.BootID):
		return invalid("boot_id %q isn't 64 lowercase hexadecimal characters", wire.BootID)
	case !oneOf(wire.Vector, updateVectors):
		return invalid("vector %q isn't running, stopped or none", wire.Vector)
	}
	if err := checkNullableDigest("health.json: offer", wire.Offer); err != nil {
		return UpdateHealth{}, err
	}
	checkedIn, ok := parseUpdateInstant(wire.CheckedInAt, true)
	if !ok {
		return invalid("checked_in_at %q isn't a UTC time with milliseconds like 2026-10-05T02:14:11.382Z", wire.CheckedInAt)
	}
	return UpdateHealth{
		AgentSHA256: wire.AgentSHA256, AgentVersion: wire.AgentVersion, BootID: wire.BootID,
		CheckedInAt: checkedIn, Vector: wire.Vector, Offer: stringOrEmpty(wire.Offer),
	}, nil
}

// MarshalUpdateHealth writes a health.json: one line, in the contract's order,
// refused when a reader would refuse it.
func MarshalUpdateHealth(h UpdateHealth) ([]byte, error) {
	checkedIn, err := formatUpdateInstant(h.CheckedInAt, true)
	if err != nil {
		return nil, fmt.Errorf("health.json: checked_in_at: %w", err)
	}
	data, err := marshalLine(updateHealthWire{updateHealthSchema, h.AgentSHA256, h.AgentVersion, h.BootID, checkedIn, h.Vector, nullableString(h.Offer)})
	if err != nil {
		return nil, err
	}
	if _, err := ParseUpdateHealth(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- rollovers.json

type updateRolloversWire struct {
	Schema    string             `json:"schema"`
	Rollovers []RolloverEnvelope `json:"rollovers"`
}

// ParseUpdateRollovers reads the bytes of a rollovers.json: the offer's rollover
// envelopes, at most 8, in the order a host follows them. It checks the shape of
// each (canonical base64, a statement of at most 1,024 bytes, a signature of 64
// bytes); VerifyRelease says whether they verify.
func ParseUpdateRollovers(data []byte) ([]RolloverEnvelope, error) {
	var wire updateRolloversWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return nil, fmt.Errorf("rollovers.json %w", err)
	}
	invalid := func(format string, args ...any) ([]RolloverEnvelope, error) {
		return nil, fmt.Errorf("rollovers.json: "+format, args...)
	}
	switch {
	case wire.Schema != updateRolloversSchema:
		return invalid("the schema is %q, and this agent reads %q", wire.Schema, updateRolloversSchema)
	case wire.Rollovers == nil:
		return invalid("rollovers isn't a list")
	case len(wire.Rollovers) > maxUpdateEnvelopes:
		return invalid("holds %d rollover statements, and a host follows at most %d", len(wire.Rollovers), maxUpdateEnvelopes)
	}
	for i, envelope := range wire.Rollovers {
		statement, ok := decodeCanonicalBase64(envelope.Statement)
		if !ok || len(statement) == 0 || len(statement) > maxUpdateRolloverStatement {
			return invalid("the statement of rollover %d isn't canonical base64 of 1 to %d bytes", i+1, maxUpdateRolloverStatement)
		}
		if signature, ok := decodeCanonicalBase64(envelope.Signature); !ok || len(signature) != 64 {
			return invalid("the signature of rollover %d isn't canonical base64 of 64 bytes", i+1)
		}
	}
	return wire.Rollovers, nil
}

// MarshalUpdateRollovers writes a rollovers.json: one line, refused when a reader
// would refuse it.
func MarshalUpdateRollovers(envelopes []RolloverEnvelope) ([]byte, error) {
	if envelopes == nil {
		envelopes = []RolloverEnvelope{}
	}
	data, err := marshalLine(updateRolloversWire{updateRolloversSchema, envelopes})
	if err != nil {
		return nil, err
	}
	if len(data) > MaxUpdateRollovers {
		return nil, fmt.Errorf("rollovers.json would be %d bytes, and at most %d are allowed", len(data), MaxUpdateRollovers)
	}
	if _, err := ParseUpdateRollovers(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- status.json

// RolloverConflict is a fork: two statements from one pinned key naming
// different successors, neither followed. It is evidence that someone else holds
// the key, and the host accepts no update until it is pinned again. To holds the
// two successors' fingerprints in ascending order.
type RolloverConflict struct {
	From string
	To   [2]string
}

type rolloverConflictWire struct {
	From string   `json:"from"`
	To   []string `json:"to"`
}

func (c *RolloverConflict) fromWire(wire rolloverConflictWire) error {
	switch {
	case !isLowerHex64(wire.From):
		return fmt.Errorf("rollover_conflict.from %q isn't a fingerprint", wire.From)
	case len(wire.To) != 2 || !isLowerHex64(wire.To[0]) || !isLowerHex64(wire.To[1]):
		return errors.New("rollover_conflict.to isn't two fingerprints")
	case wire.To[0] >= wire.To[1]:
		return errors.New("rollover_conflict.to isn't two different fingerprints in ascending order")
	case wire.From == wire.To[0] || wire.From == wire.To[1]:
		return errors.New("rollover_conflict names the key it replaces as its own successor")
	}
	*c = RolloverConflict{From: wire.From, To: [2]string{wire.To[0], wire.To[1]}}
	return nil
}

// UnmarshalJSON reads {"from":"<fingerprint>","to":["<a>","<b>"]}, strictly.
func (c *RolloverConflict) UnmarshalJSON(data []byte) error {
	var wire rolloverConflictWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return fmt.Errorf("rollover_conflict %w", err)
	}
	return c.fromWire(wire)
}

// MarshalJSON writes {"from":"<fingerprint>","to":["<a>","<b>"]}.
func (c RolloverConflict) MarshalJSON() ([]byte, error) {
	wire := rolloverConflictWire{From: c.From, To: []string{c.To[0], c.To[1]}}
	if err := new(RolloverConflict).fromWire(wire); err != nil {
		return nil, err
	}
	return marshalCompact(wire)
}

// UpdateLast is the privileged step's latest result for a request that ended,
// as status.json records it and the heartbeat's `last` reports it. Code is
// empty (null) exactly when Outcome is committed. FromVersion is the version the
// host ran before; ToVersion is the release's version, or empty (null).
// FirstCheckInMS, when present, is how long after the new build started its first
// check-in was answered.
type UpdateLast struct {
	Release        string
	Outcome        string
	Code           string
	At             time.Time
	FromVersion    string
	ToVersion      string
	FirstCheckInMS *uint32
}

type updateLastWire struct {
	Release        string  `json:"release"`
	Outcome        string  `json:"outcome"`
	Code           *string `json:"code"`
	At             string  `json:"at"`
	FromVersion    string  `json:"from_version"`
	ToVersion      *string `json:"to_version"`
	FirstCheckInMS *uint32 `json:"first_check_in_ms,omitempty"`
}

func (l *UpdateLast) fromWire(wire updateLastWire) error {
	switch {
	case !isLowerHex64(wire.Release):
		return fmt.Errorf("last.release %q isn't a SHA-256 digest", wire.Release)
	case !oneOf(wire.Outcome, updateOutcomes):
		return fmt.Errorf("last.outcome %q isn't committed, rolled_back, failed or refused", wire.Outcome)
	case wire.Outcome == UpdateOutcomeCommitted && wire.Code != nil:
		return errors.New("last.code is set on a result that committed")
	case wire.Outcome != UpdateOutcomeCommitted && wire.Code == nil:
		return fmt.Errorf("last.code is missing on a result that %s", strings.ReplaceAll(wire.Outcome, "_", " "))
	case wire.Code != nil && !IsUpdateCode(*wire.Code):
		return fmt.Errorf("last.code %q isn't an agent code", *wire.Code)
	case !validUpdateText(wire.FromVersion):
		return fmt.Errorf("last.from_version isn't 1 to %d bytes of text without control characters", maxUpdateVersionBytes)
	case wire.ToVersion != nil && !validUpdateVersion(*wire.ToVersion):
		return fmt.Errorf("last.to_version %q isn't major.minor.patch", *wire.ToVersion)
	case wire.FirstCheckInMS != nil && *wire.FirstCheckInMS > maxFirstCheckInMS:
		return fmt.Errorf("last.first_check_in_ms is %d, and at most %d are allowed", *wire.FirstCheckInMS, maxFirstCheckInMS)
	}
	at, ok := parseUpdateInstant(wire.At, false)
	if !ok {
		return fmt.Errorf("last.at %q isn't a UTC time like 2026-08-12T02:09:41Z", wire.At)
	}
	*l = UpdateLast{
		Release: wire.Release, Outcome: wire.Outcome, Code: stringOrEmpty(wire.Code), At: at,
		FromVersion: wire.FromVersion, ToVersion: stringOrEmpty(wire.ToVersion), FirstCheckInMS: wire.FirstCheckInMS,
	}
	return nil
}

func (l UpdateLast) toWire() (updateLastWire, error) {
	at, err := formatUpdateInstant(l.At, false)
	if err != nil {
		return updateLastWire{}, fmt.Errorf("last.at: %w", err)
	}
	wire := updateLastWire{
		Release: l.Release, Outcome: l.Outcome, Code: nullableString(l.Code), At: at,
		FromVersion: l.FromVersion, ToVersion: nullableString(l.ToVersion), FirstCheckInMS: l.FirstCheckInMS,
	}
	return wire, new(UpdateLast).fromWire(wire)
}

// UnmarshalJSON reads the result's object, strictly.
func (l *UpdateLast) UnmarshalJSON(data []byte) error {
	var wire updateLastWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return fmt.Errorf("last %w", err)
	}
	return l.fromWire(wire)
}

// MarshalJSON writes the result's object in the contract's order, refused when a
// reader would refuse it. The heartbeat's `last` is the same object.
func (l UpdateLast) MarshalJSON() ([]byte, error) {
	wire, err := l.toWire()
	if err != nil {
		return nil, err
	}
	return marshalCompact(wire)
}

// ReleaseResult is the last result as VerifyRelease takes it.
func (l UpdateLast) ReleaseResult() ReleaseResult {
	return ReleaseResult{Release: l.Release, Outcome: l.Outcome}
}

// marshalCompact is marshalLine without the final line feed, for a value that
// sits inside another.
func marshalCompact(v any) ([]byte, error) {
	data, err := marshalLine(v)
	if err != nil {
		return nil, err
	}
	return data[:len(data)-1], nil
}

// UpdateStatus is status.json, written by the privileged step at every run so
// that the agent can tell it is alive, and readable by everyone. HighestCounters
// is, for each pinned key's fingerprint, the highest release counter the step
// attempted from it ("attempted", never "committed": a release that was tried
// and rolled back stays at or below the floor). Release, FromVersion, ToVersion
// and Deadline describe the request in progress and are empty (null) while idle.
// RolloverConflict is the fork the step's own verification found, which makes it
// and the agent refuse every update until the host is pinned again.
type UpdateStatus struct {
	RunAt             time.Time
	Stage             string
	Eligibility       string
	ServiceDefinition int
	HighestCounters   map[string]uint64
	RolloverConflict  *RolloverConflict
	Release           string
	FromVersion       string
	ToVersion         string
	Deadline          time.Time
	Last              *UpdateLast
}

type updateStatusWire struct {
	Schema            string            `json:"schema"`
	RunAt             string            `json:"run_at"`
	Stage             string            `json:"stage"`
	Eligibility       string            `json:"eligibility"`
	ServiceDefinition int               `json:"service_definition"`
	HighestCounters   map[string]uint64 `json:"highest_counters"`
	RolloverConflict  *RolloverConflict `json:"rollover_conflict"`
	Release           *string           `json:"release"`
	FromVersion       *string           `json:"from_version"`
	ToVersion         *string           `json:"to_version"`
	Deadline          *string           `json:"deadline"`
	Last              *UpdateLast       `json:"last"`
}

// checkCounterFloors checks a map of fingerprint to attempted counter that status.json
// reports: at most the four keys a host pins.
func checkCounterFloors(what string, floors map[string]uint64) error {
	return checkCounterFloorsUpTo(what, floors, maxUpdateFingerprints)
}

// checkCounterFloorsUpTo checks a map of fingerprint to attempted counter of at most
// limit keys.
func checkCounterFloorsUpTo(what string, floors map[string]uint64, limit int) error {
	if floors == nil {
		return fmt.Errorf("%s isn't an object", what)
	}
	if len(floors) > limit {
		return fmt.Errorf("%s has %d keys, and at most %d are allowed", what, len(floors), limit)
	}
	for fingerprint, counter := range floors {
		if !isLowerHex64(fingerprint) {
			return fmt.Errorf("%s names %q, which isn't a fingerprint", what, fingerprint)
		}
		if counter > MaxJSONCounter {
			return fmt.Errorf("%s holds %d for %s, and the largest counter is %d", what, counter, fingerprint[:16], MaxJSONCounter)
		}
	}
	return nil
}

// ParseUpdateStatus reads the bytes of a status.json.
func ParseUpdateStatus(data []byte) (UpdateStatus, error) {
	var wire updateStatusWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return UpdateStatus{}, fmt.Errorf("status.json %w", err)
	}
	invalid := func(format string, args ...any) (UpdateStatus, error) {
		return UpdateStatus{}, fmt.Errorf("status.json: "+format, args...)
	}
	switch {
	case wire.Schema != updateStatusSchema:
		return invalid("the schema is %q, and this agent reads %q", wire.Schema, updateStatusSchema)
	case !oneOf(wire.Stage, updateStages):
		return invalid("stage %q isn't idle, preparing, swapping, trial or rolling_back", wire.Stage)
	case !oneOf(wire.Eligibility, updateEligibilities):
		return invalid("eligibility %q isn't eligible or one of the codes that say why a host can't update", wire.Eligibility)
	case wire.ServiceDefinition < 1 || wire.ServiceDefinition > maxUpdateServiceGeneration:
		return invalid("service_definition is %d, and it is 1 to %d", wire.ServiceDefinition, maxUpdateServiceGeneration)
	case wire.FromVersion != nil && !validUpdateText(*wire.FromVersion):
		return invalid("from_version isn't 1 to %d bytes of text without control characters", maxUpdateVersionBytes)
	case wire.ToVersion != nil && !validUpdateVersion(*wire.ToVersion):
		return invalid("to_version %q isn't major.minor.patch", *wire.ToVersion)
	}
	if err := checkCounterFloors("highest_counters", wire.HighestCounters); err != nil {
		return invalid("%v", err)
	}
	if err := checkNullableDigest("status.json: release", wire.Release); err != nil {
		return UpdateStatus{}, err
	}
	runAt, ok := parseUpdateInstant(wire.RunAt, false)
	if !ok {
		return invalid("run_at %q isn't a UTC time like 2026-10-05T02:14:12Z", wire.RunAt)
	}
	status := UpdateStatus{
		RunAt: runAt, Stage: wire.Stage, Eligibility: wire.Eligibility, ServiceDefinition: wire.ServiceDefinition,
		HighestCounters: wire.HighestCounters, RolloverConflict: wire.RolloverConflict, Last: wire.Last,
		Release: stringOrEmpty(wire.Release), FromVersion: stringOrEmpty(wire.FromVersion), ToVersion: stringOrEmpty(wire.ToVersion),
	}
	if wire.Deadline != nil {
		if status.Deadline, ok = parseUpdateInstant(*wire.Deadline, false); !ok {
			return invalid("deadline %q isn't a UTC time like 2026-10-05T02:19:09Z", *wire.Deadline)
		}
	}
	return status, nil
}

// MarshalUpdateStatus writes a status.json: one line, in the contract's order,
// refused when a reader would refuse it.
func MarshalUpdateStatus(s UpdateStatus) ([]byte, error) {
	runAt, err := formatUpdateInstant(s.RunAt, false)
	if err != nil {
		return nil, fmt.Errorf("status.json: run_at: %w", err)
	}
	wire := updateStatusWire{
		Schema: updateStatusSchema, RunAt: runAt, Stage: s.Stage, Eligibility: s.Eligibility, ServiceDefinition: s.ServiceDefinition,
		HighestCounters: s.HighestCounters, RolloverConflict: s.RolloverConflict,
		Release: nullableString(s.Release), FromVersion: nullableString(s.FromVersion), ToVersion: nullableString(s.ToVersion), Last: s.Last,
	}
	if wire.HighestCounters == nil {
		wire.HighestCounters = map[string]uint64{}
	}
	if !s.Deadline.IsZero() {
		deadline, err := formatUpdateInstant(s.Deadline, false)
		if err != nil {
			return nil, fmt.Errorf("status.json: deadline: %w", err)
		}
		wire.Deadline = &deadline
	}
	data, err := marshalLine(wire)
	if err != nil {
		return nil, fmt.Errorf("status.json: %w", err)
	}
	if len(data) > MaxUpdateFile {
		return nil, fmt.Errorf("status.json would be %d bytes, and at most %d are allowed", len(data), MaxUpdateFile)
	}
	if _, err := ParseUpdateStatus(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- files

// readUpdateFile reads a file the service account wrote, or any file with no
// link in its path: it refuses a link at any depth, doesn't wait for a writer
// and requires a regular file, and a file longer than limit is refused unread.
func readUpdateFile(path string, limit int64) ([]byte, error) {
	f, err := openPlainFile(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := readBounded(f, limit)
	if err != nil {
		return nil, fmt.Errorf("%s %w (%d bytes)", path, err, limit)
	}
	return data, nil
}

// ReadUpdateRequest reads a request.json by path. The file is the service
// account's, so a caller that acts on it (the step) copies it first and parses
// the copy with ParseUpdateRequest.
func ReadUpdateRequest(path string) (UpdateRequest, error) {
	data, err := readUpdateFile(path, MaxUpdateFile)
	if err != nil {
		return UpdateRequest{}, err
	}
	request, err := ParseUpdateRequest(data)
	if err != nil {
		return UpdateRequest{}, fmt.Errorf("%s: %w", path, err)
	}
	return request, nil
}

// ReadUpdateHealth reads a health.json by path.
func ReadUpdateHealth(path string) (UpdateHealth, error) {
	data, err := readUpdateFile(path, MaxUpdateFile)
	if err != nil {
		return UpdateHealth{}, err
	}
	health, err := ParseUpdateHealth(data)
	if err != nil {
		return UpdateHealth{}, fmt.Errorf("%s: %w", path, err)
	}
	return health, nil
}

// ReadUpdateRollovers reads a rollovers.json by path.
func ReadUpdateRollovers(path string) ([]RolloverEnvelope, error) {
	data, err := readUpdateFile(path, MaxUpdateRollovers)
	if err != nil {
		return nil, err
	}
	envelopes, err := ParseUpdateRollovers(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return envelopes, nil
}

// ReadUpdateStatus reads the step's status.json, through the path check: the file
// and every directory above it must be root's alone, or the read is refused with
// UNTRUSTED_LOCATION. A missing file is the not-exist error: the step has not run.
func ReadUpdateStatus() (UpdateStatus, error) {
	path := UpdateLocations().Status
	r, err := openRootOwned(path, rootOwnedFile)
	if err != nil {
		return UpdateStatus{}, err
	}
	defer r.Close()
	data, err := r.ReadFile(MaxUpdateFile)
	if err != nil {
		return UpdateStatus{}, err
	}
	status, err := ParseUpdateStatus(data)
	if err != nil {
		return UpdateStatus{}, fmt.Errorf("%s: %w", path, err)
	}
	return status, nil
}

// WriteUpdateRequest writes a request.json atomically, as the service account:
// private to it, and complete or absent.
func WriteUpdateRequest(path string, r UpdateRequest) error {
	data, err := MarshalUpdateRequest(r)
	if err != nil {
		return err
	}
	return AtomicWrite(path, data)
}

// WriteUpdateHealth writes a health.json atomically, as the service account.
func WriteUpdateHealth(path string, h UpdateHealth) error {
	data, err := MarshalUpdateHealth(h)
	if err != nil {
		return err
	}
	return AtomicWrite(path, data)
}

// WriteUpdateRollovers writes a rollovers.json atomically, as the service account.
func WriteUpdateRollovers(path string, envelopes []RolloverEnvelope) error {
	data, err := MarshalUpdateRollovers(envelopes)
	if err != nil {
		return err
	}
	return AtomicWrite(path, data)
}

// WriteUpdateStatus writes status.json into the step's directory, which dir
// holds open (openRootOwned): atomically, readable by everyone on Linux and macOS
// and by the agent's service on Windows.
func WriteUpdateStatus(dir *rootOwned, s UpdateStatus) error {
	data, err := MarshalUpdateStatus(s)
	if err != nil {
		return err
	}
	return dir.WriteFile(updateStatusFile, data, rootReadable)
}
