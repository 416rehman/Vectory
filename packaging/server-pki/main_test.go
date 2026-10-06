package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRenewalRetainsIssuerKeyAndAuthenticatesHostname(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if err := maintain(dir, "vectory.example.com", now); err != nil {
		t.Fatal(err)
	}
	ca, _ := os.ReadFile(filepath.Join(dir, "issuer", "agent-ca.pem"))
	key, _ := os.ReadFile(filepath.Join(dir, "server_key"))
	initial, _ := os.ReadFile(filepath.Join(dir, "server_cert"))
	if err := maintain(dir, "vectory.example.com", now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	retained, _ := os.ReadFile(filepath.Join(dir, "server_cert"))
	if !bytes.Equal(initial, retained) {
		t.Fatal("unnecessary rewrite")
	}
	if err := maintain(dir, "vectory.example.com", now.Add(61*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	renewed, _ := os.ReadFile(filepath.Join(dir, "server_cert"))
	renewedKey, _ := os.ReadFile(filepath.Join(dir, "server_key"))
	renewedCA, _ := os.ReadFile(filepath.Join(dir, "issuer", "agent-ca.pem"))
	if bytes.Equal(initial, renewed) || !bytes.Equal(key, renewedKey) || !bytes.Equal(ca, renewedCA) {
		t.Fatal("renewal replaced trust or failed to renew")
	}
	pair, err := tls.X509KeyPair(renewed, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(pair.Certificate[0])
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "vectory.example.com", CurrentTime: now.Add(61 * 24 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"issuer/agent-ca.pem", "issuer/agent-ca-key.pem", "server_key", "server_cert"} {
		info, _ := os.Stat(filepath.Join(dir, name))
		if info.Mode().Perm() != 0400 {
			t.Fatal("private material permission", name, info.Mode())
		}
	}
}

func TestWrongHostnameAndPartialIssuerPreserveMaterial(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if err := maintain(dir, "vectory.example.com", now); err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(filepath.Join(dir, "server_cert"))
	if maintain(dir, "other.example.com", now) == nil {
		t.Fatal("silently changed hostname")
	}
	current, _ := os.ReadFile(filepath.Join(dir, "server_cert"))
	if !bytes.Equal(old, current) {
		t.Fatal("refusal changed material")
	}
	if err := os.Remove(filepath.Join(dir, "issuer", "agent-ca.pem")); err != nil {
		t.Fatal(err)
	}
	if maintain(dir, "vectory.example.com", now) == nil {
		t.Fatal("replaced partial issuer")
	}
}

func TestNonregularAndOversizedMaterialRefused(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "issuer"), 0700)
	os.WriteFile(filepath.Join(dir, "issuer", "agent-ca.pem"), bytes.Repeat([]byte("x"), maxPEM+1), 0600)
	if maintain(dir, "vectory.example.com", time.Now()) == nil {
		t.Fatal("oversized material accepted")
	}
	if maintain(dir, "https://vectory.example.com", time.Now()) == nil {
		t.Fatal("URL accepted as hostname")
	}
}
