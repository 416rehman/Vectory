package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

type Engine struct {
	Dir         string
	Settings    Settings
	State       State
	Driver      Driver
	Client      *Client
	Metrics     *MetricsCollector
	Credentials Credentials
	BootID      string
	Now         func() time.Time
	Fault       func(string) error
	// Log receives Vector's JSON log; nil in tests without a native driver.
	Log *vectorLog
	// ServiceManager is what keeps this agent process running (systemd,
	// launchd, windows or none), reported to servers that accept it.
	ServiceManager string
	supervisor     *workloadSupervisor
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}
func (e *Engine) save() error { return SaveState(e.Dir, e.State) }
func (e *Engine) boundary(stage string) error {
	if e.Fault != nil {
		return e.Fault(stage)
	}
	return nil
}
func (e *Engine) paused() bool { return LocalPaused(e.Dir) || e.State.Policy.SyncPaused }
func (e *Engine) fail(code, stage, message string) error {
	return e.failWith(code, stage, message, nil)
}
func (e *Engine) failWith(code, stage, message string, diagnostics []Diagnostic) error {
	e.State.ApplyState = "failed"
	e.State.Error = &Issue{Code: code, Stage: stage, Message: message, Diagnostics: diagnostics}
	e.observeVerifiedAttempt("verification_unknown", e.State.Error)
	_ = e.save()
	return errors.New(message)
}
func (e *Engine) goodPath() string {
	return filepath.Join(e.Dir, "good-"+e.State.LastGoodSHA256+".json")
}
func (e *Engine) actual() string {
	h, err := FileDigest(e.Settings.ManagedConfig)
	if err != nil {
		return ""
	}
	return h
}

// Recover is called under the process lock before any heartbeat. A transaction
// without durable verified state restores the last verified artifact, never drift.
func (e *Engine) Recover(ctx context.Context) error {
	e.removeStaleLeftovers()
	var j Journal
	err := ReadJSON(filepath.Join(e.Dir, "journal.json"), &j)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return e.fail("RECOVERY_INVALID", "recovery", "Recovery journal is unreadable; local intervention required")
	}
	if e.State.LastGoodSHA256 == j.DesiredSHA256 && e.State.ReportedGeneration == j.Generation && e.State.AppliedSecretRevision == j.SecretRevision {
		// Verification was durable; activation is re-established by StartExisting.
		return os.Remove(filepath.Join(e.Dir, "journal.json"))
	}
	// A legacy journal has no candidate identity. Recover its workload without
	// guessing a failed attempt. A stale journal must not relabel a newer desire.
	var attempt *ConfigurationAttempt
	if j.ConfigurationAttempt != nil && j.ConfigurationAttempt.Generation == j.Generation {
		attempt = j.ConfigurationAttempt
	}
	return e.rollback(ctx, j.Generation, "An interrupted apply was recovered", attempt)
}

// removeStaleLeftovers deletes what an earlier run of this agent left behind
// when it was killed in the middle of a write or a validation: temporary
// files, staged candidates and the validation copy of Vector's runtime
// settings, once they are older than any of those could last. It runs at
// startup under the agent lock, and a failure to delete one is not an error.
func (e *Engine) removeStaleLeftovers() {
	dirs := []string{e.Dir}
	if e.Settings.ManagedConfig != "" {
		if managed := filepath.Dir(e.Settings.ManagedConfig); filepath.Clean(managed) != filepath.Clean(e.Dir) {
			dirs = append(dirs, managed)
		}
	}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			stale := agentLeftover(name) || dir == e.Dir && strings.HasPrefix(name, "host-runtime-stage-") && strings.HasSuffix(name, ".json")
			if !stale {
				continue
			}
			if info, err := entry.Info(); err == nil && info.Mode().IsRegular() && time.Since(info.ModTime()) > atomicTempStale {
				if path := filepath.Join(dir, name); SafePath(path) == nil {
					_ = os.Remove(path)
				}
			}
		}
	}
}

func (e *Engine) StartExisting(ctx context.Context) error {
	return e.startExisting(ctx, false)
}

func (e *Engine) startExisting(ctx context.Context, honorPause bool) error {
	if !e.Settings.Adopted {
		return nil
	}
	if e.Driver.Alive() {
		return nil
	}
	if honorPause && e.paused() {
		return errWorkloadPaused
	}
	// Restart the established workload after offline/manual drift. Pause preserves
	// manual content; absent pause, a last-good artifact needs no new authorization.
	if !e.paused() && e.State.LastGoodSHA256 != "" && e.actual() != e.State.LastGoodSHA256 {
		good, err := readArtifact(e.goodPath())
		if err != nil || Digest(good) != e.State.LastGoodSHA256 {
			return e.fail("RECOVERY_INVALID", "startup", "Last verified recovery artifact is missing or corrupted")
		}
		if err = e.Settings.CapabilityPolicy.Check(good); err != nil {
			return e.failWith("CAPABILITY_DENIED", "startup", "Recovery content violates current local capability policy", e.policyDiagnostics(err, good))
		}
		if honorPause && e.paused() {
			return errWorkloadPaused
		}
		if err = AtomicWrite(e.Settings.ManagedConfig, good); err != nil {
			return e.failWith("WRITE_FAILED", "startup", storageMessage("Cannot restore the established local workload", err), e.storageDiagnostic(err))
		}
	}
	data, err := readArtifact(e.Settings.ManagedConfig)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = e.Settings.CapabilityPolicy.Check(data); err != nil {
		return e.failWith("CAPABILITY_DENIED", "startup", "Existing managed configuration violates local capability policy", e.policyDiagnostics(err, data))
	}
	if err = e.Driver.Validate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.failWith("VALIDATION_FAILED", "startup", "Existing configuration failed Vector validation; inspect the protected local configuration", e.diagnoseFailure(err, data))
	}
	if honorPause && e.paused() {
		return errWorkloadPaused
	}
	if err = e.Driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.failWith("ACTIVATION_FAILED", "startup", "Existing Vector startup could not be verified", e.diagnoseFailure(err, data))
	}
	h := Digest(data)
	if e.actual() != h {
		return e.fail("DRIFT", "startup", "Managed file changed during Vector startup")
	}
	// A host-operator adopted file becomes good only after the owned process acknowledges it.
	if !e.State.Accepted || h == e.State.LastGoodSHA256 {
		if err = AtomicWrite(filepath.Join(e.Dir, "good-"+h+".json"), data); err != nil {
			return err
		}
		e.State.LastGoodSHA256 = h
	}
	if e.State.FailedGeneration == nil && e.State.Desired != nil && (h == e.State.Desired.SHA256 || (e.State.AppliedTemplateSHA256 == e.State.Desired.SHA256 && e.State.AppliedSecretRevision == e.State.SecretRevision)) && h == e.State.LastGoodSHA256 {
		e.State.ApplyState = "verified_applied"
		e.observeVerifiedAttempt("verified_applied", nil)
	} else if e.State.FailedGeneration == nil {
		e.State.ApplyState = "unmanaged"
	}
	if a := e.currentAttempt(); a != nil && (a.State == "failed" || a.State == "rolled_back") {
		// Restoring the established process is not success for a newer candidate.
		e.State.ApplyState, e.State.Error = a.State, cloneIssue(a.Error)
	} else if e.State.ApplyState == "verified_applied" || e.State.ApplyState == "unmanaged" {
		e.State.Error = nil
	}
	e.State.ActualSHA256 = h
	if e.paused() {
		e.pauseAttempt()
	}
	return e.save()
}

// Poll is one check-in: it reports, learns the desired version and reconciles.
// A disk that is full while it runs is recorded as a failure the operator can
// read, with its fix, and the same check-in is tried again at the next one.
func (e *Engine) Poll(ctx context.Context) error {
	return e.noteStorageFailure(e.poll(ctx))
}

// noteStorageFailure makes a full disk visible. A save that fails for lack of
// space comes back from the middle of an apply as a bare error; this turns it
// into the issue the next heartbeat reports and `vectory status` shows: the
// disk named by what it holds, and the fix. The version is not held back: the
// next check-in applies it.
func (e *Engine) noteStorageFailure(err error) error {
	full, ok := diskFullFrom(err)
	if !ok || e.State.ApplyState == "verified_applied" {
		// A completed apply stays what it is when only recording it failed:
		// Vector runs the verified version, and the next check-in saves that.
		return err
	}
	if e.State.Error == nil || diagnostic(e.State.Error, "DISK_FULL") == nil {
		message := "The disk that holds " + storageLabelFor(e.Settings, full.Dir) + " is full, so the agent can't save its progress"
		issue := &Issue{Code: "WRITE_FAILED", Stage: progressStage(e.State.ApplyState), Message: message, Diagnostics: e.storageDiagnostic(err)}
		e.State.ApplyState, e.State.Error = "failed", issue
		e.attemptOutcome(e.currentAttempt(), "failed", issue)
		// Best effort: with the disk still full this fails again, and the
		// in-memory record reaches the server with the next heartbeat.
		_ = e.save()
	}
	return err
}

// progressStage names the step an apply was in when it stopped, from its
// last recorded progress.
func progressStage(state string) string {
	switch state {
	case "desired":
		return "download"
	case "downloaded":
		return "staging"
	case "validated", "written", "reload_requested":
		return "commit"
	}
	return "storage"
}

func (e *Engine) poll(ctx context.Context) error {
	// Never silently round/clamp counters from an old or manually edited state.
	// Such a state needs local recovery; it cannot emit an invalid heartbeat.
	if e.State.ReportedGeneration > MaxJSONCounter || e.State.HighestGeneration > MaxJSONCounter || e.State.HighestPolicyGeneration > MaxJSONCounter || e.State.SecretRevision > MaxJSONCounter {
		return errors.New("local counters exceed protocol bounds; preserve state and obtain authorized recovery")
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return err
	}
	nonce := base64.StdEncoding.EncodeToString(raw[:])
	e.State.ActualSHA256 = e.actual()
	running, _ := readArtifact(e.Settings.ManagedConfig)
	telemetry, metricsSource, metricsAddress := e.collectTelemetry(ctx, running)
	e.State.Telemetry = telemetry
	if e.paused() {
		e.pauseAttempt()
	}
	if err := e.observeProcessExit(); err != nil {
		return err
	}
	heartbeat := Heartbeat{ProtocolVersion: 1, RequestID: RandomID(), Nonce: nonce, BootID: e.BootID, AgentVersion: Version, VectorVersion: e.Settings.adoptedVectorVersion(), ConfigurationMode: e.Settings.CapabilityPolicy.ConfigurationMode(), ReportedGeneration: e.State.ReportedGeneration, PolicyGeneration: e.State.HighestPolicyGeneration, ActualSHA256: e.State.ActualSHA256, ApplyState: e.State.ApplyState, LocalPaused: LocalPaused(e.Dir), RemotePauseAcknowledged: e.State.RemotePauseAcknowledged, Error: cloneIssue(e.State.Error), Telemetry: e.State.Telemetry, AppliedTemplateSHA256: e.State.AppliedTemplateSHA256, SecretRevision: e.State.SecretRevision, ConfigurationAttempt: cloneAttempt(e.currentAttempt())}
	e.addHeartbeatFeatures(&heartbeat, running, metricsSource, metricsAddress)
	b, err := e.Client.request(ctx, "POST", "/agent/v1/heartbeat", heartbeat)
	if err != nil {
		return err
	}
	var env Envelope
	if json.Unmarshal(b, &env) != nil {
		return errors.New("invalid heartbeat envelope")
	}
	m, err := VerifyEnvelope(env, e.Credentials.SigningPublicKey, e.Credentials.DeviceID, nonce, e.now(), e.State)
	if err != nil {
		// A rejected signature never supplies trust. One bounded, independently
		// authenticated credential renewal can learn an intentional signing rotation;
		// this response remains rejected and the next poll uses a fresh nonce.
		if errors.Is(err, ErrManifestSignature) && (e.State.LastSigningRefresh == nil || e.now().Sub(*e.State.LastSigningRefresh) >= time.Hour) {
			now := e.now()
			e.State.LastSigningRefresh = &now
			if saveErr := e.save(); saveErr == nil {
				_ = e.renewForced(ctx)
			}
		}
		return err
	}
	// Anti-rollback generations and identities reach durable storage before any artifact action.
	e.State.Accepted = true
	e.State.HighestGeneration = m.Generation
	e.State.HighestPolicyGeneration = m.PolicyGeneration
	e.State.DesiredIdentity = Identity(m.Desired)
	e.State.PolicyIdentity = Identity(m.Policy)
	e.State.Desired = m.Desired
	e.State.Policy = m.Policy
	e.State.ServerFeatures = m.Features
	e.selectAttempt(m)
	now := e.now()
	e.State.LastHeartbeat = &now
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("accepted"); err != nil {
		return err
	}
	return e.Reconcile(ctx, m)
}

// incompatibleVectorMessage names both versions. The manifest is signed, and
// its version is still shown only as a bounded printable token.
func incompatibleVectorMessage(wanted, adopted string) string {
	if release, _, ok := vectorRelease(wanted); ok {
		wanted = release
	} else if wanted = safeText(strings.TrimSpace(wanted), 24); wanted == "" {
		wanted = "an unknown version"
	}
	return "This version is built for Vector " + wanted + ", but this device runs Vector " + adopted + ". Only patch releases of the same minor version are interchangeable."
}

func (e *Engine) Reconcile(ctx context.Context, m Manifest) error {
	if e.State.HighestGeneration != m.Generation || Identity(e.State.Desired) != Identity(m.Desired) {
		return errors.New("manifest superseded before reconciliation")
	}
	e.selectAttempt(m)
	// Identity is durable before compatibility, download, secret resolution or
	// other candidate checks. This is independent from verified-generation state.
	if err := e.save(); err != nil {
		return err
	}
	if e.paused() {
		e.pauseAttempt()
		return e.save()
	}
	e.State.RemotePauseAcknowledged = false
	if m.Desired == nil {
		e.State.ApplyState = "unmanaged"
		e.State.Error = nil
		return e.save()
	}
	d := m.Desired
	// A manifest built for another patch release of this device's Vector is
	// fine: patch releases fix bugs without changing configuration.
	if adopted := e.Settings.adoptedVectorVersion(); !sameVectorSeries(d.VectorVersion, adopted) {
		return e.failAttempt("INCOMPATIBLE", "compatibility", incompatibleVectorMessage(d.VectorVersion, adopted))
	}
	if !e.Settings.Adopted {
		return e.failAttempt("ADOPTION_REQUIRED", "preflight", "Host operator must explicitly adopt the fixed Vector binary and sole managed config")
	}
	template, err := e.loadTemplate(ctx, d)
	if err != nil {
		var failure *downloadFailure
		if !errors.As(err, &failure) {
			failure = &downloadFailure{code: "DOWNLOAD_FAILED", message: "Cannot obtain a digest-verified authorized template"}
		}
		return e.failAttemptWith(failure.code, "download", failure.message, failure.diagnostics)
	}
	data, usesSecrets, err := resolveLocalSecrets(template, e.Settings.SecretFiles, e.Settings.CapabilityPolicy.FullVectorConfig)
	if err != nil {
		return e.failAttemptWith("SECRET_RESOLUTION_FAILED", "materialization", "Cannot resolve configuration references; check the approved local bindings and private secret files", e.secretDiagnostics(err, template))
	}
	effectiveSHA := Digest(data)
	if e.State.FailedGeneration != nil && *e.State.FailedGeneration == m.Generation && (e.State.FailedEffectiveSHA256 == effectiveSHA || (e.State.FailedEffectiveSHA256 == "" && !usesSecrets)) {
		if a := e.currentAttempt(); a != nil && (a.State == "failed" || a.State == "rolled_back") {
			e.State.ApplyState, e.State.Error = a.State, cloneIssue(a.Error)
			return e.save()
		}
		return nil
	}
	if e.State.MaterializationSHA256 != effectiveSHA || (usesSecrets && e.State.SecretRevision == 0) {
		if usesSecrets {
			if e.State.SecretRevision >= MaxJSONCounter {
				return e.failAttempt("SECRET_REVISION_EXHAUSTED", "materialization", "Local secret revision counter exhausted")
			}
			e.State.SecretRevision++
		}
		e.State.MaterializationSHA256 = effectiveSHA
		e.attemptProgress("desired")
		// Persist the attempt counter BEFORE staging, validation or activation. It
		// never rolls back when an earlier effective configuration is restored.
		if err = e.save(); err != nil {
			return err
		}
	}
	attemptRevision := uint64(0)
	if usesSecrets {
		attemptRevision = e.State.SecretRevision
	}
	actual := e.actual()
	e.State.ActualSHA256 = actual
	if actual == effectiveSHA && e.State.LastGoodSHA256 == effectiveSHA {
		if e.Driver.Alive() {
			e.markApplied(m.Generation, d.SHA256, effectiveSHA, attemptRevision, usesSecrets)
			if err = e.save(); err != nil {
				return err
			}
			return e.completeTransaction(effectiveSHA)
		}
		if e.supervisor != nil {
			// Continuous Run restores this exact established content on its local
			// schedule. Heartbeats must not bypass flapping-process backoff.
			return e.observeProcessExit()
		}
	}
	e.attemptProgress("downloaded")
	if err = e.save(); err != nil {
		return err
	}
	if err = e.Settings.CapabilityPolicy.Check(data); err != nil {
		g := m.Generation
		e.State.FailedGeneration = &g
		e.State.FailedEffectiveSHA256 = effectiveSHA
		return e.failAttemptWith("CAPABILITY_DENIED", "validation", e.Settings.CapabilityPolicy.refusedMessage(), e.policyDiagnostics(err, data))
	}
	stage := filepath.Join(filepath.Dir(e.Settings.ManagedConfig), ".vectory-stage-"+RandomID()+".json")
	if err = AtomicWrite(stage, data); err != nil {
		return e.failAttemptWith("WRITE_FAILED", "staging", storageMessage("Cannot securely stage configuration", err), e.storageDiagnostic(err))
	}
	defer os.Remove(stage)
	if err = e.Driver.Validate(ctx, stage); err != nil {
		if _, full := diskFullFrom(err); full {
			// Validation needs room for its own temporary files. That is the
			// disk's problem, not the version's: nothing holds it back.
			return e.failAttemptWith("WRITE_FAILED", "validation", storageMessage("Cannot prepare Vector's validation", err), e.storageDiagnostic(err))
		}
		// A version that validation could not verify in time is held back like
		// a rejected one: it is never treated as valid. Vector did not reject it.
		g := m.Generation
		e.State.FailedGeneration = &g
		e.State.FailedEffectiveSHA256 = effectiveSHA
		message := "Vector rejected this version on the device"
		if failure := asVectorFailure(err); failure != nil && failure.Phase == "timeout" {
			message = "Vector did not finish validating this version in time, so it was not applied"
		}
		return e.failAttemptWith("VALIDATION_FAILED", "validation", message, e.diagnoseFailure(err, data))
	}
	e.attemptProgress("validated")
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("validated"); err != nil {
		return err
	}
	if e.paused() {
		e.pauseAttempt()
		return e.save()
	}
	if e.State.HighestGeneration != m.Generation || Identity(e.State.Desired) != Identity(m.Desired) {
		return errors.New("manifest superseded before commit")
	}
	if e.now().After(m.ExpiresAt) {
		return e.failAttempt("MANIFEST_EXPIRED", "commit", "Manifest expired before commit; waiting for fresh authorization")
	}
	previous, readErr := readArtifact(e.Settings.ManagedConfig)
	if readErr != nil && !os.IsNotExist(readErr) {
		return e.failAttempt("PATH_UNSAFE", "commit", "Managed path cannot be read safely")
	}
	if readErr == nil {
		if err = AtomicWrite(filepath.Join(e.Dir, "pre-attempt.json"), previous); err != nil {
			return e.failAttemptWith("WRITE_FAILED", "commit", storageMessage("Cannot securely preserve pre-apply content", err), e.storageDiagnostic(err))
		}
	}
	j := Journal{Stage: "prepared", Generation: m.Generation, DesiredSHA256: effectiveSHA, PreviousSHA256: Digest(previous), PreviousAbsent: os.IsNotExist(readErr), SecretRevision: attemptRevision, ConfigurationAttempt: cloneAttempt(e.currentAttempt())}
	if err = WriteJSON(filepath.Join(e.Dir, "journal.json"), j); err != nil {
		return e.failAttemptWith("WRITE_FAILED", "commit", storageMessage("Cannot persist the apply recovery journal", err), e.storageDiagnostic(err))
	}
	if err = e.boundary("prepared"); err != nil {
		return err
	}
	// Pause can race validation or journal IO; this last local check precedes commit.
	if e.paused() {
		_ = os.Remove(filepath.Join(e.Dir, "journal.json"))
		e.pauseAttempt()
		return e.save()
	}
	if err = AtomicWrite(e.Settings.ManagedConfig, data); err != nil {
		return e.replacementFailed(ctx, m.Generation, err, j)
	}
	j.Stage = "written"
	if err = WriteJSON(filepath.Join(e.Dir, "journal.json"), j); err != nil {
		return e.rollbackAfterWriteFailure(ctx, m.Generation, "Cannot persist managed replacement recovery state", j.ConfigurationAttempt, err)
	}
	e.attemptProgress("written")
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("written"); err != nil {
		return err
	}
	e.attemptProgress("reload_requested")
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("reload_requested"); err != nil {
		return err
	}
	if err = e.Driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		if _, full := diskFullFrom(err); full {
			// Vector's runtime settings couldn't be written: nothing was
			// reloaded, and the version is not at fault.
			return e.rollbackAfterWriteFailure(ctx, m.Generation, "Cannot write Vector's runtime settings", j.ConfigurationAttempt, err)
		}
		return e.rollbackWith(ctx, m.Generation, "Vector didn't confirm it runs this version", j.ConfigurationAttempt, e.diagnoseFailure(err, data))
	}
	if e.actual() != effectiveSHA {
		return e.rollback(ctx, m.Generation, "Managed content changed during activation", j.ConfigurationAttempt)
	}
	if err = e.boundary("activated"); err != nil {
		return err
	}
	if err = AtomicWrite(filepath.Join(e.Dir, "good-"+effectiveSHA+".json"), data); err != nil {
		return e.rollbackAfterWriteFailure(ctx, m.Generation, "Cannot persist verified recovery content", j.ConfigurationAttempt, err)
	}
	e.markApplied(m.Generation, d.SHA256, effectiveSHA, attemptRevision, usesSecrets)
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("verified"); err != nil {
		return err
	}
	if err = os.Remove(filepath.Join(e.Dir, "journal.json")); err != nil {
		return err
	}
	if err = syncDir(e.Dir); err != nil {
		return err
	}
	return e.cleanupGood()
}

// completeTransaction finishes an apply whose verification is already durable
// when a leftover says otherwise: a journal that describes the verified
// content is removed, and so are the superseded recovery copies. That is what
// remains to do when the state was saved but the process could not finish (the
// disk filled up between the two). A journal of any other candidate stays.
func (e *Engine) completeTransaction(effectiveSHA string) error {
	path := filepath.Join(e.Dir, "journal.json")
	if _, err := os.Lstat(path); err != nil {
		return nil
	}
	var j Journal
	if ReadJSON(path, &j) != nil || j.DesiredSHA256 != effectiveSHA {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := syncDir(e.Dir); err != nil {
		return err
	}
	return e.cleanupGood()
}

func (e *Engine) markApplied(generation uint64, templateSHA, effectiveSHA string, revision uint64, usesSecrets bool) {
	e.State.LastGoodSHA256 = effectiveSHA
	e.State.ActualSHA256 = effectiveSHA
	e.State.ReportedGeneration = generation
	e.State.AppliedTemplateSHA256 = ""
	if usesSecrets {
		e.State.AppliedTemplateSHA256 = templateSHA
	}
	e.State.AppliedSecretRevision = revision
	e.attemptProgress("verified_applied")
	e.State.FailedGeneration = nil
	e.State.FailedEffectiveSHA256 = ""
	e.State.Error = nil
}
func (e *Engine) loadTemplate(ctx context.Context, d *Desired) ([]byte, error) {
	path := filepath.Join(e.Dir, "template-"+d.SHA256+".json")
	if data, err := readArtifact(path); err == nil && int64(len(data)) == d.Size && Digest(data) == d.SHA256 {
		return data, nil
	}
	data, err := e.Client.request(ctx, "GET", d.ArtifactPath, nil)
	if err != nil {
		return nil, classifyDownload(err)
	}
	// The bytes stay in memory until they are exactly what the signed manifest
	// names, so a cut-off or altered download never leaves a file behind.
	if int64(len(data)) != d.Size || Digest(data) != d.SHA256 {
		return nil, mismatchFailure(len(data), d.Size, int64(len(data)) == d.Size)
	}
	if err = AtomicWrite(path, data); err != nil {
		return nil, &downloadFailure{code: "WRITE_FAILED", message: storageMessage("Cannot save the downloaded configuration", err), diagnostics: e.storageDiagnostic(err)}
	}
	files, err := filepath.Glob(filepath.Join(e.Dir, "template-*.json"))
	if err != nil {
		return nil, err
	}
	for _, old := range files {
		if old != path {
			if err = os.Remove(old); err != nil {
				return nil, err
			}
		}
	}
	return data, nil
}
func (e *Engine) rollback(ctx context.Context, g uint64, reason string, attempt *ConfigurationAttempt) error {
	return e.rollbackWith(ctx, g, reason, attempt, nil)
}

// rollbackWith restores the last verified configuration. Diagnostics explain
// why the candidate failed; restore failures add their own. The version is
// held back until someone asks for another attempt.
func (e *Engine) rollbackWith(ctx context.Context, g uint64, reason string, attempt *ConfigurationAttempt, diagnostics []Diagnostic) error {
	return e.restoreLastGood(ctx, g, reason, attempt, diagnostics, true)
}

// rollbackAfterWriteFailure restores the last verified configuration after a
// write to disk failed. The version is not at fault (the disk was full, a
// file was locked), so it is not held back: the next check-in tries it again.
func (e *Engine) rollbackAfterWriteFailure(ctx context.Context, g uint64, reason string, attempt *ConfigurationAttempt, cause error) error {
	return e.restoreLastGood(ctx, g, storageMessage(reason, cause), attempt, e.storageDiagnostic(cause), false)
}

// replacementFailed handles a managed file that could not be replaced. The
// replacement is atomic, so a failure normally leaves the previous content in
// place: there is nothing to undo, Vector was never touched, and the version
// is not held back. If the new content is there after all (the failure came
// after the swap), the last good one is restored.
func (e *Engine) replacementFailed(ctx context.Context, generation uint64, cause error, j Journal) error {
	if e.managedUnchanged(j) {
		// No transaction is in flight, so no journal should be left to make a
		// restart roll back and hold the version.
		if removeErr := os.Remove(filepath.Join(e.Dir, "journal.json")); removeErr == nil || os.IsNotExist(removeErr) {
			_ = syncDir(e.Dir)
		}
		return e.failAttemptWith("WRITE_FAILED", "commit", storageMessage("Cannot write the managed configuration", cause), e.storageDiagnostic(cause))
	}
	return e.rollbackAfterWriteFailure(ctx, generation, "Managed configuration replacement failed", j.ConfigurationAttempt, cause)
}

// managedUnchanged reports whether the managed file still holds what it held
// when the journal was written.
func (e *Engine) managedUnchanged(j Journal) bool {
	data, err := readArtifact(e.Settings.ManagedConfig)
	if os.IsNotExist(err) {
		return j.PreviousAbsent
	}
	return err == nil && !j.PreviousAbsent && Digest(data) == j.PreviousSHA256
}

// restoreLastGood puts the last verified configuration back, activates and
// verifies it. suppress holds the failed version back from automatic retries.
func (e *Engine) restoreLastGood(ctx context.Context, g uint64, reason string, attempt *ConfigurationAttempt, diagnostics []Diagnostic, suppress bool) error {
	fail := func(code, message string, restore ...Diagnostic) error {
		all := append(append([]Diagnostic(nil), diagnostics...), restore...)
		if len(all) > maxDiagnostics {
			all = all[:maxDiagnostics]
		}
		e.attemptOutcome(attempt, "failed", &Issue{Code: code, Stage: "rollback", Message: message, Diagnostics: all})
		return e.failWith(code, "rollback", message, all)
	}
	if suppress {
		e.State.FailedGeneration = &g
		e.State.FailedEffectiveSHA256 = e.State.MaterializationSHA256
	}
	if e.State.LastGoodSHA256 == "" {
		// Nothing verified ever ran here: this was the device's first
		// version, so there is nothing earlier to go back to. Stop Vector and
		// withdraw the failed version from the managed path, so no report
		// claims it runs.
		_ = e.Driver.Stop()
		e.withdrawFirstVersion()
		err := fail("ROLLBACK_UNAVAILABLE", reason+"; Vector is stopped and there is no earlier version to go back to")
		// The outcome is durable and nothing is left to recover.
		if e.save() == nil {
			if removeErr := os.Remove(filepath.Join(e.Dir, "journal.json")); removeErr == nil || os.IsNotExist(removeErr) {
				_ = syncDir(e.Dir)
			}
		}
		return err
	}
	b, err := readArtifact(e.goodPath())
	if err != nil || Digest(b) != e.State.LastGoodSHA256 {
		return fail("ROLLBACK_FAILED", "Verified recovery artifact missing or corrupted")
	}
	if err = e.Settings.CapabilityPolicy.Check(b); err != nil {
		return fail("ROLLBACK_FAILED", "Recovery content violates current local capability policy")
	}
	if err = AtomicWrite(e.Settings.ManagedConfig, b); err != nil {
		return fail("ROLLBACK_FAILED", storageMessage("Cannot restore verified recovery content", err), e.storageDiagnostic(err)...)
	}
	if err = e.Driver.Validate(ctx, e.Settings.ManagedConfig); err != nil {
		if _, full := diskFullFrom(err); full {
			return fail("ROLLBACK_FAILED", storageMessage("Cannot check the restored configuration", err), e.storageDiagnostic(err)...)
		}
		return fail("ROLLBACK_FAILED", "Restored configuration validation failed", e.diagnoseFailure(err, b)...)
	}
	if err = e.Driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		if _, full := diskFullFrom(err); full {
			return fail("ROLLBACK_FAILED", storageMessage("Cannot load the restored configuration", err), e.storageDiagnostic(err)...)
		}
		return fail("ROLLBACK_FAILED", "Vector didn't confirm it runs the restored configuration", e.diagnoseFailure(err, b)...)
	}
	e.State.ActualSHA256 = e.State.LastGoodSHA256
	e.State.ApplyState = "rolled_back"
	e.State.Error = &Issue{Code: "APPLY_ROLLED_BACK", Stage: "rollback", Message: reason + "; last verified configuration restored", Diagnostics: diagnostics}
	e.attemptOutcome(attempt, "rolled_back", e.State.Error)
	if err = e.save(); err != nil {
		return err
	}
	if err = os.Remove(filepath.Join(e.Dir, "journal.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDir(e.Dir)
}

// withdrawFirstVersion puts the managed path back as it was before a failed
// attempt on a device that never verified a configuration: no file, or the
// file the attempt replaced. Only the attempt's own content is withdrawn,
// as the journal identifies it; anything else is left alone. The actual
// digest then describes what is there, so nothing claims the failed version.
func (e *Engine) withdrawFirstVersion() {
	defer func() { e.State.ActualSHA256 = e.actual() }()
	var j Journal
	if ReadJSON(filepath.Join(e.Dir, "journal.json"), &j) != nil || j.DesiredSHA256 == "" || e.actual() != j.DesiredSHA256 {
		return
	}
	if j.PreviousAbsent {
		_ = os.Remove(e.Settings.ManagedConfig)
		return
	}
	previous, err := readArtifact(filepath.Join(e.Dir, "pre-attempt.json"))
	if err == nil && Digest(previous) == j.PreviousSHA256 {
		_ = AtomicWrite(e.Settings.ManagedConfig, previous)
	}
}

func (e *Engine) cleanupGood() error {
	files, err := filepath.Glob(filepath.Join(e.Dir, "good-*.json"))
	if err != nil {
		return err
	}
	for _, p := range files {
		if p != e.goodPath() {
			if err = os.Remove(p); err != nil {
				return err
			}
		}
	}
	return nil
}
func OpenEngine(dir string) (*Engine, error) {
	s, err := LoadSettings(dir)
	if err != nil {
		return nil, err
	}
	st, err := LoadState(dir)
	if err != nil {
		return nil, err
	}
	cred, key, err := ReadIdentity(dir)
	if err != nil {
		return nil, errors.New("agent is not enrolled")
	}
	// Expiry blocks network authentication, never restoration of a locally verified
	// workload. Verify stored credentials at a time within their signed lifetime.
	pair, err := tls.X509KeyPair([]byte(cred.CertificatePEM), key)
	if err != nil {
		return nil, errors.New("stored credential key mismatch")
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, err
	}
	if err = validateCredentialsAt(cred, key, cred.DeviceID, cert.NotBefore.Add(time.Second)); err != nil {
		return nil, err
	}
	st, err = recoverIdentityTransition(dir, cred, st)
	if err != nil {
		return nil, err
	}
	client, err := NewClient(s, &cred, key)
	if err != nil {
		return nil, err
	}
	st.DeviceID = cred.DeviceID
	log := newVectorLog(dir)
	engine := &Engine{Dir: dir, Settings: s, State: st, Credentials: cred, Client: client, BootID: RandomID(), Driver: &VectorDriver{Settings: s, Dir: dir, Log: log}, Log: log}
	if s.MetricsURL != "" {
		engine.Metrics, err = NewMetricsCollector(s.MetricsURL)
		if err != nil {
			client.Close()
			return nil, err
		}
	}
	return engine, nil
}
func (e *Engine) renew(ctx context.Context) error {
	if time.Until(e.Credentials.CertificateExpiresAt) > 24*time.Hour {
		return nil
	}
	return e.renewForced(ctx)
}
func (e *Engine) renewForced(ctx context.Context) error {
	key, csr, err := ensureKeyFile(filepath.Join(e.Dir, "renewal-key.pem"))
	if err != nil {
		return err
	}
	next, err := e.Client.Renew(ctx, e.Dir, e.Credentials, key, csr)
	if err != nil {
		return err
	}
	client, err := NewClient(e.Settings, &next, key)
	if err != nil {
		return err
	}
	if err = StoreIdentity(e.Dir, next, key); err != nil {
		client.Close()
		return err
	}
	e.Client.Close()
	e.Client = client
	e.Credentials = next
	_ = os.Remove(filepath.Join(e.Dir, "renewal-key.pem"))
	return nil
}

// runningAgentBuild identifies this process's executable. Run reads it first
// thing: an upgrade can replace the file while recovery and startup run. On
// Linux /proc/self/exe is the running image even after the file is replaced.
func runningAgentBuild() *AgentBuild {
	digest, err := runningExecutableDigest()
	if err != nil {
		return nil
	}
	return &AgentBuild{Version: Version, SHA256: digest}
}

func runningExecutableDigest() (string, error) {
	if runtime.GOOS == "linux" {
		if f, err := os.Open("/proc/self/exe"); err == nil {
			defer f.Close()
			h := sha256.New()
			if _, err = io.Copy(h, f); err == nil {
				return hex.EncodeToString(h.Sum(nil)), nil
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return FileDigest(exe)
}

// interruptedCheckIn reports a check-in cut short by the agent stopping: a
// clean stop, not an outage.
func interruptedCheckIn(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return true
	}
	ce, ok := AsConnectionError(err)
	return ok && ce.Code == "CANCELED"
}

// recordCheckInFailure keeps the outage for status: the first failed
// check-in since the last success, with the latest reason. Only network
// failures count, never a check-in interrupted by stopping the agent.
func (e *Engine) recordCheckInFailure(ctx context.Context, err error, message string) {
	ce, network := AsConnectionError(err)
	if !network || interruptedCheckIn(ctx, err) {
		return
	}
	failure := CheckInFailure{Since: e.now(), Message: message, Code: ce.Code}
	if previous := e.State.CheckInFailure; previous != nil {
		failure.Since = previous.Since
	}
	e.State.CheckInFailure = &failure
	_ = e.save()
}

// takeQueuedRetry answers `vectory retry` run while this agent holds the
// lock: it lifts the hold on the failed version, as the stopped-agent retry
// does, so the next reconciliation tries it again. It reports whether a
// failed version was waiting.
func (e *Engine) takeQueuedRetry() bool {
	path := filepath.Join(e.Dir, retryRequestName)
	if _, err := os.Lstat(path); err != nil {
		return false
	}
	held := e.State.FailedGeneration != nil || e.State.FailedEffectiveSHA256 != ""
	e.State.FailedGeneration = nil
	e.State.FailedEffectiveSHA256 = ""
	if held && e.save() != nil {
		return false
	}
	if os.Remove(path) == nil {
		_ = syncDir(e.Dir)
	}
	return held
}

// runOptions change how Run reports itself. serviceManager overrides what the
// environment says: setup's one-shot check-in is none, since the process
// stops right after it, and the Windows service entry is windows.
type runOptions struct {
	once           bool
	serviceManager string
	// noWake: check in on the schedule only, never holding a wait open.
	noWake bool
	// verbose also logs every check-in (vectory run --verbose).
	verbose bool
}

// Run runs the agent: continuously, or for one complete check-in.
func Run(ctx context.Context, dir string, once bool, report func(string)) error {
	return runWith(ctx, dir, runOptions{once: once}, report)
}

// RunContinuous runs the agent continuously with the options of vectory run:
// noWake checks in on the schedule only and never holds a wait open
// (--no-wake); verbose also logs every check-in (--verbose).
func RunContinuous(ctx context.Context, dir string, noWake, verbose bool, report func(string)) error {
	return runWith(ctx, dir, runOptions{noWake: noWake, verbose: verbose}, report)
}

// RunWindowsService runs the agent as the Windows service.
func RunWindowsService(ctx context.Context, dir string, report func(string)) error {
	return runWith(ctx, dir, runOptions{serviceManager: "windows"}, report)
}

func runWith(ctx context.Context, dir string, options runOptions, report func(string)) error {
	once := options.once
	build := runningAgentBuild()
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	e, err := OpenEngine(dir)
	if err != nil {
		return err
	}
	e.State.Agent = build
	e.ServiceManager = options.serviceManager
	if e.ServiceManager == "" {
		e.ServiceManager = runningServiceManager()
	}
	defer func() { e.Client.Close() }()
	defer func() {
		if e.Metrics != nil {
			e.Metrics.client.CloseIdleConnections()
		}
		if e.Log != nil {
			e.Log.close()
		}
	}()
	defer func() {
		alive := e.Driver.Alive()
		if alive {
			report(fmt.Sprintf("Stopping Vector: it finishes in-flight events for up to %d s.", e.Settings.gracefulShutdownSeconds()))
		}
		started := time.Now()
		stopped := e.Driver.Stop()
		if alive {
			report(stoppedLine(time.Since(started), e.Settings.gracefulShutdownSeconds(), stopped))
		}
		if e.State.ApplyState == "verified_applied" {
			e.State.ApplyState = "verification_unknown"
			e.State.Error = &Issue{Code: "PROCESS_STOPPED", Stage: "observation", Message: "The agent supervisor stopped; restart the service to re-establish activation"}
			e.observeVerifiedAttempt("verification_unknown", e.State.Error)
			_ = e.save()
		}
	}()
	if err = e.Recover(ctx); err != nil {
		report(err.Error())
	} else if err = e.StartExisting(ctx); err != nil {
		report(err.Error())
	} else if line := startupLine(e.State, e.Driver.Alive()); line != "" {
		report(line)
	}
	// The outcome already true at start isn't news; each new one is said once.
	announced, _ := outcomeLine(e.State)
	if e.Settings.VectorVersion == "" {
		// Adopted before the version was recorded: report what the binary says.
		if version, err := ProbeVector(ctx, e.Settings); err == nil {
			e.Settings.VectorVersion = version
		}
	}
	failures, followed, complete := 0, false, false
	supervisor := &workloadSupervisor{}
	e.supervisor = supervisor
	for {
		if ctx.Err() != nil {
			return nil
		}
		reported := appliedOutcome{e.State.ApplyState, e.State.ReportedGeneration}
		known := slices.Clone(e.State.ServerFeatures)
		if e.takeQueuedRetry() {
			report("Retry requested on this host: trying the failed version again.")
		}
		err = supervisor.poll(ctx, e, report)
		switch {
		case err != nil && ctx.Err() != nil:
			// Stopping the agent interrupted the check-in: not an outage.
			if once {
				return err
			}
			return nil
		case err != nil:
			failures++
			// A version that failed to apply is said once, in the words of
			// its diagnostic; a failed check-in is said as a connection problem.
			if _, network := AsConnectionError(err); !network {
				if key, line := outcomeLine(e.State); key != "" && key != announced {
					announced = key
					report(line)
					break
				}
			}
			message := describeCheckInFailure(err, e.State.LastHeartbeat, e.now())
			report(message)
			e.recordCheckInFailure(ctx, err, message)
		default:
			failures = 0
			if failure := e.State.CheckInFailure; failure != nil {
				report(fmt.Sprintf("Reconnected to %s after %s.", e.Settings.Server, preciseDuration(e.now().Sub(failure.Since))))
				e.State.CheckInFailure = nil
				_ = e.save()
			}
			if key, line := outcomeLine(e.State); key != "" && key != announced {
				announced = key
				report(line)
			}
			if options.verbose {
				report("Checked in: " + applyStateLabels[e.State.ApplyState] + ".")
			}
		}
		if once {
			// A first check-in learns which fields the server accepts. A
			// process that stops right after it sends one complete check-in
			// more, so the server sees what a running agent reports (host
			// runtime, what keeps it running, whether Vector runs).
			if err == nil && !complete && learnedFeatures(known, e.State.ServerFeatures) {
				complete = true
				continue
			}
			return err
		}
		seconds := checkInSeconds(e.State.Policy, failures)
		var b [1]byte
		_, _ = rand.Read(b[:])
		delay := time.Duration(float64(seconds) * (0.8 + float64(b[0])/255*0.4) * float64(time.Second))
		// Never two follow-ups in a row: a flapping outcome can't speed up
		// the check-in cadence.
		followed = err == nil && !followed && followUp(reported, appliedOutcome{e.State.ApplyState, e.State.ReportedGeneration})
		if followed {
			delay = followUpDelay
		}
		if delay < e.Client.RetryAfter {
			delay = e.Client.RetryAfter
		}
		// Where the server offers it, a change reaches this agent within
		// seconds instead of at the next check-in (see wake.go).
		if !supervisor.wait(ctx, e, delay, report, e.wakeAllowed(options.noWake, failures)) {
			return nil
		}
	}
}

// checkInSeconds is how long to wait before the next check-in, before jitter:
// the policy's interval while check-ins succeed, and while they fail a wait
// that doubles from 10 s and stops at 5 min. That bounds every retry of a
// failed check-in, download included: one attempt per wait, never a tight loop,
// never more often than every ten seconds and never less often than every five
// minutes.
func checkInSeconds(policy Policy, failures int) int {
	seconds := policy.HeartbeatSeconds
	if seconds < 10 || seconds > 3600 {
		seconds = 60
	}
	if failures > 0 {
		seconds = min(5<<min(failures, 6), 300)
	}
	return seconds
}

// learnedFeatures reports whether the server lists a heartbeat field the
// agent didn't know it accepts before the last check-in.
func learnedFeatures(before, after []string) bool {
	for _, feature := range after {
		if !slices.Contains(before, feature) {
			return true
		}
	}
	return false
}

// runningServiceManager says what keeps this process running, from what
// service managers put in the environment of the processes they start:
// systemd sets INVOCATION_ID for every unit and launchd sets
// XPC_SERVICE_NAME to the job's label. The Windows service entry says so
// itself. Anything else is none: a foreground run, a supervisor of the
// operator's own, or nothing at all.
func runningServiceManager() string {
	switch runtime.GOOS {
	case "linux":
		if os.Getenv("INVOCATION_ID") != "" && SystemdAvailable() {
			return "systemd"
		}
	case "darwin":
		if os.Getenv("XPC_SERVICE_NAME") == launchdLabel {
			return "launchd"
		}
	}
	return "none"
}

// appliedOutcome is what a heartbeat tells the server about the last apply.
type appliedOutcome struct {
	state      string
	generation uint64
}

// followUpDelay brings an apply's outcome to the dashboard within seconds
// instead of a full check-in interval. Activation already watched Vector stay
// up; one second is the spacing wake-ups keep too.
const followUpDelay = time.Second

// followUp reports whether this poll finished an apply the last heartbeat
// didn't report. The follow-up heartbeat reports it, so the next poll sees
// no change and returns to the normal interval: one follow-up per outcome.
func followUp(reported, now appliedOutcome) bool {
	switch now.state {
	case "verified_applied", "failed", "rolled_back":
		return now != reported
	}
	return false
}

func StateSummary(dir string) (map[string]any, error) {
	st, err := LoadState(dir)
	if err != nil {
		return nil, err
	}
	s, err := LoadSettings(dir)
	if err != nil {
		return nil, err
	}
	h, _ := FileDigest(s.ManagedConfig)
	running, _ := readArtifact(s.ManagedConfig)
	return map[string]any{"state": st, "actual_sha256": h, "local_paused": LocalPaused(dir), "drift": st.LastGoodSHA256 != "" && h != st.LastGoodSHA256, "telemetry_available": st.Telemetry != nil, "version": Version, "configuration_mode": s.CapabilityPolicy.ConfigurationMode(), "diagnostics": localDiagnostics(dir, s, st), "host_runtime": hostRuntimeFor(s, dir, running), "vector_log": filepath.Join(dir, vectorLogName)}, nil
}
func Doctor(ctx context.Context, dir string) (map[string]any, error) {
	return doctorWithProbe(ctx, dir, ProbeVector)
}
func doctorWithProbe(ctx context.Context, dir string, probe func(context.Context, Settings) (string, error)) (map[string]any, error) {
	s, err := LoadSettings(dir)
	if err != nil {
		return nil, err
	}
	telemetry := "unavailable (no local endpoint configured)"
	if s.MetricsURL != "" {
		telemetry = "explicit loopback Prometheus endpoint configured; sample availability shown in status"
	}
	r := map[string]any{"vector_version": "", "adopted": s.Adopted, "state_dir": dir, "managed_config": s.ManagedConfig, "tls_minimum": "1.3", "telemetry": telemetry, "configuration_mode": s.CapabilityPolicy.ConfigurationMode(), "binary_integrity": false}
	st, err := LoadState(dir)
	if err != nil {
		return r, errors.New("local apply state is unreadable; preserve state and inspect it under the service account")
	}
	r["diagnostics"] = localDiagnostics(dir, s, st)
	// Diagnostics must enforce the same adoption boundary as validation/start.
	// Never execute even --version on a binary whose adopted digest changed.
	h, err := FileDigest(s.VectorBinary)
	if err != nil || h != s.VectorBinarySHA256 {
		diagnostics := localDiagnostics(dir, s, st)
		diagnostics.NextAction = "Restore the previously approved Vector binary, or stop the agent and use re-adopt with an independently trusted expected SHA256. Re-adoption validates existing configuration but does not start or verify a workload."
		r["diagnostics"] = diagnostics
		return r, errors.New("Vector binary differs from adopted digest; restore the approved binary or stop the agent and use re-adopt with a trusted expected SHA256")
	}
	r["binary_integrity"] = true
	v, err := probe(ctx, s)
	if err != nil {
		return r, err
	}
	r["vector_version"] = v
	if err = SafePath(s.ManagedConfig); err != nil {
		return r, err
	}
	return r, nil
}
func Install(ctx context.Context, dir, binary, config string, adopt bool, policy *CapabilityPolicy) error {
	options := InstallOptions{Adopt: adopt, CapabilityPolicy: policy}
	if binary != "" {
		options.VectorBinary = &binary
	}
	if config != "" {
		options.ManagedConfig = &config
	}
	return InstallWithOptions(ctx, dir, options)
}

// ConfigureFullVector is a stopped-daemon, host-operator operation. No remote
// manifest or policy path can call it or change this local settings field.
func ConfigureFullVector(dir string, enabled bool) error {
	unlock, err := lockSettingsMaintenance(dir)
	if err != nil {
		return err
	}
	defer unlock()
	doc, err := loadSettingsDocument(dir)
	if err != nil {
		return err
	}
	s := doc.value
	if s.CapabilityPolicy.FullVectorConfig != enabled {
		s.CapabilityPolicy.FullVectorConfig = enabled
		return commitSettingsWithRetryReset(dir, doc, s)
	}
	return doc.save(s)
}
