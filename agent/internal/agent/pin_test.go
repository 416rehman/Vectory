package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// chainServer serves TLS 1.3 with a leaf issued by ca for the given names and
// presents [leaf, ca] unless leafOnly is set.
func chainServer(t *testing.T, ca testCA, names []string, leafOnly bool, handler http.Handler) *httptest.Server {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafPEM := ca.issue(t, &key.PublicKey, "localhost", true, time.Now().Add(time.Hour))
	if len(names) > 0 {
		template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: names, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
		der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &key.PublicKey, ca.key)
		if err != nil {
			t.Fatal(err)
		}
		leafPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	}
	block, _ := pem.Decode([]byte(leafPEM))
	certificate := tls.Certificate{Certificate: [][]byte{block.Bytes}, PrivateKey: key}
	if !leafOnly {
		certificate.Certificate = append(certificate.Certificate, ca.cert.Raw)
	}
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13, ClientAuth: tls.RequestClientCert}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func fingerprint(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

func TestParseCAFingerprintAcceptsDashboardFormats(t *testing.T) {
	sum := sha256.Sum256([]byte("synthetic"))
	plain := hex.EncodeToString(sum[:])
	for _, value := range []string{plain, strings.ToUpper(plain), Fingerprint(sum[:]), " " + Fingerprint(sum[:]) + " ", "sha256:" + plain} {
		got, err := ParseCAFingerprint(value)
		if err != nil || hex.EncodeToString(got) != plain {
			t.Fatalf("%q: %v", value, err)
		}
	}
	for _, value := range []string{"", plain[:62], plain + "00", "zz" + plain[2:]} {
		if _, err := ParseCAFingerprint(value); err == nil {
			t.Fatalf("%q accepted", value)
		}
	}
}

func TestProbePinnedCAVerifiesChainHostnameAndSendsNothingSecret(t *testing.T) {
	ca := makeCA(t)
	var requests atomic.Int32
	server := chainServer(t, ca, nil, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
	}))
	pin, _ := hex.DecodeString(fingerprint(ca.cert))
	got, err := ProbePinnedCA(context.Background(), server.URL, pin)
	if err != nil || fingerprint(got) != fingerprint(ca.cert) {
		t.Fatal("pinned CA was not accepted", err)
	}
	// The host didn't trust the CA, so the handshake stopped before any request.
	if requests.Load() != 0 {
		t.Fatal("probe sent a request over an unverified connection")
	}
	wrong := sha256.Sum256([]byte("another CA"))
	_, err = ProbePinnedCA(context.Background(), server.URL, wrong[:])
	if ce, ok := AsConnectionError(err); !ok || ce.Code != "TLS_PIN_MISMATCH" || ce.Delivery != NotSent {
		t.Fatal("wrong pin accepted or misclassified", err)
	}
}

func TestPinMismatchPrintsBothFingerprintsInFullWithTheFirstDifference(t *testing.T) {
	ca := makeCA(t)
	server := chainServer(t, ca, nil, false, http.NotFoundHandler())
	actual, _ := hex.DecodeString(fingerprint(ca.cert))
	// A pin that differs only in byte 16: the short form hid exactly this.
	pin := bytes.Clone(actual)
	pin[15] ^= 0x90
	_, err := ProbePinnedCA(context.Background(), server.URL, pin)
	ce, ok := AsConnectionError(err)
	if !ok || ce.Code != "TLS_PIN_MISMATCH" {
		t.Fatal("mismatch not classified", err)
	}
	lines := strings.Split(ce.Message, "\n")
	want := []string{
		"The server's certificates don't match the pinned CA:",
		"expected " + Fingerprint(pin),
		"received " + Fingerprint(actual) + "  (first difference at byte 16)",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("message:\n%s\nwant:\n%s", ce.Message, strings.Join(want, "\n"))
	}
	if strings.Contains(ce.Message, "...") || !strings.Contains(ce.Fix, "full fingerprint on Add device") {
		t.Fatalf("the comparison must use full fingerprints: %q / %q", ce.Message, ce.Fix)
	}
	// Printed as one error, the fix follows the aligned lines, never the last one.
	if got := ce.Error(); !strings.HasSuffix(got, "byte 16)\n"+ce.Fix) {
		t.Fatalf("error text: %q", got)
	}
	if got := IndentLines("a\nb", 3); got != "a\n   b" {
		t.Fatalf("indent: %q", got)
	}
}

func TestUntrustedCAFixShowsTheFullFingerprintInAddDeviceRows(t *testing.T) {
	ca := makeCA(t)
	leaf := makeCA(t).cert
	e := classifyCertificate(&url.URL{Scheme: "https", Host: "localhost:8443"}, x509.UnknownAuthorityError{Cert: leaf}, []*x509.Certificate{leaf, ca.cert})
	pairs := strings.Split(Fingerprint(certificateSHA256(ca.cert)), ":")
	// Four rows of eight pairs, as Add device shows them: every byte is there
	// to compare, and none of it is a pin to paste.
	rows := []string{}
	for i := 0; i < 32; i += 8 {
		rows = append(rows, "  "+strings.Join(pairs[i:i+8], ":"))
	}
	if e.Code != "TLS_UNKNOWN_AUTHORITY" || !strings.HasSuffix(e.Fix, "row by row:\n"+strings.Join(rows, "\n")) || !strings.Contains(e.Fix, "full fingerprint on Add device") || strings.Contains(e.Fix, "...") {
		t.Fatalf("fix: %q", e.Fix)
	}
}

func TestProbePinnedCARejectsHostnameMismatchAndForeignIssuer(t *testing.T) {
	ca := makeCA(t)
	// The certificate chains to the pinned CA but names another host.
	other := chainServer(t, ca, []string{"elsewhere.example.test"}, false, http.NotFoundHandler())
	pin, _ := hex.DecodeString(fingerprint(ca.cert))
	_, err := ProbePinnedCA(context.Background(), other.URL, pin)
	if ce, ok := AsConnectionError(err); !ok || ce.Code != "TLS_HOSTNAME_MISMATCH" || !strings.Contains(ce.Message, "elsewhere.example.test") {
		t.Fatal("hostname mismatch accepted or misclassified", err)
	}
	// An attacker can present the real (public) CA certificate beside a leaf
	// issued by its own key. Matching the pin alone must not be enough.
	attacker := makeCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	block, _ := pem.Decode([]byte(attacker.issue(t, &key.PublicKey, "localhost", true, time.Now().Add(time.Hour))))
	server := httptest.NewUnstartedServer(http.NotFoundHandler())
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{block.Bytes, ca.cert.Raw}, PrivateKey: key}}, MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	_, err = ProbePinnedCA(context.Background(), server.URL, pin)
	if ce, ok := AsConnectionError(err); !ok || ce.Code != "TLS_PIN_NOT_ISSUER" {
		t.Fatal("presenting the pinned certificate without its key was accepted", err)
	}
}

func TestProbePinnedCAAcceptsPinnedServerCertificate(t *testing.T) {
	ca := makeCA(t)
	server := chainServer(t, ca, nil, true, http.NotFoundHandler())
	leaf := server.TLS.Certificates[0].Certificate[0]
	parsed, _ := x509.ParseCertificate(leaf)
	pin, _ := hex.DecodeString(fingerprint(parsed))
	got, err := ProbePinnedCA(context.Background(), server.URL, pin)
	if err != nil || fingerprint(got) != fingerprint(parsed) {
		t.Fatal("a pinned self-contained server certificate was refused", err)
	}
}

func TestEnrollmentWithPinSavesVerifiedCAAndRejectsMismatchWithoutWrites(t *testing.T) {
	ca := makeCA(t)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	var tokens []string
	server := chainServer(t, ca, nil, false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/enroll" {
			http.NotFound(w, r)
			return
		}
		var request Enrollment
		_ = json.NewDecoder(r.Body).Decode(&request)
		tokens = append(tokens, request.Token)
		block, _ := pem.Decode([]byte(request.CSRPEM))
		csr, _ := x509.ParseCertificateRequest(block.Bytes)
		expiry := time.Now().Add(time.Hour).Truncate(time.Second)
		_ = json.NewEncoder(w).Encode(Credentials{DeviceID: "pinned-device", CertificatePEM: ca.issue(t, csr.PublicKey, "pinned-device", false, expiry), CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(pub), CertificateExpiresAt: expiry})
	}))
	dir, _ := enrollmentOptionsFixture(t)
	wrong := sha256.Sum256([]byte("not the CA"))
	before := enrollmentSnapshot(t, dir)
	err := EnrollWithOptions(context.Background(), dir, EnrollmentOptions{Server: server.URL, Name: "pinned", Token: "synthetic-token", CASHA256: hex.EncodeToString(wrong[:])})
	if ce, ok := AsConnectionError(err); !ok || ce.Code != "TLS_PIN_MISMATCH" || len(tokens) != 0 {
		t.Fatal("mismatched pin was not refused before any token was sent", err)
	}
	if !reflect.DeepEqual(before, enrollmentSnapshot(t, dir)) {
		t.Fatal("refused pin wrote local state")
	}
	if err := EnrollWithOptions(context.Background(), dir, EnrollmentOptions{Server: server.URL, Name: "pinned", Token: "synthetic-token", CASHA256: Fingerprint(certificateSHA256(ca.cert))}); err != nil {
		t.Fatal(err)
	}
	saved, _ := LoadSettings(dir)
	trust, err := os.ReadFile(saved.CAFile)
	if err != nil || saved.CAFile != filepath.Join(dir, ServerCAFile) || !strings.Contains(string(trust), "BEGIN CERTIFICATE") {
		t.Fatal("pinned CA was not saved as the trust file", saved.CAFile, err)
	}
	block, _ := pem.Decode(trust)
	if block == nil || fingerprint(&x509.Certificate{Raw: block.Bytes}) != fingerprint(ca.cert) || len(tokens) != 1 {
		t.Fatal("saved trust is not the pinned certificate")
	}
	// Later connections are ordinary verified TLS with the saved file.
	client, err := NewClient(saved, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.request(context.Background(), "GET", "/other", nil); err == nil {
		t.Fatal("expected a 404 from the synthetic server")
	} else if ce, ok := AsConnectionError(err); !ok || ce.Delivery != Answered {
		t.Fatal("saved trust file did not verify the server", err)
	}
	if err := EnrollWithOptions(context.Background(), dir, EnrollmentOptions{Server: server.URL, Name: "pinned", Token: "x", CASHA256: Fingerprint(certificateSHA256(ca.cert)), CAFile: optionPointer("")}); err == nil || !strings.Contains(err.Error(), "choose one") {
		t.Fatal("conflicting trust options accepted", err)
	}
}
