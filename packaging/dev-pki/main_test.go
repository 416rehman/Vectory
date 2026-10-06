package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func certificateFixture(t *testing.T, expiration time.Time) (string, string) {
	return certificateFixtureWithPurpose(t, expiration, false, x509.ExtKeyUsageServerAuth)
}

func certificateFixtureWithPurpose(t *testing.T, expiration time.Time, ca bool, usage x509.ExtKeyUsage) (string, string) {
	t.Helper()
	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"vectory.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: expiration, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage}, IsCA: ca, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certFile, keyFile := filepath.Join(dir, "server.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), 0600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}

func TestServerCertificateChecksNameValidityAndKeyPair(t *testing.T) {
	cert, key := certificateFixture(t, time.Now().Add(24*time.Hour))
	if err := checkServer(cert, key, "vectory.example.com"); err != nil {
		t.Fatal(err)
	}
	if err := checkServer(cert, key, "other.example.com"); err == nil {
		t.Fatal("accepted wrong server name")
	}
	_, otherKey := certificateFixture(t, time.Now().Add(24*time.Hour))
	if err := checkServer(cert, otherKey, "vectory.example.com"); err == nil {
		t.Fatal("accepted mismatched key")
	}
	expiring, expiringKey := certificateFixture(t, time.Now().Add(30*time.Minute))
	if err := checkServer(expiring, expiringKey, "vectory.example.com"); err == nil {
		t.Fatal("accepted expiring certificate")
	}
}

func TestBootstrapIsPrivateAndCannotBeReplaced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap")
	if err := writeBootstrap(path); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil || len(before) != 65 {
		t.Fatal("bootstrap secret was not generated")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("bootstrap secret is not private")
		}
	}
	if err := writeBootstrap(path); err == nil {
		t.Fatal("replaced retained bootstrap secret")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatal("bootstrap secret changed after refused replacement")
	}
}

func TestServerCertificateRefusesIssuerCAAndClientOnlyPurpose(t *testing.T) {
	ca, caKey := certificateFixtureWithPurpose(t, time.Now().Add(24*time.Hour), true, x509.ExtKeyUsageServerAuth)
	if err := checkServer(ca, caKey, "vectory.example.com"); err == nil {
		t.Fatal("accepted the issuing CA as the server identity")
	}
	client, clientKey := certificateFixtureWithPurpose(t, time.Now().Add(24*time.Hour), false, x509.ExtKeyUsageClientAuth)
	if err := checkServer(client, clientKey, "vectory.example.com"); err == nil {
		t.Fatal("accepted client-only certificate for a TLS server")
	}
}
