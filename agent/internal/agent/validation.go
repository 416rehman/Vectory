package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"time"
)

// Checking a version on this device ("Check on devices").
//
// Before a deployment, an operator can ask the target devices to check the
// candidate version on their own hosts: the pinned Vector validates it with
// this device's secrets, allowances and data directory, and runs its tests when
// asked. The request rides the signed manifest (`validation`), so it is bound
// to this device and this heartbeat like everything else in it; the answer
// rides the next heartbeats (`validation_result`) until the server's manifest
// stops carrying the request.
//
// A check never changes the device. It downloads the candidate to a private
// staging directory under the state directory, outside the managed directory,
// and deletes the copy when it is done. It never writes the managed file, the
// journal, the last known good, a generation or the desired state, and never
// starts, reloads or signals Vector. The result is advisory: nothing on the
// server or on the device acts on it.

// featureValidation is listed in the signed manifest's features by servers that
// accept agent_features, validation_result and readiness.
const featureValidation = "validation"

const (
	// maxValidationDiagnostics and maxValidationTests bound a result, as the
	// server's heartbeat parser does.
	maxValidationDiagnostics = 20
	maxValidationTests       = 100
	// maxTestName and maxTestMessage are in bytes.
	maxTestName    = 200
	maxTestMessage = 512
	// maxValidationArtifact is the largest size a request may name. An agent
	// accepts less (MaxArtifact) and says so.
	maxValidationArtifact = 16 << 20
	// maxValidationWindow is how far past the manifest's issue time a request may
	// stay open: a longer one is not one this agent acts on.
	maxValidationWindow = 15 * time.Minute

	validationStagingName  = "validation-staging"
	validationAnsweredName = "validation-answered.json"
	// maxAnsweredValidations bounds the memory of finished checks.
	maxAnsweredValidations = 16
)

// validationSpacing is the least time between two checks on one device. A
// request that arrives sooner waits for the next check-in, which carries it
// again while it is open. It limits the work a stream of requests can cause.
var validationSpacing = 10 * time.Second

// ValidationRequest is a signed request to check a candidate version on this
// device without applying it.
type ValidationRequest struct {
	// ID is the request's identity, shared by every device the same preview
	// asked; it is echoed back unchanged.
	ID           string    `json:"id"`
	SHA256       string    `json:"sha256"`
	Size         int64     `json:"size"`
	ArtifactPath string    `json:"artifact_path"`
	RunTests     bool      `json:"run_tests"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// ValidationResult is what a check found. It carries no subprocess output, no
// secret value and no path of a secret's file, and its texts have passed the
// redaction every diagnostic does: a path appears only where an apply's
// diagnostics show it too, such as the host's data directory.
type ValidationResult struct {
	ID string `json:"id"`
	// Valid is true only when Vector validated the candidate and, when the
	// request asked for it, every test passed.
	Valid       bool             `json:"valid"`
	Diagnostics []Diagnostic     `json:"diagnostics"`
	Tests       []ValidationTest `json:"tests"`
	DurationMS  int64            `json:"duration_ms"`
	// SecretsMissing names the device secrets the candidate references and this
	// device hasn't bound, sorted. Names only.
	SecretsMissing []string `json:"secrets_missing"`
}

// ValidationTest is one of the candidate's tests.
type ValidationTest struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	// NotRun is a test that never ran, because the check stopped before it.
	NotRun  bool   `json:"not_run,omitempty"`
	Message string `json:"message,omitempty"`
}

var (
	validationID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	lowerHex64   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// validationRequest reads the manifest's validation block, or returns nil when
// this agent won't act on one: the server doesn't list the feature, there is
// none, it isn't well formed, it names an artifact path other than the
// digest's own, or its window isn't a short one that is still open. A request
// whose time has passed, or that outlives the manifest by more than
// maxValidationWindow, is not one a signed manifest should carry.
func validationRequest(m Manifest, now time.Time) *ValidationRequest {
	if len(m.Validation) == 0 || !slices.Contains(m.Features, featureValidation) {
		return nil
	}
	var req ValidationRequest
	if json.Unmarshal(m.Validation, &req) != nil {
		return nil
	}
	if !validationID.MatchString(req.ID) || !lowerHex64.MatchString(req.SHA256) || req.Size < 1 || req.Size > maxValidationArtifact || req.ArtifactPath != "/agent/v1/artifacts/"+req.SHA256 {
		return nil
	}
	if !req.ExpiresAt.After(now) || req.ExpiresAt.After(m.IssuedAt.Add(maxValidationWindow)) {
		return nil
	}
	return &req
}

// validationState is what the engine keeps about checks on request. Only the
// ids in answered reach the disk.
type validationState struct {
	// pending is the result of the check this agent last ran. It goes in every
	// heartbeat until the manifest stops carrying that check's id.
	pending *ValidationResult
	// runs counts the checks this process has finished, so that the run loop can
	// send the result at once instead of at the next interval.
	runs int
	// finished is when the last check ended.
	finished time.Time
	// answered holds the ids of checks that are done with: delivered, refused
	// by the server or no longer wanted. A manifest that carries one again is
	// not checked again.
	answered []string
	loaded   bool
	// optionalRefused: the server answered a heartbeat with the optional members
	// as invalid, so they stay out for the rest of this process.
	optionalRefused bool
}

func (e *Engine) answeredPath() string { return filepath.Join(e.Dir, validationAnsweredName) }

// loadAnswered reads the memory of finished checks once. A file that can't be
// read is no memory: at worst a check is made again.
func (e *Engine) loadAnswered() {
	if e.validation.loaded {
		return
	}
	e.validation.loaded = true
	var stored struct {
		IDs []string `json:"ids"`
	}
	if e.Dir == "" || ReadJSON(e.answeredPath(), &stored) != nil {
		return
	}
	for _, id := range stored.IDs {
		if validationID.MatchString(id) && !slices.Contains(e.validation.answered, id) {
			e.validation.answered = append(e.validation.answered, id)
		}
	}
	if extra := len(e.validation.answered) - maxAnsweredValidations; extra > 0 {
		e.validation.answered = e.validation.answered[extra:]
	}
}

func (e *Engine) validationAnswered(id string) bool {
	e.loadAnswered()
	return slices.Contains(e.validation.answered, id)
}

// rememberValidation records that a check is done with, so that no manifest
// brings it back. It is the only thing a check keeps on disk, and losing it
// costs at most one repeated check.
func (e *Engine) rememberValidation(id string) {
	e.loadAnswered()
	if slices.Contains(e.validation.answered, id) {
		return
	}
	e.validation.answered = append(e.validation.answered, id)
	if extra := len(e.validation.answered) - maxAnsweredValidations; extra > 0 {
		e.validation.answered = e.validation.answered[extra:]
	}
	if e.Dir != "" {
		_ = WriteJSON(e.answeredPath(), struct {
			IDs []string `json:"ids"`
		}{e.validation.answered})
	}
}

// settleValidation drops the pending result the server no longer wants: its
// check isn't the one the verified manifest carries (it was taken, replaced or
// has expired; an expired request is not carried, see validationRequest). The
// check is then done with, and no heartbeat sends the result again.
func (e *Engine) settleValidation(carried *ValidationRequest) {
	if p := e.validation.pending; p != nil && (carried == nil || carried.ID != p.ID) {
		e.dropValidationResult()
	}
}

// dropValidationResult forgets the pending result and remembers its check.
func (e *Engine) dropValidationResult() {
	if p := e.validation.pending; p != nil {
		e.rememberValidation(p.ID)
		e.validation.pending = nil
	}
}

// applyInFlight reports an apply that has started and not finished: a recovery
// journal, or progress recorded between the start of an apply and its outcome.
func (e *Engine) applyInFlight() bool {
	switch e.State.ApplyState {
	case "desired", "downloaded", "validated", "written", "reload_requested":
		return true
	}
	_, err := os.Lstat(filepath.Join(e.Dir, "journal.json"))
	return err == nil
}

// checkCandidate is called with each verified manifest, after it was reconciled.
// It checks the candidate the manifest asks about, once, unless an apply is in
// flight (the next check-in carries the request again) or this agent already
// answered it. It never fails the check-in: whatever goes wrong is in the
// result, or there is no result.
func (e *Engine) checkCandidate(ctx context.Context, req *ValidationRequest) {
	if req == nil || ctx.Err() != nil || !e.now().Before(req.ExpiresAt) {
		return
	}
	if p := e.validation.pending; p != nil && p.ID == req.ID {
		return
	}
	if e.validationAnswered(req.ID) || e.applyInFlight() {
		return
	}
	if !e.validation.finished.IsZero() && e.now().Sub(e.validation.finished) < validationSpacing {
		return
	}
	result := e.runValidation(ctx, req)
	e.validation.finished = e.now()
	if result == nil {
		return
	}
	e.validation.pending = result
	e.validation.runs++
}

// stagingDir is the private directory a check works in: inside the state
// directory, never in the managed directory, mode 0700.
func (e *Engine) stagingDir() (string, error) {
	dir := filepath.Join(e.Dir, validationStagingName)
	return dir, PrivateDir(dir)
}

// clearValidationStaging deletes whatever a check left in its staging
// directory. It runs at startup under the agent lock, when no check can be in
// progress, so everything in there is a leftover of one that was killed.
func (e *Engine) clearValidationStaging() {
	dir := filepath.Join(e.Dir, validationStagingName)
	if SafePath(dir) != nil {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
