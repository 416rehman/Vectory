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
