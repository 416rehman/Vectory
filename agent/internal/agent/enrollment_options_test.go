package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func enrollmentOptionsFixture(t *testing.T) (string, Settings) {
	t.Helper()
	dir := t.TempDir()
	s := Settings{Server: "https://127.0.0.1:9", Name: "old-mistyped", CAFile: "old-missing-ca", Adopted: true, MetricsURL: "http://127.0.0.1:9598/metrics", SecretFiles: map[string]string{"KEEP": "synthetic-reference"}}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), s); err != nil {
		t.Fatal(err)
	}
	fields := maintenanceFields(t, filepath.Join(dir, "settings.json"))
	fields["future_extension"] = json.RawMessage(`{"exact":18446744073709551615}`)
	raw, _ := json.Marshal(fields)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), append([]byte(" \n\t"), raw...), 0600); err != nil {
		t.Fatal(err)
	}
	if err := SaveState(dir, State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	return dir, s
}

func enrollmentSnapshot(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		files[rel] = data
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestEnrollmentOptionsLocalRefusalsPreserveFiles(t *testing.T) {
	for _, kind := range []string{"empty-token", "large-token", "invalid-origin", "invalid-name", "long-name", "missing-ca", "empty-pem", "cancelled", "missing-state", "corrupt-state", "already-enrolled", "corrupt-identity", "legacy-missing-key", "pending-mismatch", "pending-missing-key", "recovery-no-identity", "recovery-token-mismatch", "recovery-orphan", "recovery-bad-ca"} {
		t.Run(kind, func(t *testing.T) {
			dir, s := enrollmentOptionsFixture(t)
			options := EnrollmentOptions{Server: s.Server, Name: "corrected-machine", Token: "synthetic-token", CAFile: optionPointer("")}
			ctx := context.Background()
			switch kind {
			case "empty-token":
				options.Token = " \n\t"
			case "large-token":
				options.Token = strings.Repeat("x", 4097)
			case "invalid-origin":
				options.Server = "http://127.0.0.1:9"
			case "invalid-name":
				options.Name = "invalid name"
			case "long-name":
				options.Name = strings.Repeat("x", 101)
			case "missing-ca":
				options.CAFile = optionPointer(filepath.Join(dir, "missing-ca"))
			case "empty-pem":
				path := filepath.Join(dir, "bad-ca.pem")
				_ = AtomicWrite(path, []byte("not a certificate"))
				options.CAFile = &path
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "missing-state":
				_ = os.Remove(filepath.Join(dir, "state.json"))
			case "corrupt-state":
				_ = AtomicWrite(filepath.Join(dir, "state.json"), []byte(`{}`))
			case "already-enrolled":
				_ = WriteJSON(filepath.Join(dir, "identity.json"), IdentityBundle{Credentials: Credentials{DeviceID: "existing"}, PrivateKeyPEM: "synthetic"})
			case "corrupt-identity":
				_ = AtomicWrite(filepath.Join(dir, "identity.json"), []byte(`{`))
			case "legacy-missing-key":
				_ = WriteJSON(filepath.Join(dir, "credentials.json"), Credentials{DeviceID: "legacy"})
			case "pending-mismatch", "pending-missing-key":
				name := options.Name
				if kind == "pending-mismatch" {
					name = "original-name"
					_, _, _ = EnsureKey(dir)
				}
				_ = WriteJSON(filepath.Join(dir, "enrollment.json"), enrollmentPending{RandomID(), name, options.Server})
			case "recovery-no-identity", "recovery-token-mismatch", "recovery-orphan", "recovery-bad-ca":
				options.Recover, options.Name = true, s.Name
				if kind != "recovery-no-identity" {
					_ = WriteJSON(filepath.Join(dir, "identity.json"), IdentityBundle{Credentials: Credentials{DeviceID: "existing"}, PrivateKeyPEM: "synthetic"})
				}
				if kind == "recovery-bad-ca" {
					options.CAFile = optionPointer(filepath.Join(dir, "missing-ca"))
				}
				if kind == "recovery-token-mismatch" || kind == "recovery-orphan" {
					pending := filepath.Join(dir, "pending-recovery")
					_ = PrivateDir(pending)
					_, _, _ = EnsureKey(pending)
					_ = WriteJSON(filepath.Join(pending, "enrollment.json"), enrollmentPending{RandomID(), s.Name, s.Server})
					if kind == "recovery-token-mismatch" {
						_ = WriteJSON(filepath.Join(pending, "origin.json"), pendingRecovery{OldDeviceID: "existing", TokenSHA256: Digest([]byte("different-token"))})
					}
				}
			}
			before := enrollmentSnapshot(t, dir)
			if err := EnrollWithOptions(ctx, dir, options); err == nil {
				t.Fatal("local refusal accepted")
			}
			if !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) {
				t.Fatal("local refusal changed a persisted setting, identity, request or state")
			}
		})
	}
}

func TestEnrollmentLocalCAFailureIsCorrectableAndDirectAPIDoesNotAllocate(t *testing.T) {
	dir, s := enrollmentOptionsFixture(t)
	before := enrollmentSnapshot(t, dir)
	if err := Enroll(context.Background(), dir, s, "synthetic"); err == nil {
		t.Fatal("missing CA accepted")
	}
	if !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) {
		t.Fatal("direct enrollment allocated before CA validation")
	}
	ca := makeCA(t)
	var hits atomic.Int32
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "synthetic refusal", 403)
	}))
	caPath := filepath.Join(dir, "trusted-ca.pem")
	_ = AtomicWrite(caPath, []byte(ca.pem))
	options := EnrollmentOptions{Server: server.URL, Name: "corrected-name", Token: "synthetic", CAFile: &caPath}
	if err := EnrollWithOptions(context.Background(), dir, options); err == nil || !strings.Contains(err.Error(), "HTTP 403") {
		t.Fatal("corrected local inputs did not reach the explicit request", err)
	}
	saved, _ := LoadSettings(dir)
	if hits.Load() != 1 || saved.Server != server.URL || saved.Name != "corrected-name" || saved.CAFile != caPath {
		t.Fatal("failed local first attempt prevented correction")
	}
	if _, err := os.Stat(filepath.Join(dir, "enrollment.json")); err != nil {
		t.Fatal("potentially transmitted intent was not preserved")
	}
}

func TestEnrollmentOptionsRetryKeepsRequestKeyAndTrustUnderOneLock(t *testing.T) {
	dir, _ := enrollmentOptionsFixture(t)
	ca := makeCA(t)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	var first Enrollment
	var issued Credentials
	var calls int
	var lockWasHeld bool
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var request Enrollment
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid enrollment request")
			http.Error(w, "bad", 400)
			return
		}
		lockErr := ConfigureMetrics(dir, "http://127.0.0.1:9599/metrics")
		lockWasHeld = lockErr != nil
		block, _ := pem.Decode([]byte(request.CSRPEM))
		csr, _ := x509.ParseCertificateRequest(block.Bytes)
		if calls == 1 {
			first = request
			expiry := time.Now().Add(time.Hour).Truncate(time.Second)
			issued = Credentials{DeviceID: "enrollment-options-device", CertificatePEM: ca.issue(t, csr.PublicKey, "enrollment-options-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry}
			// The synthetic peer prepares a receipt, then actually drops the
			// accepted TLS connection without sending any response bytes.
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close()
			return
		}
		originalBlock, _ := pem.Decode([]byte(first.CSRPEM))
		original, _ := x509.ParseCertificateRequest(originalBlock.Bytes)
		if request.RequestID != first.RequestID || request.Name != first.Name || request.Token != first.Token || !SamePublicKey(original.PublicKey, csr.PublicKey) {
			t.Error("retry rebound the request")
		}
		_ = json.NewEncoder(w).Encode(issued)
	}))
	caPath := filepath.Join(dir, "trusted-ca.pem")
	_ = AtomicWrite(caPath, []byte(ca.pem))
	options := EnrollmentOptions{Server: server.URL, Name: "Mixed-Case.Name", Token: "synthetic-original-token", CAFile: &caPath}
	if err := EnrollWithOptions(context.Background(), dir, options); err == nil {
		t.Fatal("lost reply unexpectedly confirmed")
	}
	keyBefore, _ := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	pendingBefore, _ := os.ReadFile(filepath.Join(dir, "enrollment.json"))
	settingsBefore, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	options.CAFile = nil
	if err := EnrollWithOptions(context.Background(), dir, options); err != nil {
		t.Fatal(err)
	}
	keyAfter, _ := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	pendingAfter, _ := os.ReadFile(filepath.Join(dir, "enrollment.json"))
	settingsAfter, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if calls != 2 || !lockWasHeld || !bytes.Equal(keyBefore, keyAfter) || !bytes.Equal(pendingBefore, pendingAfter) || !bytes.Equal(settingsBefore, settingsAfter) {
		t.Fatal("retry changed frozen preparation or released the parent lock")
	}
	if !bytes.Contains(settingsAfter, []byte("18446744073709551615")) {
		t.Fatal("unknown exact settings value lost")
	}
	before := enrollmentSnapshot(t, dir)
	options.CAFile = optionPointer("")
	if err := EnrollWithOptions(context.Background(), dir, options); err == nil || !strings.Contains(err.Error(), "already enrolled") {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) || calls != 2 {
		t.Fatal("ordinary enrolled refusal changed trust or sent another request")
	}
}

func TestEnrollmentOptionsExplicitTrustRepairAndSystemSelectionPreservePending(t *testing.T) {
	dir, _ := enrollmentOptionsFixture(t)
	ca := makeCA(t)
	var calls atomic.Int32
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "keep retry", 503)
	}))
	caPath := filepath.Join(dir, "original-ca.pem")
	repairedPath := filepath.Join(dir, "repaired-ca.pem")
	_ = AtomicWrite(caPath, []byte(ca.pem))
	_ = AtomicWrite(repairedPath, []byte(ca.pem))
	options := EnrollmentOptions{Server: server.URL, Name: "pending-name", Token: "synthetic", CAFile: &caPath}
	_ = EnrollWithOptions(context.Background(), dir, options)
	key, _ := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	request, _ := os.ReadFile(filepath.Join(dir, "enrollment.json"))
	options.CAFile = &repairedPath
	if err := EnrollWithOptions(context.Background(), dir, options); err == nil || calls.Load() != 2 {
		t.Fatal("valid CA repair did not retry same pending request", err)
	}
	options.CAFile = optionPointer("")
	if err := EnrollWithOptions(context.Background(), dir, options); err == nil {
		t.Fatal("system roots accepted synthetic CA")
	}
	saved, _ := LoadSettings(dir)
	gotKey, _ := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	gotRequest, _ := os.ReadFile(filepath.Join(dir, "enrollment.json"))
	if saved.CAFile != "" || calls.Load() != 2 || !bytes.Equal(key, gotKey) || !bytes.Equal(request, gotRequest) {
		t.Fatal("explicit system trust was ignored or rebound a pending request")
	}
}

func TestRecoveryBadCADoesNotCompleteExistingTransition(t *testing.T) {
	dir, s := enrollmentOptionsFixture(t)
	_ = WriteJSON(filepath.Join(dir, "identity.json"), IdentityBundle{Credentials: Credentials{DeviceID: "replacement"}, PrivateKeyPEM: "synthetic"})
	_ = SaveState(dir, State{DeviceID: "old", HighestGeneration: 99, ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60}})
	_ = WriteJSON(filepath.Join(dir, "recovery-commit.json"), identityTransition{"old", "replacement"})
	pending := filepath.Join(dir, "pending-recovery")
	_ = PrivateDir(pending)
	_ = WriteJSON(filepath.Join(pending, "origin.json"), pendingRecovery{OldDeviceID: "old", NewDeviceID: "replacement", TokenSHA256: Digest([]byte("synthetic"))})
	before := enrollmentSnapshot(t, dir)
	for _, invoke := range []func() error{
		func() error { return RecoverEnrollment(context.Background(), dir, s, "synthetic") },
		func() error {
			return EnrollWithOptions(context.Background(), dir, EnrollmentOptions{Recover: true, Token: "synthetic"})
		},
	} {
		if err := invoke(); err == nil || !strings.Contains(err.Error(), "cannot read trusted CA") {
			t.Fatal("bad trust did not refuse before transition", err)
		}
		if !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) {
			t.Fatal("local CA error completed or cleaned a recovery transition")
		}
	}
}

func TestEnrollmentOptionsRecoveryPreservesStagedIntentUntilCommit(t *testing.T) {
	dir, s := enrollmentOptionsFixture(t)
	ca := makeCA(t)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	rootKey, rootCSR, err := EnsureKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(rootCSR))
	csr, _ := x509.ParseCertificateRequest(block.Bytes)
	expiry := time.Now().Add(time.Hour).Truncate(time.Second)
	old := Credentials{DeviceID: "old-device", CertificatePEM: ca.issue(t, csr.PublicKey, "old-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry}
	_ = StoreIdentity(dir, old, rootKey)
	_ = SaveState(dir, State{DeviceID: old.DeviceID, HighestGeneration: 99, LastGoodSHA256: "retained-workload", ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60}})
	_ = SetPause(dir, true)
	var calls int
	var first Enrollment
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var request Enrollment
		_ = json.NewDecoder(r.Body).Decode(&request)
		if calls == 1 {
			first = request
			http.Error(w, "uncertain", 500)
			return
		}
		block, _ := pem.Decode([]byte(request.CSRPEM))
		csr, _ := x509.ParseCertificateRequest(block.Bytes)
		originalBlock, _ := pem.Decode([]byte(first.CSRPEM))
		original, _ := x509.ParseCertificateRequest(originalBlock.Bytes)
		if request.RequestID != first.RequestID || request.Name != first.Name || request.Token != first.Token || !SamePublicKey(original.PublicKey, csr.PublicKey) {
			t.Error("recovery retry changed frozen identity")
		}
		_ = json.NewEncoder(w).Encode(Credentials{DeviceID: "new-device", CertificatePEM: ca.issue(t, csr.PublicKey, "new-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: old.SigningPublicKey, CertificateExpiresAt: expiry})
	}))
	caPath := filepath.Join(dir, "trusted-ca.pem")
	_ = AtomicWrite(caPath, []byte(ca.pem))
	fields := maintenanceFields(t, filepath.Join(dir, "settings.json"))
	fields["server"], _ = json.Marshal(server.URL)
	fields["ca_file"], _ = json.Marshal(caPath)
	raw, _ := json.Marshal(fields)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), raw, 0600)
	options := EnrollmentOptions{Recover: true, Token: "synthetic-original"}
	if err = EnrollWithOptions(context.Background(), dir, options); err == nil || !strings.Contains(err.Error(), "preparation was saved") {
		t.Fatal(err)
	}
	before := enrollmentSnapshot(t, dir)
	for _, bad := range []EnrollmentOptions{
		{Recover: true, Token: "different-token"},
		{Recover: true, Token: options.Token, CAFile: optionPointer(filepath.Join(dir, "missing-ca"))},
		{Recover: true, Token: options.Token, Name: "other-name"},
	} {
		if EnrollWithOptions(context.Background(), dir, bad) == nil || !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) {
			t.Fatal("refused recovery changed staged intent or parent state")
		}
	}
	if err = EnrollWithOptions(context.Background(), dir, options); err != nil {
		t.Fatal(err)
	}
	current, _, _ := ReadIdentity(dir)
	state, _ := LoadState(dir)
	saved, _ := LoadSettings(dir)
	if calls != 2 || current.DeviceID != "new-device" || state.DeviceID != "new-device" || state.HighestGeneration != 0 || state.LastGoodSHA256 != "retained-workload" || !LocalPaused(dir) || saved.CAFile != caPath || saved.Name != s.Name {
		t.Fatal("authorized recovery did not commit replacement while retaining local settings/workload")
	}
	if _, err = os.Stat(filepath.Join(dir, "pending-recovery")); !os.IsNotExist(err) {
		t.Fatal("committed recovery not cleaned")
	}
}

func TestEnrollmentMachineNamesMatchServerWithoutRewritingSpelling(t *testing.T) {
	for _, name := range []string{" Mixed-Case.Name ", strings.Repeat("a", 100), "0-x_y.z"} {
		s, token, err := enrollmentInput(Settings{Server: "https://127.0.0.1:9", Name: name}, " synthetic ")
		if err != nil || s.Name != name || token != "synthetic" {
			t.Fatal("valid spelling was rejected or rewritten", err)
		}
	}
	for _, name := range []string{" ", "-leading", ".leading", "café", "embedded space", strings.Repeat("a", 101)} {
		if _, _, err := enrollmentInput(Settings{Server: "https://127.0.0.1:9", Name: name}, "synthetic"); err == nil {
			t.Fatal("name guaranteed to fail the server was accepted")
		}
	}
}

func TestEnrollmentOriginPreflightRejectsEmptyHostAndInvalidPort(t *testing.T) {
	for _, origin := range []string{"https://:8443", "https://127.0.0.1:0", "https://127.0.0.1:65536", "https://host.invalid:bad"} {
		dir, _ := enrollmentOptionsFixture(t)
		before := enrollmentSnapshot(t, dir)
		if err := EnrollWithOptions(context.Background(), dir, EnrollmentOptions{Server: origin, Name: "synthetic", Token: "synthetic", CAFile: optionPointer("")}); err == nil {
			t.Fatal("invalid origin accepted")
		}
		if !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) {
			t.Fatal("invalid origin changed local intent")
		}
	}
	for _, origin := range []string{"https://host.invalid", "https://host.invalid:443", "https://[::1]:65535", "127.0.0.1:1"} {
		if _, err := NormalizeServer(origin); err != nil {
			t.Fatal("legal HTTPS origin rejected", err)
		}
	}
}
