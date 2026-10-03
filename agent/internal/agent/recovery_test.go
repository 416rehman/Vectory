package agent

import (
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
	"testing"
	"time"
)

func TestReplacementIdentityResetsCountersOnlyAfterAuthorizedCommit(t *testing.T) {
	for _, committed := range []bool{false, true} {
		name := "prepared"
		if committed {
			name = "committed"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			st := State{DeviceID: "old", HighestGeneration: 100, HighestPolicyGeneration: 200, ReportedGeneration: 99, LastGoodSHA256: "good", ApplyState: "verified_applied", Accepted: true}
			if err := SaveState(dir, st); err != nil {
				t.Fatal(err)
			}
			if err := SetPause(dir, true); err != nil {
				t.Fatal(err)
			}
			if err := WriteJSON(filepath.Join(dir, "recovery-commit.json"), identityTransition{OldDeviceID: "old", NewDeviceID: "replacement"}); err != nil {
				t.Fatal(err)
			}
			if err := WriteJSON(filepath.Join(dir, "journal.json"), Journal{Generation: 100}); err != nil {
				t.Fatal(err)
			}
			id := "old"
			if committed {
				id = "replacement"
			}
			got, err := recoverIdentityTransition(dir, Credentials{DeviceID: id}, st)
			if err != nil {
				t.Fatal(err)
			}
			if committed {
				if got.HighestGeneration != 0 || got.HighestPolicyGeneration != 0 || got.Accepted || got.DeviceID != "replacement" || got.LastGoodSHA256 != "good" {
					t.Fatal("replacement reset lost local workload or retained old remote authority")
				}
				if _, err = os.Stat(filepath.Join(dir, "journal.json")); !os.IsNotExist(err) {
					t.Fatal("old transaction survived replacement identity")
				}
			} else if got.HighestGeneration != 100 {
				t.Fatal("uncommitted replacement reset generation")
			}
			if !LocalPaused(dir) {
				t.Fatal("recovery erased local emergency pause")
			}
		})
	}
}
func TestIdentityMismatchCannotResetAntiRollback(t *testing.T) {
	dir := t.TempDir()
	st := State{DeviceID: "old", HighestGeneration: 100}
	if _, err := recoverIdentityTransition(dir, Credentials{DeviceID: "different"}, st); err == nil {
		t.Fatal("identity mismatch silently reset rollback defense")
	}
}
func TestRecoveryAfterCommittedButUncleanedPreviousTransaction(t *testing.T) {
	for _, second := range []bool{false, true} {
		name := "retry_previous"
		if second {
			name = "new_recovery"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			ca := makeCA(t)
			key, csr, err := EnsureKey(dir)
			if err != nil {
				t.Fatal(err)
			}
			block, _ := pem.Decode([]byte(csr))
			request, _ := x509.ParseCertificateRequest(block.Bytes)
			pub, _, _ := ed25519.GenerateKey(rand.Reader)
			expiry := time.Now().Add(time.Hour).Truncate(time.Second)
			current := Credentials{DeviceID: "device-2", CertificatePEM: ca.issue(t, request.PublicKey, "device-2", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry}
			if err = StoreIdentity(dir, current, key); err != nil {
				t.Fatal(err)
			}
			if err = SaveState(dir, State{DeviceID: "device-2", HighestGeneration: 33, LastGoodSHA256: "retained"}); err != nil {
				t.Fatal(err)
			}
			if err = SetPause(dir, true); err != nil {
				t.Fatal(err)
			}
			pending := filepath.Join(dir, "pending-recovery")
			if err = PrivateDir(pending); err != nil {
				t.Fatal(err)
			}
			if err = StoreIdentity(pending, current, key); err != nil {
				t.Fatal(err)
			}
			if err = WriteJSON(filepath.Join(pending, "origin.json"), pendingRecovery{OldDeviceID: "device-1", NewDeviceID: "device-2", TokenSHA256: Digest([]byte("old-token"))}); err != nil {
				t.Fatal(err)
			}
			calls := 0
			srv := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var enrollment Enrollment
				if json.NewDecoder(r.Body).Decode(&enrollment) != nil || enrollment.Token != "new-token" {
					http.Error(w, "denied", 403)
					return
				}
				block, _ := pem.Decode([]byte(enrollment.CSRPEM))
				csr, err := x509.ParseCertificateRequest(block.Bytes)
				if err != nil || csr.CheckSignature() != nil {
					http.Error(w, "bad", 400)
					return
				}
				next := Credentials{DeviceID: "device-3", CertificatePEM: ca.issue(t, csr.PublicKey, "device-3", false, expiry), CAPEM: ca.pem, SigningPublicKey: current.SigningPublicKey, CertificateExpiresAt: expiry}
				_ = json.NewEncoder(w).Encode(next)
			}))
			caFile := filepath.Join(dir, "ca.pem")
			if err = AtomicWrite(caFile, []byte(ca.pem)); err != nil {
				t.Fatal(err)
			}
			settings := Settings{Server: srv.URL, CAFile: caFile, Name: "recovered-host"}
			token := "old-token"
			if second {
				token = "new-token"
			}
			if err = RecoverEnrollment(context.Background(), dir, settings, token); err != nil {
				t.Fatal(err)
			}
			got, _, err := ReadIdentity(dir)
			if err != nil {
				t.Fatal(err)
			}
			st, err := LoadState(dir)
			if err != nil {
				t.Fatal(err)
			}
			wantID, wantCalls := "device-2", 0
			if second {
				wantID = "device-3"
				wantCalls = 1
				if st.HighestGeneration != 0 {
					t.Fatal("new replacement did not reset counters")
				}
			} else if st.HighestGeneration != 33 {
				t.Fatal("cleanup retry reset already active counters")
			}
			if got.DeviceID != wantID || calls != wantCalls || st.LastGoodSHA256 != "retained" || !LocalPaused(dir) {
				t.Fatal("inconsistent recovery result")
			}
			if _, err = os.Stat(pending); !os.IsNotExist(err) {
				t.Fatal("pending recovery not cleaned")
			}
		})
	}
}

// recoveryHost is an enrolled state directory whose settings point at a
// synthetic server that issues replacement identities.
type recoveryHost struct {
	dir     string
	ca      testCA
	expiry  time.Time
	signing string
}

func newRecoveryHost(t *testing.T) *recoveryHost {
	t.Helper()
	dir, _ := enrollmentOptionsFixture(t)
	ca := makeCA(t)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	key, csrPEM, err := EnsureKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(csrPEM))
	csr, _ := x509.ParseCertificateRequest(block.Bytes)
	expiry := time.Now().Add(time.Hour).Truncate(time.Second)
	signing := base64.StdEncoding.EncodeToString(pub)
	old := Credentials{DeviceID: "old-device", CertificatePEM: ca.issue(t, csr.PublicKey, "old-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: signing, CertificateExpiresAt: expiry}
	if err = StoreIdentity(dir, old, key); err != nil {
		t.Fatal(err)
	}
	if err = SaveState(dir, State{DeviceID: old.DeviceID, HighestGeneration: 99, LastGoodSHA256: "retained-workload", ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60}}); err != nil {
		t.Fatal(err)
	}
	return &recoveryHost{dir: dir, ca: ca, expiry: expiry, signing: signing}
}

// serve starts the synthetic server and points the saved settings at it.
func (h *recoveryHost) serve(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	server := trustedServer(t, h.ca, handler)
	caPath := filepath.Join(h.dir, "trusted-ca.pem")
	if err := AtomicWrite(caPath, []byte(h.ca.pem)); err != nil {
		t.Fatal(err)
	}
	fields := maintenanceFields(t, filepath.Join(h.dir, "settings.json"))
	fields["server"], _ = json.Marshal(server.URL)
	fields["ca_file"], _ = json.Marshal(caPath)
	raw, _ := json.Marshal(fields)
	if err := os.WriteFile(filepath.Join(h.dir, "settings.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func (h *recoveryHost) issue(t *testing.T, request Enrollment, id string) Credentials {
	t.Helper()
	block, _ := pem.Decode([]byte(request.CSRPEM))
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		t.Error(err)
		return Credentials{}
	}
	return Credentials{DeviceID: id, CertificatePEM: h.ca.issue(t, csr.PublicKey, id, false, h.expiry), CAPEM: h.ca.pem, SigningPublicKey: h.signing, CertificateExpiresAt: h.expiry}
}

func (h *recoveryHost) recover(ctx context.Context, token string) error {
	return EnrollWithOptions(ctx, h.dir, EnrollmentOptions{Recover: true, Token: token})
}

func (h *recoveryHost) recovered(t *testing.T, id string) {
	t.Helper()
	current, _, err := ReadIdentity(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	state, err := LoadState(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	if current.DeviceID != id || state.DeviceID != id || state.HighestGeneration != 0 || state.LastGoodSHA256 != "retained-workload" {
		t.Fatal("recovery did not commit the replacement identity while keeping the workload")
	}
	if _, err = os.Stat(filepath.Join(h.dir, "pending-recovery")); !os.IsNotExist(err) {
		t.Fatal("committed recovery left its pending request behind")
	}
}

func TestRecoveryTakesANewTokenAfterTheServerRefusedTheFirst(t *testing.T) {
	h := newRecoveryHost(t)
	var tokens, requestIDs []string
	h.serve(t, func(w http.ResponseWriter, r *http.Request) {
		var request Enrollment
		_ = json.NewDecoder(r.Body).Decode(&request)
		tokens = append(tokens, request.Token)
		requestIDs = append(requestIDs, request.RequestID)
		if request.Token != "valid-recovery-token" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"ENROLLMENT_FAILED","message":"Enrollment failed"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(h.issue(t, request, "new-device"))
	})
	// An expired, revoked or mistyped token, then another, then the first again:
	// the refusal is definitive each time, so none of them pins the next.
	for _, refused := range []string{"expired-recovery-token", "mistyped-recovery-token", "expired-recovery-token"} {
		err := h.recover(context.Background(), refused)
		if ce, ok := AsConnectionError(err); !ok || ce.Code != "ENROLLMENT_REFUSED" || !strings.Contains(err.Error(), "A new token is fine") {
			t.Fatalf("a refused token did not report the refusal: %v", err)
		}
	}
	if err := h.recover(context.Background(), "valid-recovery-token"); err != nil {
		t.Fatal(err)
	}
	h.recovered(t, "new-device")
	seen := map[string]bool{}
	for _, id := range requestIDs {
		seen[id] = true
	}
	if len(tokens) != 4 || len(seen) != 4 {
		t.Fatal("each token should have started its own request", tokens, requestIDs)
	}
}

func TestRecoveryApiTakesANewTokenAfterTheServerRefusedTheFirst(t *testing.T) {
	h := newRecoveryHost(t)
	h.serve(t, func(w http.ResponseWriter, r *http.Request) {
		var request Enrollment
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.Token != "valid-recovery-token" {
			http.Error(w, "refused", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(h.issue(t, request, "new-device"))
	})
	settings, err := LoadSettings(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = RecoverEnrollment(context.Background(), h.dir, settings, "mistyped-recovery-token"); err == nil {
		t.Fatal("a refused token recovered the device")
	}
	if err = RecoverEnrollment(context.Background(), h.dir, settings, "valid-recovery-token"); err != nil {
		t.Fatal(err)
	}
	h.recovered(t, "new-device")
}

func TestRecoveryAfterAnUnsentRequestTakesANewToken(t *testing.T) {
	h := newRecoveryHost(t)
	var calls int
	h.serve(t, func(w http.ResponseWriter, r *http.Request) {
		var request Enrollment
		_ = json.NewDecoder(r.Body).Decode(&request)
		calls++
		_ = json.NewEncoder(w).Encode(h.issue(t, request, "new-device"))
	})
	// The server's certificate isn't trusted, so the token never leaves this host.
	trusted := filepath.Join(h.dir, "trusted-ca.pem")
	untrusted := filepath.Join(h.dir, "other-ca.pem")
	if err := AtomicWrite(untrusted, []byte(makeCA(t).pem)); err != nil {
		t.Fatal(err)
	}
	err := EnrollWithOptions(context.Background(), h.dir, EnrollmentOptions{Recover: true, Token: "first-token", CAFile: &untrusted})
	if ce, ok := AsConnectionError(err); !ok || ce.Delivery != NotSent || calls != 0 {
		t.Fatal("expected a failure before anything was sent", err)
	}
	if err = EnrollWithOptions(context.Background(), h.dir, EnrollmentOptions{Recover: true, Token: "second-token", CAFile: &trusted}); err != nil {
		t.Fatal(err)
	}
	h.recovered(t, "new-device")
}

func TestRecoveryAfterALostReplyStillRequiresTheOriginalToken(t *testing.T) {
	for _, lost := range []string{"dropped connection", "interrupted while waiting", "server error"} {
		t.Run(lost, func(t *testing.T) {
			h := newRecoveryHost(t)
			var calls int
			var first Enrollment
			arrived := make(chan struct{}, 1)
			h.serve(t, func(w http.ResponseWriter, r *http.Request) {
				var request Enrollment
				_ = json.NewDecoder(r.Body).Decode(&request)
				calls++
				if calls > 1 {
					if request.RequestID != first.RequestID || request.Token != first.Token {
						t.Error("the retry was not the original request")
					}
					_ = json.NewEncoder(w).Encode(h.issue(t, request, "new-device"))
					return
				}
				first = request
				switch lost {
				case "dropped connection":
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = connection.Close()
				case "interrupted while waiting":
					arrived <- struct{}{}
					select {
					case <-r.Context().Done():
					case <-time.After(10 * time.Second):
					}
				default:
					http.Error(w, "unexpected", http.StatusInternalServerError)
				}
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if lost == "interrupted while waiting" {
				go func() {
					<-arrived
					cancel()
				}()
			}
			if err := h.recover(ctx, "original-token"); err == nil || !strings.Contains(err.Error(), "same token") {
				t.Fatalf("a lost reply should say to use the same token: %v", err)
			}
			before := enrollmentSnapshot(t, h.dir)
			if err := h.recover(context.Background(), "another-token"); err == nil || !strings.Contains(err.Error(), "original token") || calls != 1 {
				t.Fatalf("another token was accepted while the first request may have been delivered: %v", err)
			}
			if !reflect.DeepEqual(before, enrollmentSnapshot(t, h.dir)) {
				t.Fatal("the refused token changed the pending request")
			}
			if err := h.recover(context.Background(), "original-token"); err != nil {
				t.Fatal(err)
			}
			if calls != 2 {
				t.Fatal("the original token did not finish the original request")
			}
			h.recovered(t, "new-device")
		})
	}
}
