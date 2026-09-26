package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string
}

func makeCA(t *testing.T) testCA {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test device CA"}, NotBefore: time.Now().Add(-72 * time.Hour).Truncate(time.Second), NotAfter: time.Now().Add(365 * 24 * time.Hour).Truncate(time.Second), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	cert, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	return testCA{cert, key, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}
func (c testCA) issue(t *testing.T, pub any, name string, server bool, expires time.Time) string {
	t.Helper()
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-48 * time.Hour).Truncate(time.Second), NotAfter: expires.Truncate(time.Second), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	if server {
		template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
		template.DNSNames = []string{"localhost"}
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	der, e := x509.CreateCertificate(rand.Reader, template, c.cert, pub, c.key)
	if e != nil {
		t.Fatal(e)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}
func privatePEM(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	b, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: b})
}
func trustedServer(t *testing.T, ca testCA, handler http.Handler) *httptest.Server {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pair, e := tls.X509KeyPair([]byte(ca.issue(t, &key.PublicKey, "localhost", true, time.Now().Add(time.Hour))), privatePEM(t, key))
	if e != nil {
		t.Fatal(e)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(ca.pem))
	s := httptest.NewUnstartedServer(handler)
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS13, ClientAuth: tls.RequestClientCert, ClientCAs: pool}
	s.StartTLS()
	t.Cleanup(s.Close)
	return s
}
func TestTLSWrongCAAndRedirectRejected(t *testing.T) {
	ca := makeCA(t)
	hits := 0
	s := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "https://example.invalid/steal", 302)
	}))
	dir := t.TempDir()
	caFile := filepath.Join(dir, "ca.pem")
	if e := AtomicWrite(caFile, []byte(ca.pem)); e != nil {
		t.Fatal(e)
	}
	untrusted, e := NewClient(Settings{Server: s.URL}, nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer untrusted.Close()
	if _, e = untrusted.request(context.Background(), "POST", "/agent/v1/enroll", map[string]string{"token": "must-not-leak"}); e == nil {
		t.Fatal("unknown CA accepted")
	}
	if hits != 0 {
		t.Fatal("token was sent without server trust")
	}
	trusted, e := NewClient(Settings{Server: s.URL, CAFile: caFile}, nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer trusted.Close()
	if _, e = trusted.request(context.Background(), "GET", "/agent/v1/artifacts/hash", nil); e == nil {
		t.Fatal("redirect followed")
	}
	if hits != 1 {
		t.Fatal("unexpected request count")
	}
	if trusted.HTTP.Transport.(*http.Transport).TLSClientConfig.MinVersion != tls.VersionTLS13 {
		t.Fatal("TLS downgraded")
	}
}
func TestEnrollmentLostResponseIdempotentAndMTLS(t *testing.T) {
	dir := t.TempDir()
	ca := makeCA(t)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	var mu sync.Mutex
	var first Enrollment
	var cred Credentials
	calls := 0
	authorized := 0
	s := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/agent/v1/enroll":
			var req Enrollment
			if json.NewDecoder(r.Body).Decode(&req) != nil {
				http.Error(w, "bad", 400)
				return
			}
			calls++
			block, _ := pem.Decode([]byte(req.CSRPEM))
			csr, e := x509.ParseCertificateRequest(block.Bytes)
			if e != nil || csr.CheckSignature() != nil {
				http.Error(w, "bad", 400)
				return
			}
			if calls == 1 {
				first = req
				expiry := time.Now().Add(48 * time.Hour).Truncate(time.Second)
				cred = Credentials{DeviceID: "device-uuid", CertificatePEM: ca.issue(t, csr.PublicKey, "device-uuid", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry}
				http.Error(w, "response lost", 500)
				return
			}
			if req.RequestID != first.RequestID || req.Name != first.Name || req.Token != first.Token {
				http.Error(w, "mismatch", 403)
				return
			}
			b1, _ := pem.Decode([]byte(first.CSRPEM))
			original, _ := x509.ParseCertificateRequest(b1.Bytes)
			if !SamePublicKey(original.PublicKey, csr.PublicKey) {
				http.Error(w, "key mismatch", 403)
				return
			}
			_ = json.NewEncoder(w).Encode(cred)
		case "/agent/v1/heartbeat":
			if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || r.TLS.PeerCertificates[0].Subject.CommonName != "device-uuid" {
				http.Error(w, "unauthenticated", 401)
				return
			}
			authorized++
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	caFile := filepath.Join(dir, "server-ca.pem")
	if e := AtomicWrite(caFile, []byte(ca.pem)); e != nil {
		t.Fatal(e)
	}
	settings := Settings{Server: s.URL, CAFile: caFile, Name: "unique-node"}
	if e := Enroll(context.Background(), dir, settings, "secret-token"); e == nil {
		t.Fatal("lost response unexpectedly succeeded")
	}
	keyBefore, e := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	if e != nil {
		t.Fatal(e)
	}
	if e = Enroll(context.Background(), dir, settings, "secret-token"); e != nil {
		t.Fatal(e)
	}
	keyAfter, e := os.ReadFile(filepath.Join(dir, "private-key.pem"))
	if e != nil || string(keyBefore) != string(keyAfter) {
		t.Fatal("retry changed identity")
	}
	var stored Credentials
	if e = ReadJSON(filepath.Join(dir, "credentials.json"), &stored); e != nil {
		t.Fatal(e)
	}
	client, e := NewClient(settings, &stored, keyAfter)
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	if _, e = client.request(context.Background(), "POST", "/agent/v1/heartbeat", map[string]int{"protocol_version": 1}); e != nil {
		t.Fatal(e)
	}
	if authorized != 1 {
		t.Fatal("mTLS identity not recognized")
	}
	files, e := os.ReadDir(dir)
	if e != nil {
		t.Fatal(e)
	}
	for _, f := range files {
		b, _ := os.ReadFile(filepath.Join(dir, f.Name()))
		if contains(b, []byte("secret-token")) {
			t.Fatalf("token leaked to %s", f.Name())
		}
	}
}
func contains(b, v []byte) bool {
	for i := 0; i+len(v) <= len(b); i++ {
		if string(b[i:i+len(v)]) == string(v) {
			return true
		}
	}
	return false
}
func TestExpiredOfflineCredentialsStillOpenLocalRecovery(t *testing.T) {
	dir := t.TempDir()
	ca := makeCA(t)
	key, csr, e := EnsureKey(dir)
	if e != nil {
		t.Fatal(e)
	}
	block, _ := pem.Decode([]byte(csr))
	req, e := x509.ParseCertificateRequest(block.Bytes)
	if e != nil {
		t.Fatal(e)
	}
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	expiry := time.Now().Add(-time.Hour).Truncate(time.Second)
	cred := Credentials{DeviceID: "expired-device", CertificatePEM: ca.issue(t, req.PublicKey, "expired-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry}
	if e = validateCredentials(cred, key, cred.DeviceID); e == nil {
		t.Fatal("expired certificate validated for enrollment")
	}
	if e = WriteJSON(filepath.Join(dir, "credentials.json"), cred); e != nil {
		t.Fatal(e)
	}
	if e = WriteJSON(filepath.Join(dir, "settings.json"), Settings{Server: "https://localhost:1"}); e != nil {
		t.Fatal(e)
	}
	engine, e := OpenEngine(dir)
	if e != nil {
		t.Fatal("expired credentials prevented local recovery", e)
	}
	engine.Client.Close()
}
func TestRenewalRotatesKeyAndSigningTrustAtomically(t *testing.T) {
	dir := t.TempDir()
	ca := makeCA(t)
	key, csr, err := EnsureKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(csr))
	original, _ := x509.ParseCertificateRequest(block.Bytes)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	rotatedPub, _, _ := ed25519.GenerateKey(rand.Reader)
	expiry := time.Now().Add(time.Hour).Truncate(time.Second)
	cred := Credentials{DeviceID: "rotation-device", CertificatePEM: ca.issue(t, original.PublicKey, "rotation-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry}
	if err = StoreIdentity(dir, cred, key); err != nil {
		t.Fatal(err)
	}
	requests := 0
	s := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/renew" || r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || r.TLS.PeerCertificates[0].Subject.CommonName != "rotation-device" {
			http.Error(w, "denied", 403)
			return
		}
		requests++
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "bad", 400)
			return
		}
		block, _ := pem.Decode([]byte(body["csr_pem"]))
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil {
			http.Error(w, "bad", 400)
			return
		}
		if SamePublicKey(csr.PublicKey, original.PublicKey) {
			t.Error("renewal reused old private key")
		}
		expires := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
		next := Credentials{DeviceID: "rotation-device", CertificatePEM: ca.issue(t, csr.PublicKey, "rotation-device", false, expires), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(rotatedPub), CertificateExpiresAt: expires}
		_ = json.NewEncoder(w).Encode(next)
	}))
	caFile := filepath.Join(dir, "ca.pem")
	if err = AtomicWrite(caFile, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	settings := Settings{Server: s.URL, CAFile: caFile}
	if err = WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	e, err := OpenEngine(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { e.Client.Close() }()
	if err = e.renew(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, newKey, err := ReadIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if string(newKey) == string(key) || stored.SigningPublicKey != base64.StdEncoding.EncodeToString(rotatedPub) || requests != 1 {
		t.Fatal("rotation did not commit")
	}
	if err = validateCredentials(stored, newKey, "rotation-device"); err != nil {
		t.Fatal(err)
	}
	// Torn obsolete mirrors must not defeat the canonical identity commit.
	if err = AtomicWrite(filepath.Join(dir, "private-key.pem"), key); err != nil {
		t.Fatal(err)
	}
	if err = WriteJSON(filepath.Join(dir, "credentials.json"), cred); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenEngine(dir)
	if err != nil {
		t.Fatal("identity bundle did not survive torn mirrors", err)
	}
	reopened.Client.Close()
	if reopened.Credentials.SigningPublicKey != stored.SigningPublicKey {
		t.Fatal("stale mirror restored old signing trust")
	}
}
func TestRejectedSigningKeyTriggersOnlyBoundedAuthenticatedRefresh(t *testing.T) {
	dir := t.TempDir()
	oldPub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, newPrivate, _ := ed25519.GenerateKey(rand.Reader)
	renewals := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent/v1/renew" {
			renewals++
			http.Error(w, "unavailable", 503)
			return
		}
		var h Heartbeat
		if json.NewDecoder(r.Body).Decode(&h) != nil {
			http.Error(w, "bad", 400)
			return
		}
		m := sampleManifest()
		m.DeviceID = "device"
		m.Nonce = h.Nonce
		m.Desired = nil
		_ = json.NewEncoder(w).Encode(signed(t, m, newPrivate))
	}))
	defer srv.Close()
	e := &Engine{Dir: dir, Settings: Settings{ManagedConfig: filepath.Join(dir, "managed.json")}, Credentials: Credentials{DeviceID: "device", SigningPublicKey: base64.StdEncoding.EncodeToString(oldPub)}, State: State{DeviceID: "device", Policy: Policy{HeartbeatSeconds: 60}}, Client: &Client{HTTP: srv.Client(), Base: srv.URL}, Driver: &fakeDriver{}}
	for i := 0; i < 2; i++ {
		if err := e.Poll(context.Background()); !errors.Is(err, ErrManifestSignature) {
			t.Fatal("untrusted manifest did not remain rejected", err)
		}
	}
	if renewals != 1 || e.State.HighestGeneration != 0 || e.State.Accepted {
		t.Fatal("signature failure changed state or retried renewal without cooldown")
	}
	durable, err := LoadState(dir)
	if err != nil || durable.LastSigningRefresh == nil {
		t.Fatal("signing-refresh cooldown not durable")
	}
}
