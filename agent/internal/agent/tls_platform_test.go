package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"
)

// macOS's platform verifier reports some untrusted chains with its own
// errors ("... is not standards compliant") instead of an unknown-authority
// error. Classification judges the presented chain itself, so every OS gives
// the same explanation.
func TestCertificateClassificationDoesNotDependOnThePlatformVerifier(t *testing.T) {
	ca := makeCA(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	block, _ := pem.Decode([]byte(ca.issue(t, &key.PublicKey, "localhost", true, time.Now().Add(time.Hour))))
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	platform := errors.New("x509: “localhost” certificate is not standards compliant")
	target, _ := url.Parse("https://127.0.0.1:8443")
	if got := classifyCertificate(target, platform, []*x509.Certificate{leaf, ca.cert}); got.Code != "TLS_UNKNOWN_AUTHORITY" {
		t.Fatalf("sound chain from an untrusted CA: %+v", got)
	}
	elsewhere, _ := url.Parse("https://vectory.example.test:8443")
	if got := classifyCertificate(elsewhere, platform, []*x509.Certificate{leaf, ca.cert}); got.Code != "TLS_HOSTNAME_MISMATCH" {
		t.Fatalf("wrong host name: %+v", got)
	}
	if got := classifyCertificate(target, platform, nil); got.Code != "TLS_VERIFICATION_FAILED" {
		t.Fatalf("no chain observed: %+v", got)
	}
}

// The pin probe never consults this host's roots: even a server this host
// already trusts must match the pin, and nothing is sent.
func TestProbePinnedCAIgnoresThisHostsTrust(t *testing.T) {
	ca := makeCA(t)
	caFile := privateTempDir(t) + string(os.PathSeparator) + "ca.pem"
	if err := AtomicWrite(caFile, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	var requests int
	server := chainServer(t, ca, nil, false, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	t.Setenv("SSL_CERT_FILE", caFile)
	pin, _ := hex.DecodeString(fingerprint(ca.cert))
	if got, err := ProbePinnedCA(context.Background(), server.URL, pin); err != nil || fingerprint(got) != fingerprint(ca.cert) {
		t.Fatal("pinned CA refused", err)
	}
	other := makeCA(t)
	wrong, _ := hex.DecodeString(fingerprint(other.cert))
	if _, err := ProbePinnedCA(context.Background(), server.URL, wrong); err == nil {
		t.Fatal("a server trusted by this host passed a different pin")
	} else if ce, ok := AsConnectionError(err); !ok || ce.Code != "TLS_PIN_MISMATCH" {
		t.Fatalf("misclassified: %v", err)
	}
	if requests != 0 {
		t.Fatal("the probe sent a request")
	}
}
