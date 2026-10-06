// server-pki maintains the private HTTPS issuer for the outbound agent channel.
// Caddy independently manages public browser HTTPS. No host trust is installed.
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxPEM = 65536

func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPEM {
		return nil, fmt.Errorf("certificate material must be a bounded regular file")
	}
	return os.ReadFile(path)
}

func save(path string, data []byte) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("refusing nonregular certificate path")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".certificate-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0400); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func serial() (*big.Int, error) { return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)) }
func private(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func parseKey(data []byte) (*ecdsa.PrivateKey, error) {
	block, rest := pem.Decode(data)
	if block == nil || len(bytes.TrimSpace(rest)) != 0 {
		return nil, fmt.Errorf("invalid private key PEM")
	}
	value, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := value.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("private issuer requires an ECDSA key")
	}
	return key, nil
}

func issuer(dir string, now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, []byte, error) {
	issuerDir := filepath.Join(dir, "issuer")
	issuerInfo, issuerErr := os.Lstat(issuerDir)
	if issuerErr == nil && (!issuerInfo.IsDir() || issuerInfo.Mode()&os.ModeSymlink != 0) {
		return nil, nil, nil, fmt.Errorf("retained issuer must be a regular directory")
	}
	if issuerErr != nil && !os.IsNotExist(issuerErr) {
		return nil, nil, nil, issuerErr
	}
	certPath, keyPath := filepath.Join(issuerDir, "agent-ca.pem"), filepath.Join(issuerDir, "agent-ca-key.pem")
	certPEM, err := readRegular(certPath)
	if err == nil {
		block, rest := pem.Decode(certPEM)
		if block == nil || len(bytes.TrimSpace(rest)) != 0 {
			return nil, nil, nil, fmt.Errorf("invalid retained issuer PEM")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, nil, nil, err
		}
		keyPEM, err := readRegular(keyPath)
		if err != nil {
			return nil, nil, nil, err
		}
		key, err := parseKey(keyPEM)
		if err != nil {
			return nil, nil, nil, err
		}
		if !cert.IsCA || cert.CheckSignatureFrom(cert) != nil || !now.Before(cert.NotAfter.Add(-90*24*time.Hour)) || now.Before(cert.NotBefore) {
			return nil, nil, nil, fmt.Errorf("retained agent issuer is invalid or needs a reviewed trust rotation")
		}
		pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
		if !ok || !key.PublicKey.Equal(pub) {
			return nil, nil, nil, fmt.Errorf("retained agent issuer key differs from its certificate")
		}
		return cert, key, certPEM, nil
	}
	if !os.IsNotExist(err) {
		return nil, nil, nil, err
	}
	if issuerErr == nil {
		return nil, nil, nil, fmt.Errorf("retained issuer is incomplete; restore its original certificate and key")
	}
	// Never replace a partial existing issuer. A broken first setup requires
	// explicit repair rather than silently discarding agents' trust identity.
	if _, err := os.Lstat(keyPath); !os.IsNotExist(err) {
		return nil, nil, nil, fmt.Errorf("retained issuer key exists without its certificate; restore the matching certificate")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, err
	}
	serialNumber, err := serial()
	if err != nil {
		return nil, nil, nil, err
	}
	cert := &x509.Certificate{SerialNumber: serialNumber, Subject: pkix.Name{CommonName: "Vectory private agent listener CA"}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return nil, nil, nil, err
	}
	cert, err = x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM, err := private(key)
	if err != nil {
		return nil, nil, nil, err
	}
	// Publish both issuer files by one directory rename. A power interruption
	// before publication cannot expose half a trust identity to the listener.
	staging, err := os.MkdirTemp(dir, ".issuer-")
	if err != nil {
		return nil, nil, nil, err
	}
	defer os.RemoveAll(staging)
	if err = save(filepath.Join(staging, "agent-ca-key.pem"), keyPEM); err == nil {
		err = save(filepath.Join(staging, "agent-ca.pem"), certPEM)
	}
	if err == nil {
		err = os.Rename(staging, issuerDir)
	}
	if err == nil {
		err = syncDirectory(dir)
	}
	return cert, key, certPEM, err
}

func maintain(dir, hostname string, now time.Time) error {
	if hostname == "" || net.ParseIP(hostname) != nil || strings.ContainsAny(hostname, "/:\\ \t\r\n") {
		return fmt.Errorf("provide the server DNS hostname")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("certificate directory must already exist as a regular directory")
	}
	release, err := certificateLock(dir)
	if err != nil {
		return err
	}
	defer release()
	ca, caKey, caPEM, err := issuer(dir, now)
	if err != nil {
		return err
	}
	keyPath, certPath := filepath.Join(dir, "server_key"), filepath.Join(dir, "server_cert")
	keyPEM, err := readRegular(keyPath)
	var key *ecdsa.PrivateKey
	if os.IsNotExist(err) {
		if _, err := os.Lstat(certPath); !os.IsNotExist(err) {
			return fmt.Errorf("retained leaf certificate has no key; restore its matching key")
		}
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err == nil {
			keyPEM, err = private(key)
		}
		if err == nil {
			err = save(keyPath, keyPEM)
		}
	} else if err == nil {
		key, err = parseKey(keyPEM)
	}
	if err != nil {
		return err
	}
	certPEM, err := readRegular(certPath)
	if err == nil {
		pair, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			return fmt.Errorf("retained leaf certificate and key mismatch")
		}
		cert, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return err
		}
		if cert.CheckSignatureFrom(ca) != nil || cert.VerifyHostname(hostname) != nil {
			return fmt.Errorf("retained leaf belongs to another issuer or hostname; restore original setup")
		}
		if now.Before(cert.NotBefore) {
			return fmt.Errorf("system clock precedes retained certificate validity")
		}
		if now.Before(cert.NotAfter.Add(-30 * 24 * time.Hour)) {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	serialNumber, err := serial()
	if err != nil {
		return err
	}
	cert := &x509.Certificate{SerialNumber: serialNumber, Subject: pkix.Name{CommonName: hostname}, DNSNames: []string{hostname}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.Add(90 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, ca, &key.PublicKey, caKey)
	if err != nil {
		return err
	}
	chain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), caPEM...)
	return save(certPath, chain)
}

func main() {
	dir := flag.String("out", "/run/secrets", "retained private certificate volume")
	hostname := flag.String("hostname", "", "agent listener DNS hostname")
	watch := flag.Bool("watch", false, "check renewal every six hours")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unexpected arguments")
		os.Exit(2)
	}
	for {
		if err := maintain(*dir, *hostname, time.Now()); err != nil {
			fmt.Fprintln(os.Stderr, "Vectory agent certificate maintenance:", err)
			os.Exit(1)
		}
		fmt.Println("Agent listener certificate ready; retained private issuer and key are unchanged. No host trust store was modified.")
		if !*watch {
			return
		}
		time.Sleep(6 * time.Hour)
	}
}
