package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"time"
)

// The privileged step's own state, in its private directory (UpdateLocations):
// the journal, the counter floors and the record of the installed build. Only
// the step, which runs as root, reads and writes them. They are fixed within a
// service_definition generation like the files the agent and the step exchange
// (update_files.go): a member can't be renamed, removed, added, retyped or
// reordered by a build of generation 1, because any committed build of a
// generation must be able to continue an apply or a rollback that another build
// of it left. testdata/update/ holds the bytes of generation 1.
//
// Each file is one JSON object with exactly the members the contract lists, every
// one always written (null where nothing applies), read strictly
// (decodeStrictJSON) and at most 4 KiB. A writer never produces a file its reader
// refuses: it reads back what it marshalled.

const (
	updateJournalSchema   = "vectory.update-journal.v1"
	updateCountersSchema  = "vectory.update-counters.v1"
	updateInstalledSchema = "vectory.update-installed.v1"

	// maxUpdateStepFile bounds journal.json, counters.json and installed.json.
	maxUpdateStepFile = 4 * 1024

	// updateLockFile is the step's lock, in its private directory (the other
	// names there are in update_locations.go).
	updateLockFile = "lock"

	// The journal's two terminal stages. Its other stages are the stages of
	// status.json (UpdateStagePreparing, UpdateStageSwapping, UpdateStageTrial and
	// UpdateStageRollingBack). A journal that is missing, committed or rolled_back
	// is idle.
	updateJournalCommitted  = "committed"
	updateJournalRolledBack = "rolled_back"

	// How the new build takes the executable's place: one rename over it (Linux
	// and macOS), or two journaled renames where a mapped executable can't be
	// replaced (Windows).
	updateSwapRename     = "rename"
	updateSwapTwoRenames = "two_renames"
)

var updateJournalStages = []string{
	UpdateStagePreparing, UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack,
	updateJournalCommitted, updateJournalRolledBack,
}

// updateBuild names a build by its version and the SHA-256 of its file.
type updateBuild struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

// updateSwap is where the build under trial is staged and where the build it
// replaces is kept, as names without a directory beside the executable.
type updateSwap struct {
	Style    string `json:"style"`
	Staged   string `json:"staged"`
	Previous string `json:"previous"`
}

// updateJournal is journal.json: what the step is doing, written and synced
// before each step it names, so that any run can continue from any crash.
//
//	preparing   the request was accepted; the step copies, verifies, probes and
//	            stages the build. Nothing but a temporary file beside the
//	            executable has changed, and an interruption removes it.
//	swapping    written, with the counter floors already raised and synced, before
//	            the service stops. Recovery reads the installed digest.
//	trial       the new build runs and the step watches it.
//	rolling_back the trial failed, with Code: the previous build is put back.
//	committed, rolled_back   terminal.
type updateJournal struct {
	Stage   string
	Release string
	// Signers are the fingerprints of the pinned keys whose signature verified,
	// and Counter is the release's counter; both are empty before verification.
	Signers []string
	Counter uint64
	// From is the build that is installed and To the one being tried; nil before
	// verification.
	From *updateBuild
	To   *updateBuild
	// StartedAt is when the request was accepted. Deadline is the end of the trial
	// (or of the rollback's watch), zero before the trial.
	StartedAt time.Time
	Deadline  time.Time
	// BootIDBefore is the boot_id in health.json when the swap began, empty before.
	BootIDBefore string
	// Interruptions counts how many times a crash or power loss interrupted the
	// trial: 0 or 1, and a second rolls back.
	Interruptions int
	Swap          *updateSwap
	// Code is the agent code of a rollback, empty otherwise.
	Code       string
	FinishedAt time.Time
}

type updateJournalWire struct {
	Schema        string       `json:"schema"`
	Stage         string       `json:"stage"`
	Release       string       `json:"release"`
	Signers       []string     `json:"signers"`
	Counter       *uint64      `json:"counter"`
	From          *updateBuild `json:"from"`
	To            *updateBuild `json:"to"`
	StartedAt     string       `json:"started_at"`
	Deadline      *string      `json:"deadline"`
	BootIDBefore  *string      `json:"boot_id_before"`
	Interruptions int          `json:"interruptions"`
	Swap          *updateSwap  `json:"swap"`
	Code          *string      `json:"code"`
	FinishedAt    *string      `json:"finished_at"`
}

// validUpdateFileName accepts a name in a directory: 1 to 255 bytes with no
// separator and no NUL, and not . or ..
func validUpdateFileName(name string) bool {
	if name == "" || len(name) > 255 || name == "." || name == ".." {
		return false
	}
	for i := 0; i < len(name); i++ {
		if c := name[i]; c == '/' || c == '\\' || c == 0 {
			return false
		}
	}
	return true
}

// active reports whether the journal says a request is in progress.
func (j updateJournal) active() bool {
	switch j.Stage {
	case UpdateStagePreparing, UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack:
		return true
	}
	return false
}

// check says whether the journal is one the step can act on. The stages from
// swapping on need everything recovery reads: the two builds, the counter, the
// signers and the names beside the executable.
func (j updateJournal) check() error {
	switch {
	case !oneOf(j.Stage, updateJournalStages):
		return fmt.Errorf("stage %q isn't preparing, swapping, trial, rolling_back, committed or rolled_back", j.Stage)
	case !isLowerHex64(j.Release):
		return fmt.Errorf("release %q isn't a SHA-256 digest", j.Release)
	case len(j.Signers) > maxReleaseSigners:
		return fmt.Errorf("%d signers, and a release has at most %d", len(j.Signers), maxReleaseSigners)
	case j.Counter > MaxJSONCounter:
		return fmt.Errorf("counter %d is above the largest counter, %d", j.Counter, uint64(MaxJSONCounter))
	case j.StartedAt.IsZero():
		return errors.New("started_at is missing")
	case j.BootIDBefore != "" && !isLowerHex64(j.BootIDBefore):
		return fmt.Errorf("boot_id_before %q isn't 64 lowercase hexadecimal characters", j.BootIDBefore)
	case j.Interruptions < 0 || j.Interruptions > 1:
		return fmt.Errorf("interruptions is %d, and it is 0 or 1", j.Interruptions)
	case j.Code != "" && !IsUpdateCode(j.Code):
		return fmt.Errorf("code %q isn't an agent code", j.Code)
	}
	seen := map[string]bool{}
	for _, signer := range j.Signers {
		if !isLowerHex64(signer) || seen[signer] {
			return fmt.Errorf("signer %q isn't a fingerprint, or is listed twice", signer)
		}
		seen[signer] = true
	}
	if j.From != nil && (!validUpdateText(j.From.Version) || !isLowerHex64(j.From.SHA256)) {
		return errors.New("from isn't a version and a SHA-256 digest")
	}
	if j.To != nil && (!validUpdateVersion(j.To.Version) || !isLowerHex64(j.To.SHA256)) {
		return errors.New("to isn't a version and a SHA-256 digest")
	}
	if j.Swap != nil {
		if j.Swap.Style != updateSwapRename && j.Swap.Style != updateSwapTwoRenames {
			return fmt.Errorf("swap style %q isn't rename or two_renames", j.Swap.Style)
		}
		if !validUpdateFileName(j.Swap.Staged) || !validUpdateFileName(j.Swap.Previous) || j.Swap.Staged == j.Swap.Previous {
			return errors.New("swap names two different files beside the executable")
		}
	}
	switch j.Stage {
	case UpdateStageSwapping, UpdateStageTrial, UpdateStageRollingBack, updateJournalCommitted:
		if j.From == nil || j.To == nil || j.Counter == 0 || len(j.Signers) == 0 || j.Swap == nil {
			return fmt.Errorf("a journal in %s names both builds, the counter, the signers and the swap", j.Stage)
		}
	}
	switch j.Stage {
	case UpdateStageTrial, UpdateStageRollingBack:
		if j.Deadline.IsZero() {
			return fmt.Errorf("a journal in %s has a deadline", j.Stage)
		}
	case updateJournalCommitted, updateJournalRolledBack:
		if j.FinishedAt.IsZero() {
			return fmt.Errorf("a journal in %s says when it finished", j.Stage)
		}
	}
	if j.Stage == UpdateStageRollingBack && j.Code == "" || j.Stage == updateJournalRolledBack && j.Code == "" {
		return fmt.Errorf("a journal in %s says why", j.Stage)
	}
	if j.Stage == updateJournalCommitted && j.Code != "" {
		return errors.New("a journal that committed has no code")
	}
	return nil
}

// ParseUpdateJournal reads the bytes of a journal.json, strictly.
func parseUpdateJournal(data []byte) (updateJournal, error) {
	var wire updateJournalWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return updateJournal{}, fmt.Errorf("journal.json %w", err)
	}
	invalid := func(format string, args ...any) (updateJournal, error) {
		return updateJournal{}, fmt.Errorf("journal.json: "+format, args...)
	}
	if wire.Schema != updateJournalSchema {
		return invalid("the schema is %q, and this agent reads %q", wire.Schema, updateJournalSchema)
	}
	if wire.Signers == nil {
		return invalid("signers isn't a list")
	}
	startedAt, ok := parseUpdateInstant(wire.StartedAt, false)
	if !ok {
		return invalid("started_at %q isn't a UTC time like 2026-10-05T02:14:00Z", wire.StartedAt)
	}
	journal := updateJournal{
		Stage: wire.Stage, Release: wire.Release, Signers: wire.Signers, From: wire.From, To: wire.To,
		StartedAt: startedAt, Interruptions: wire.Interruptions, Swap: wire.Swap,
		BootIDBefore: stringOrEmpty(wire.BootIDBefore), Code: stringOrEmpty(wire.Code),
	}
	if wire.Counter != nil {
		if *wire.Counter == 0 {
			return invalid("counter is 0, and a counter is 1 or more")
		}
		journal.Counter = *wire.Counter
	}
	for _, field := range []struct {
		name string
		text *string
		into *time.Time
	}{{"deadline", wire.Deadline, &journal.Deadline}, {"finished_at", wire.FinishedAt, &journal.FinishedAt}} {
		if field.text == nil {
			continue
		}
		if *field.into, ok = parseUpdateInstant(*field.text, false); !ok {
			return invalid("%s %q isn't a UTC time like 2026-10-05T02:19:09Z", field.name, *field.text)
		}
	}
	if err := journal.check(); err != nil {
		return invalid("%v", err)
	}
	return journal, nil
}

// marshalUpdateJournal writes a journal.json: one line, in the contract's order,
// refused when a reader would refuse it.
func marshalUpdateJournal(j updateJournal) ([]byte, error) {
	if err := j.check(); err != nil {
		return nil, fmt.Errorf("journal.json: %w", err)
	}
	startedAt, err := formatUpdateInstant(j.StartedAt, false)
	if err != nil {
		return nil, fmt.Errorf("journal.json: started_at: %w", err)
	}
	wire := updateJournalWire{
		Schema: updateJournalSchema, Stage: j.Stage, Release: j.Release, Signers: j.Signers, From: j.From, To: j.To,
		StartedAt: startedAt, Interruptions: j.Interruptions, Swap: j.Swap,
		BootIDBefore: nullableString(j.BootIDBefore), Code: nullableString(j.Code),
	}
	if wire.Signers == nil {
		wire.Signers = []string{}
	}
	if j.Counter != 0 {
		counter := j.Counter
		wire.Counter = &counter
	}
	for _, field := range []struct {
		name string
		from time.Time
		into **string
	}{{"deadline", j.Deadline, &wire.Deadline}, {"finished_at", j.FinishedAt, &wire.FinishedAt}} {
		if field.from.IsZero() {
			continue
		}
		text, err := formatUpdateInstant(field.from, false)
		if err != nil {
			return nil, fmt.Errorf("journal.json: %s: %w", field.name, err)
		}
		*field.into = &text
	}
	data, err := marshalLine(wire)
	if err != nil {
		return nil, fmt.Errorf("journal.json: %w", err)
	}
	if len(data) > maxUpdateStepFile {
		return nil, fmt.Errorf("journal.json would be %d bytes, and at most %d are allowed", len(data), maxUpdateStepFile)
	}
	if _, err := parseUpdateJournal(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- counters.json

// updateCounters is counters.json: the counter floors the step keeps, one for
// each key, and the fork it found. A floor is the highest counter of a release
// signed by that key that the step attempted on this host. The step raises the
// floors of the keys that signed a release, and syncs the file, before it stops the
// service; a rollback never lowers a floor. A rollover moves the old key's floor to
// its successor when the pins change. RolloverConflict is the fork the step's own
// verification found: it refuses every update until the host is pinned again.
type updateCounters struct {
	HighestCounters  map[string]uint64
	RolloverConflict *RolloverConflict
}

type updateCountersWire struct {
	Schema           string            `json:"schema"`
	HighestCounters  map[string]uint64 `json:"highest_counters"`
	RolloverConflict *RolloverConflict `json:"rollover_conflict"`
}

func parseUpdateCounters(data []byte) (updateCounters, error) {
	var wire updateCountersWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return updateCounters{}, fmt.Errorf("counters.json %w", err)
	}
	if wire.Schema != updateCountersSchema {
		return updateCounters{}, fmt.Errorf("counters.json: the schema is %q, and this agent reads %q", wire.Schema, updateCountersSchema)
	}
	if err := checkCounterFloors("highest_counters", wire.HighestCounters); err != nil {
		return updateCounters{}, fmt.Errorf("counters.json: %v", err)
	}
	return updateCounters{HighestCounters: wire.HighestCounters, RolloverConflict: wire.RolloverConflict}, nil
}

func marshalUpdateCounters(c updateCounters) ([]byte, error) {
	wire := updateCountersWire{Schema: updateCountersSchema, HighestCounters: c.HighestCounters, RolloverConflict: c.RolloverConflict}
	if wire.HighestCounters == nil {
		wire.HighestCounters = map[string]uint64{}
	}
	data, err := marshalLine(wire)
	if err != nil {
		return nil, fmt.Errorf("counters.json: %w", err)
	}
	if len(data) > maxUpdateStepFile {
		return nil, fmt.Errorf("counters.json would be %d bytes, and at most %d are allowed", len(data), maxUpdateStepFile)
	}
	if _, err := parseUpdateCounters(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- installed.json

// updateInstalled is installed.json: the build that is installed. Version and
// SHA256 are what `version --json` said when it ran as the service account, or
// what the step wrote at commit. Release is the manifest SHA-256 the build came
// from, empty (null) for the build setup installed.
type updateInstalled struct {
	Version    string
	SHA256     string
	Release    string
	RecordedAt time.Time
}

type updateInstalledWire struct {
	Schema     string  `json:"schema"`
	Version    string  `json:"version"`
	SHA256     string  `json:"sha256"`
	Release    *string `json:"release"`
	RecordedAt string  `json:"recorded_at"`
}

func parseUpdateInstalled(data []byte) (updateInstalled, error) {
	var wire updateInstalledWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return updateInstalled{}, fmt.Errorf("installed.json %w", err)
	}
	invalid := func(format string, args ...any) (updateInstalled, error) {
		return updateInstalled{}, fmt.Errorf("installed.json: "+format, args...)
	}
	switch {
	case wire.Schema != updateInstalledSchema:
		return invalid("the schema is %q, and this agent reads %q", wire.Schema, updateInstalledSchema)
	case !validUpdateText(wire.Version):
		return invalid("version isn't 1 to %d bytes of text without control characters", maxUpdateVersionBytes)
	case !isLowerHex64(wire.SHA256):
		return invalid("sha256 %q isn't a SHA-256 digest", wire.SHA256)
	}
	if err := checkNullableDigest("installed.json: release", wire.Release); err != nil {
		return updateInstalled{}, err
	}
	recordedAt, ok := parseUpdateInstant(wire.RecordedAt, false)
	if !ok {
		return invalid("recorded_at %q isn't a UTC time like 2026-10-03T12:31:02Z", wire.RecordedAt)
	}
	return updateInstalled{Version: wire.Version, SHA256: wire.SHA256, Release: stringOrEmpty(wire.Release), RecordedAt: recordedAt}, nil
}

func marshalUpdateInstalled(i updateInstalled) ([]byte, error) {
	recordedAt, err := formatUpdateInstant(i.RecordedAt, false)
	if err != nil {
		return nil, fmt.Errorf("installed.json: recorded_at: %w", err)
	}
	data, err := marshalLine(updateInstalledWire{updateInstalledSchema, i.Version, i.SHA256, nullableString(i.Release), recordedAt})
	if err != nil {
		return nil, fmt.Errorf("installed.json: %w", err)
	}
	if len(data) > maxUpdateStepFile {
		return nil, fmt.Errorf("installed.json would be %d bytes, and at most %d are allowed", len(data), maxUpdateStepFile)
	}
	if _, err := parseUpdateInstalled(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ---------------------------------------------------------------- reading and writing

// readStepFile reads a file of the step's private directory through the held
// handle, at most limit bytes. A file that isn't there is reported as missing,
// never as an error: the step starts without any.
func readStepFile(dir *rootOwned, name string, limit int64) (data []byte, found bool, err error) {
	data, err = dir.ReadFileAt(name, limit)
	switch {
	case err == nil:
		return data, true, nil
	case errors.Is(err, fs.ErrNotExist):
		return nil, false, nil
	}
	return nil, false, err
}

// readUpdateJournal reads the journal. No file is an idle journal, reported as
// found false.
func readUpdateJournal(private *rootOwned) (updateJournal, bool, error) {
	data, found, err := readStepFile(private, updateJournalFile, maxUpdateStepFile)
	if err != nil || !found {
		return updateJournal{}, false, err
	}
	journal, err := parseUpdateJournal(data)
	return journal, err == nil, err
}

// writeUpdateJournal replaces the journal atomically and syncs it, so that a
// crash leaves the old journal or the new one.
func writeUpdateJournal(private *rootOwned, j updateJournal) error {
	data, err := marshalUpdateJournal(j)
	if err != nil {
		return err
	}
	return private.WriteFile(updateJournalFile, data, rootPrivate)
}

func readUpdateCounters(private *rootOwned) (updateCounters, error) {
	data, found, err := readStepFile(private, updateCountersFile, maxUpdateStepFile)
	if err != nil || !found {
		return updateCounters{HighestCounters: map[string]uint64{}}, err
	}
	return parseUpdateCounters(data)
}

func writeUpdateCounters(private *rootOwned, c updateCounters) error {
	data, err := marshalUpdateCounters(c)
	if err != nil {
		return err
	}
	return private.WriteFile(updateCountersFile, data, rootPrivate)
}

// readUpdateInstalled reads the record of the installed build; found is false when
// there is none.
func readUpdateInstalled(private *rootOwned) (updateInstalled, bool, error) {
	data, found, err := readStepFile(private, updateInstalledFile, maxUpdateStepFile)
	if err != nil || !found {
		return updateInstalled{}, false, err
	}
	installed, err := parseUpdateInstalled(data)
	return installed, err == nil, err
}

func writeUpdateInstalled(private *rootOwned, i updateInstalled) error {
	data, err := marshalUpdateInstalled(i)
	if err != nil {
		return err
	}
	return private.WriteFile(updateInstalledFile, data, rootPrivate)
}
