package agent

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	e.State.ApplyState = "failed"
	e.State.Error = &Issue{code, stage, message}
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
	return e.rollback(ctx, j.Generation, "An interrupted apply was recovered")
}
func (e *Engine) StartExisting(ctx context.Context) error {
	if !e.Settings.Adopted {
		return nil
	}
	if e.Driver.Alive() {
		return nil
	}
	// Restart the established workload after offline/manual drift. Pause preserves
	// manual content; absent pause, a last-good artifact needs no new authorization.
	if !e.paused() && e.State.LastGoodSHA256 != "" && e.actual() != e.State.LastGoodSHA256 {
		good, err := readArtifact(e.goodPath())
		if err != nil || Digest(good) != e.State.LastGoodSHA256 {
			return e.fail("RECOVERY_INVALID", "startup", "Last verified recovery artifact is missing or corrupted")
		}
		if err = e.Settings.CapabilityPolicy.Check(good); err != nil {
			return e.fail("CAPABILITY_DENIED", "startup", "Recovery content violates current local capability policy")
		}
		if err = AtomicWrite(e.Settings.ManagedConfig, good); err != nil {
			return e.fail("WRITE_FAILED", "startup", "Cannot restore the established local workload")
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
		return e.fail("CAPABILITY_DENIED", "startup", "Existing managed configuration violates local capability policy")
	}
	if err = e.Driver.Validate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.fail("VALIDATION_FAILED", "startup", "Existing configuration failed Vector validation; inspect the protected local configuration")
	}
	if err = e.Driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.fail("ACTIVATION_FAILED", "startup", "Existing Vector startup could not be verified")
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
	} else if e.State.FailedGeneration == nil {
		e.State.ApplyState = "unmanaged"
	}
	e.State.ActualSHA256 = h
	if e.paused() {
		e.State.ApplyState = "paused"
		e.State.RemotePauseAcknowledged = e.State.Policy.SyncPaused
	}
	return e.save()
}
func (e *Engine) Poll(ctx context.Context) error {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return err
	}
	nonce := base64.StdEncoding.EncodeToString(raw[:])
	e.State.ActualSHA256 = e.actual()
	e.State.Telemetry = nil
	if e.State.Policy.TelemetryEnabled && e.Metrics != nil {
		e.State.Telemetry = e.Metrics.Collect(ctx, e.now())
	}
	if e.paused() {
		e.State.ApplyState = "paused"
		e.State.RemotePauseAcknowledged = e.State.Policy.SyncPaused
	}
	if e.State.ApplyState == "verified_applied" && !e.Driver.Alive() {
		e.State.ApplyState = "verification_unknown"
		e.State.Error = &Issue{"PROCESS_EXITED", "observation", "Owned Vector process is not running; reconciliation will attempt recovery"}
	}
	b, err := e.Client.request(ctx, "POST", "/agent/v1/heartbeat", Heartbeat{ProtocolVersion: 1, RequestID: RandomID(), Nonce: nonce, BootID: e.BootID, AgentVersion: Version, VectorVersion: VectorVersion, ReportedGeneration: e.State.ReportedGeneration, PolicyGeneration: e.State.HighestPolicyGeneration, ActualSHA256: e.State.ActualSHA256, ApplyState: e.State.ApplyState, LocalPaused: LocalPaused(e.Dir), RemotePauseAcknowledged: e.State.RemotePauseAcknowledged, Error: e.State.Error, Telemetry: e.State.Telemetry, AppliedTemplateSHA256: e.State.AppliedTemplateSHA256, SecretRevision: e.State.SecretRevision})
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
func (e *Engine) Reconcile(ctx context.Context, m Manifest) error {
	if e.paused() {
		e.State.ApplyState = "paused"
		e.State.RemotePauseAcknowledged = e.State.Policy.SyncPaused
		return e.save()
	}
	e.State.RemotePauseAcknowledged = false
	if m.Desired == nil {
		e.State.ApplyState = "unmanaged"
		e.State.Error = nil
		return e.save()
	}
	d := m.Desired
	if d.VectorVersion != VectorVersion {
		return e.fail("INCOMPATIBLE", "compatibility", "Desired configuration requires an unsupported Vector version")
	}
	if !e.Settings.Adopted {
		return e.fail("ADOPTION_REQUIRED", "preflight", "Host operator must explicitly adopt the fixed Vector binary and sole managed config")
	}
	template, err := e.loadTemplate(ctx, d)
	if err != nil {
		return e.fail("DOWNLOAD_FAILED", "download", "Cannot obtain a digest-verified authorized template")
	}
	data, usesSecrets, err := ResolveLocalSecrets(template, e.Settings.SecretFiles)
	if err != nil {
		return e.fail("SECRET_RESOLUTION_FAILED", "materialization", "Cannot resolve configuration references; check the approved local bindings and private secret files")
	}
	effectiveSHA := Digest(data)
	if e.State.FailedGeneration != nil && *e.State.FailedGeneration == m.Generation && (e.State.FailedEffectiveSHA256 == effectiveSHA || (e.State.FailedEffectiveSHA256 == "" && !usesSecrets)) {
		return nil
	}
	if e.State.MaterializationSHA256 != effectiveSHA || (usesSecrets && e.State.SecretRevision == 0) {
		if usesSecrets {
			if e.State.SecretRevision == ^uint64(0) {
				return e.fail("SECRET_REVISION_EXHAUSTED", "materialization", "Local secret revision counter exhausted")
			}
			e.State.SecretRevision++
		}
		e.State.MaterializationSHA256 = effectiveSHA
		e.State.ApplyState = "desired"
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
	if actual == effectiveSHA && e.State.LastGoodSHA256 == effectiveSHA && e.Driver.Alive() {
		e.markApplied(m.Generation, d.SHA256, effectiveSHA, attemptRevision, usesSecrets)
		return e.save()
	}
	e.State.ApplyState = "downloaded"
	if err = e.save(); err != nil {
		return err
	}
	if err = e.Settings.CapabilityPolicy.Check(data); err != nil {
		g := m.Generation
		e.State.FailedGeneration = &g
		e.State.FailedEffectiveSHA256 = effectiveSHA
		return e.fail("CAPABILITY_DENIED", "validation", "Effective configuration violates the local capability policy")
	}
	stage := filepath.Join(filepath.Dir(e.Settings.ManagedConfig), ".vectory-stage-"+RandomID()+".json")
	if err = AtomicWrite(stage, data); err != nil {
		return e.fail("WRITE_FAILED", "staging", "Cannot securely stage configuration")
	}
	defer os.Remove(stage)
	if err = e.Driver.Validate(ctx, stage); err != nil {
		g := m.Generation
		e.State.FailedGeneration = &g
		e.State.FailedEffectiveSHA256 = effectiveSHA
		return e.fail("VALIDATION_FAILED", "validation", "Effective configuration failed Vector validation; inspect the protected local configuration")
	}
	e.State.ApplyState = "validated"
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("validated"); err != nil {
		return err
	}
	if e.paused() {
		e.State.ApplyState = "paused"
		e.State.RemotePauseAcknowledged = e.State.Policy.SyncPaused
		return e.save()
	}
	if e.now().After(m.ExpiresAt) || e.State.HighestGeneration != m.Generation {
		return errors.New("manifest expired or superseded before commit")
	}
	previous, readErr := readArtifact(e.Settings.ManagedConfig)
	if readErr != nil && !os.IsNotExist(readErr) {
		return e.fail("PATH_UNSAFE", "commit", "Managed path cannot be read safely")
	}
	if readErr == nil {
		if err = AtomicWrite(filepath.Join(e.Dir, "pre-attempt.json"), previous); err != nil {
			return err
		}
	}
	j := Journal{Stage: "prepared", Generation: m.Generation, DesiredSHA256: effectiveSHA, PreviousSHA256: Digest(previous), SecretRevision: attemptRevision}
	if err = WriteJSON(filepath.Join(e.Dir, "journal.json"), j); err != nil {
		return err
	}
	if err = e.boundary("prepared"); err != nil {
		return err
	}
	// Pause can race validation or journal IO; this last local check precedes commit.
	if e.paused() {
		_ = os.Remove(filepath.Join(e.Dir, "journal.json"))
		e.State.ApplyState = "paused"
		return e.save()
	}
	if err = AtomicWrite(e.Settings.ManagedConfig, data); err != nil {
		return e.rollback(ctx, m.Generation, "Managed configuration replacement failed")
	}
	j.Stage = "written"
	if err = WriteJSON(filepath.Join(e.Dir, "journal.json"), j); err != nil {
		return err
	}
	e.State.ApplyState = "written"
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("written"); err != nil {
		return err
	}
	e.State.ApplyState = "reload_requested"
	if err = e.save(); err != nil {
		return err
	}
	if err = e.boundary("reload_requested"); err != nil {
		return err
	}
	if err = e.Driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.rollback(ctx, m.Generation, "Effective configuration activation could not be verified")
	}
	if e.actual() != effectiveSHA {
		return e.rollback(ctx, m.Generation, "Managed content changed during activation")
	}
	if err = e.boundary("activated"); err != nil {
		return err
	}
	if err = AtomicWrite(filepath.Join(e.Dir, "good-"+effectiveSHA+".json"), data); err != nil {
		return e.rollback(ctx, m.Generation, "Cannot persist verified recovery content")
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
func (e *Engine) markApplied(generation uint64, templateSHA, effectiveSHA string, revision uint64, usesSecrets bool) {
	e.State.LastGoodSHA256 = effectiveSHA
	e.State.ActualSHA256 = effectiveSHA
	e.State.ReportedGeneration = generation
	e.State.AppliedTemplateSHA256 = ""
	if usesSecrets {
		e.State.AppliedTemplateSHA256 = templateSHA
	}
	e.State.AppliedSecretRevision = revision
	e.State.ApplyState = "verified_applied"
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
		return nil, err
	}
	if int64(len(data)) != d.Size || Digest(data) != d.SHA256 {
		return nil, errors.New("artifact size or digest verification failed")
	}
	if err = AtomicWrite(path, data); err != nil {
		return nil, err
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
func (e *Engine) rollback(ctx context.Context, g uint64, reason string) error {
	e.State.FailedGeneration = &g
	e.State.FailedEffectiveSHA256 = e.State.MaterializationSHA256
	if e.State.LastGoodSHA256 == "" {
		_ = e.Driver.Stop()
		return e.fail("ROLLBACK_UNAVAILABLE", "rollback", reason+"; no verified recovery content exists")
	}
	b, err := readArtifact(e.goodPath())
	if err != nil || Digest(b) != e.State.LastGoodSHA256 {
		return e.fail("ROLLBACK_FAILED", "rollback", "Verified recovery artifact missing or corrupted")
	}
	if err = e.Settings.CapabilityPolicy.Check(b); err != nil {
		return e.fail("ROLLBACK_FAILED", "rollback", "Recovery content violates current local capability policy")
	}
	if err = AtomicWrite(e.Settings.ManagedConfig, b); err != nil {
		return e.fail("ROLLBACK_FAILED", "rollback", "Cannot restore verified recovery content")
	}
	if err = e.Driver.Validate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.fail("ROLLBACK_FAILED", "rollback", "Restored configuration validation failed")
	}
	if err = e.Driver.Activate(ctx, e.Settings.ManagedConfig); err != nil {
		return e.fail("ROLLBACK_FAILED", "rollback", "Restored Vector activation could not be verified")
	}
	e.State.ActualSHA256 = e.State.LastGoodSHA256
	e.State.ApplyState = "rolled_back"
	e.State.Error = &Issue{"APPLY_ROLLED_BACK", "rollback", reason + "; last verified configuration restored"}
	if err = e.save(); err != nil {
		return err
	}
	if err = os.Remove(filepath.Join(e.Dir, "journal.json")); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDir(e.Dir)
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
	engine := &Engine{Dir: dir, Settings: s, State: st, Credentials: cred, Client: client, BootID: RandomID(), Driver: &VectorDriver{Settings: s}}
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
func Run(ctx context.Context, dir string, once bool, report func(string)) error {
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	e, err := OpenEngine(dir)
	if err != nil {
		return err
	}
	defer func() { e.Client.Close() }()
	if e.Metrics != nil {
		defer e.Metrics.client.CloseIdleConnections()
	}
	defer func() {
		_ = e.Driver.Stop()
		if e.State.ApplyState == "verified_applied" {
			e.State.ApplyState = "verification_unknown"
			e.State.Error = &Issue{"PROCESS_STOPPED", "observation", "The agent supervisor stopped; restart the service to re-establish activation"}
			_ = e.save()
		}
	}()
	if err = e.Recover(ctx); err != nil {
		report(err.Error())
	} else if err = e.StartExisting(ctx); err != nil {
		report(err.Error())
	}
	failures := 0
	for {
		if ctx.Err() != nil {
			return nil
		}
		if err = e.renew(ctx); err != nil {
			report("Credential renewal failed; keeping the current workload")
		}
		err = e.Poll(ctx)
		if err != nil {
			failures++
			report(err.Error())
		} else {
			failures = 0
			report("heartbeat: " + e.State.ApplyState)
		}
		if once {
			return err
		}
		seconds := e.State.Policy.HeartbeatSeconds
		if seconds < 10 || seconds > 3600 {
			seconds = 60
		}
		if failures > 0 {
			seconds = 5 << min(failures, 6)
			if seconds > 300 {
				seconds = 300
			}
		}
		var b [1]byte
		_, _ = rand.Read(b[:])
		delay := time.Duration(float64(seconds) * (0.8 + float64(b[0])/255*0.4) * float64(time.Second))
		if delay < e.Client.RetryAfter {
			delay = e.Client.RetryAfter
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
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
	return map[string]any{"state": st, "actual_sha256": h, "local_paused": LocalPaused(dir), "drift": st.LastGoodSHA256 != "" && h != st.LastGoodSHA256, "telemetry_available": st.Telemetry != nil, "version": Version}, nil
}
func Doctor(ctx context.Context, dir string) (map[string]any, error) {
	s, err := LoadSettings(dir)
	if err != nil {
		return nil, err
	}
	v, err := ProbeVector(ctx, s)
	telemetry := "unavailable (no local endpoint configured)"
	if s.MetricsURL != "" {
		telemetry = "explicit loopback Prometheus endpoint configured; sample availability shown in status"
	}
	r := map[string]any{"vector_version": v, "adopted": s.Adopted, "state_dir": dir, "managed_config": s.ManagedConfig, "tls_minimum": "1.3", "telemetry": telemetry}
	if err != nil {
		return r, err
	}
	h, err := FileDigest(s.VectorBinary)
	if err != nil || h != s.VectorBinarySHA256 {
		return r, errors.New("Vector binary differs from adopted digest")
	}
	if err = SafePath(s.ManagedConfig); err != nil {
		return r, err
	}
	r["binary_integrity"] = true
	return r, nil
}
func Install(ctx context.Context, dir, binary, config string, adopt bool, policy *CapabilityPolicy) error {
	if err := CheckFreshStateDirectory(dir); err != nil {
		return err
	}
	if err := PrivateDir(dir); err != nil {
		return err
	}
	unlock, err := Lock(dir)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := LoadSettings(dir)
	if err == nil {
		if (binary == "" || binary == s.VectorBinary) && (config == "" || config == s.ManagedConfig) {
			return nil
		}
		return errors.New("installation already exists; edit protected settings locally to change adoption")
	} else if !os.IsNotExist(err) {
		return err
	}
	if !adopt {
		return errors.New("explicit --adopt is required; stop the previous Vector service and inventory all existing config/include paths first")
	}
	if !filepath.IsAbs(binary) || !filepath.IsAbs(config) || filepath.Ext(config) != ".json" {
		return errors.New("provide absolute Vector binary and sole managed .json configuration paths")
	}
	parent := filepath.Dir(filepath.Clean(config))
	if parent == filepath.VolumeName(parent)+string(filepath.Separator) {
		return errors.New("managed configuration must use a dedicated directory, not a filesystem root")
	}
	if err = SafePath(binary); err != nil {
		return err
	}
	if err = SafePath(config); err != nil {
		return err
	}
	if err = CheckManagedDirectory(config, dir); err != nil {
		return err
	}
	s = Settings{VectorBinary: binary, ManagedConfig: config, Adopted: true, ValidationSeconds: 30, StartupSeconds: 20}
	if _, err = ProbeVector(ctx, s); err != nil {
		return err
	}
	s.VectorBinarySHA256, err = FileDigest(binary)
	if err != nil {
		return err
	}
	if policy != nil {
		s.CapabilityPolicy = *policy
	}
	if err = PrivateDir(filepath.Dir(config)); err != nil {
		return err
	}
	if data, err := readArtifact(config); err == nil {
		if err = AtomicWrite(filepath.Join(dir, "adoption-backup.json"), data); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		return err
	}
	return SaveState(dir, State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}})
}
func ConfigureEnrollment(dir, server, name, ca string) error {
	s, err := LoadSettings(dir)
	if err != nil {
		return err
	}
	origin, err := NormalizeServer(server)
	if err != nil {
		return err
	}
	if name == "" || len(name) > 128 {
		return errors.New("machine name must contain 1..128 characters")
	}
	if s.Server != "" && (s.Server != origin || s.Name != name) {
		return errors.New("enrollment settings cannot change an existing identity")
	}
	s.Server = origin
	s.Name = name
	s.CAFile = ca
	return WriteJSON(filepath.Join(dir, "settings.json"), s)
}
func ExitDescription(code int) string {
	return fmt.Sprintf("exit %d: 0 success; 1 operational error; 2 invalid command; 3 security/preflight rejection", code)
}
