// dev-pki provisions an isolated TLS CA for local tests. It never installs trust.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
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

func must(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "Vectory setup: %v\n", err)
		os.Exit(1)
	}
}
func serial() *big.Int {
	n, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	must(e)
	return n
}
func write(dir, name, typ string, b []byte) {
	f, e := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	must(e)
	_, e = f.Write(pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: b}))
	must(e)
	must(f.Close())
}

// check retains an existing preview's trust and identities. Expiring or partial
// certificates are refused rather than silently replacing a CA devices pin.
func check(dir, bootstrap string) error {
	chain, err := tls.LoadX509KeyPair(filepath.Join(dir, "server.pem"), filepath.Join(dir, "server-key.pem"))
	if err != nil {
		return fmt.Errorf("read retained preview TLS: %w", err)
	}
	cert, err := x509.ParseCertificate(chain.Certificate[0])
	if err != nil {
		return err
	}
	caBytes, err := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if err != nil {
		return err
	}
	block, _ := pem.Decode(caBytes)
	if block == nil {
		return fmt.Errorf("preview CA is not PEM")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return err
	}
	if !ca.IsCA {
		return fmt.Errorf("preview CA has no CA constraint")
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	_, err = cert.Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1", CurrentTime: time.Now().Add(time.Hour)})
	if err != nil {
		return fmt.Errorf("retained preview certificate is invalid or expires within an hour: %w", err)
	}
	if bootstrap != "" {
		info, err := os.Lstat(bootstrap)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 1024 {
			return fmt.Errorf("retained preview setup secret is missing or unsafe")
		}
		secret, err := os.ReadFile(bootstrap)
		if err != nil || len(strings.TrimSpace(string(secret))) < 24 {
			return fmt.Errorf("retained preview setup secret is invalid")
		}
	}
	return nil
}

func writeBootstrap(path string) error {
	secret := make([]byte, 48)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(base64.RawURLEncoding.EncodeToString(secret) + "\n"); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func checkServer(certFile, keyFile, hostname string) error {
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("TLS certificate and private key do not form a readable pair: %w", err)
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return err
	}
	if cert.IsCA {
		return fmt.Errorf("use the server's TLS certificate and private key, not the issuing CA certificate or its private key")
	}
	if len(cert.ExtKeyUsage) > 0 {
		serverUsage := false
		for _, usage := range cert.ExtKeyUsage {
			if usage == x509.ExtKeyUsageServerAuth || usage == x509.ExtKeyUsageAny {
				serverUsage = true
			}
		}
		if !serverUsage {
			return fmt.Errorf("the certificate does not permit TLS server authentication")
		}
	}
	if err := cert.VerifyHostname(hostname); err != nil {
		return fmt.Errorf("TLS certificate does not name %s: %w", hostname, err)
	}
	if now := time.Now(); now.Before(cert.NotBefore) || !now.Add(time.Hour).Before(cert.NotAfter) {
		return fmt.Errorf("TLS certificate is not valid now or expires within an hour")
	}
	return nil
}

func main() {
	out := flag.String("out", ".local/pki", "new output directory (must not exist)")
	hosts := flag.String("hosts", "localhost,127.0.0.1,::1", "comma-separated DNS/IP certificate SANs")
	days := flag.Int("days", 7, "test certificate lifetime, maximum 30 days")
	bootstrap := flag.String("bootstrap", "", "also create a private first-administrator setup secret at this new file")
	checkOnly := flag.Bool("check", false, "check retained preview certificates and optional setup secret without writing")
	bootstrapOnly := flag.Bool("bootstrap-only", false, "create the private setup secret without generating certificates")
	serverCert := flag.String("server-cert", "", "check an operator-supplied server certificate (no trust store change)")
	serverKeyFile := flag.String("server-key", "", "private key for --server-cert")
	hostname := flag.String("hostname", "", "server name to check in --server-cert")
	flag.Parse()
	modes := 0
	if *checkOnly {
		modes++
	}
	if *bootstrapOnly {
		modes++
	}
	if *serverCert != "" || *serverKeyFile != "" || *hostname != "" {
		modes++
	}
	if modes > 1 || flag.NArg() > 0 {
		must(fmt.Errorf("choose one setup operation, without positional arguments"))
	}
	if *serverCert != "" || *serverKeyFile != "" || *hostname != "" {
		if *serverCert == "" || *serverKeyFile == "" || *hostname == "" {
			must(fmt.Errorf("server certificate, private key and hostname are all required"))
		}
		must(checkServer(*serverCert, *serverKeyFile, *hostname))
		fmt.Println("Server TLS certificate and private key match the chosen hostname.")
		return
	}
	if *bootstrapOnly {
		if *bootstrap == "" {
			must(fmt.Errorf("--bootstrap-only requires --bootstrap"))
		}
		must(writeBootstrap(*bootstrap))
		fmt.Println("Created a private first-administrator setup secret.")
		return
	}
	if *checkOnly {
		must(check(*out, *bootstrap))
		fmt.Println("Retained preview TLS and setup secret are ready.")
		return
	}
	if *days < 1 || *days > 30 {
		must(fmt.Errorf("development lifetime must be 1..30 days"))
	}
	if strings.TrimSpace(*hosts) == "" {
		must(fmt.Errorf("at least one DNS/IP SAN is required"))
	}
	if *bootstrap != "" {
		if _, err := os.Lstat(*bootstrap); !os.IsNotExist(err) {
			must(fmt.Errorf("setup secret path already exists or cannot be checked"))
		}
	}
	must(os.MkdirAll(filepath.Dir(*out), 0700))
	must(os.Mkdir(*out, 0700))
	now := time.Now()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(e)
	ca := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Vectory isolated development CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Duration(*days) * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, e := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	must(e)
	write(*out, "ca.pem", "CERTIFICATE", der)
	caDer, e := x509.MarshalPKCS8PrivateKey(key)
	must(e)
	write(*out, "ca-key.pem", "PRIVATE KEY", caDer)
	serverKey, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(e)
	cert := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Vectory isolated development server"}, NotBefore: now.Add(-time.Minute), NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, h := range strings.Split(*hosts, ",") {
		h = strings.TrimSpace(h)
		if h == "" {
			must(fmt.Errorf("empty SAN"))
		}
		if ip := net.ParseIP(h); ip != nil {
			cert.IPAddresses = append(cert.IPAddresses, ip)
		} else {
			cert.DNSNames = append(cert.DNSNames, h)
		}
	}
	sd, e := x509.CreateCertificate(rand.Reader, cert, ca, &serverKey.PublicKey, key)
	must(e)
	write(*out, "server.pem", "CERTIFICATE", sd)
	sk, e := x509.MarshalPKCS8PrivateKey(serverKey)
	must(e)
	write(*out, "server-key.pem", "PRIVATE KEY", sk)
	if *bootstrap != "" {
		must(writeBootstrap(*bootstrap))
	}
	fp := sha256.Sum256(der)
	fmt.Printf("Created development CA in %s; expires %s\nCA SHA256: %s\nNo trust store was modified. Pass ca.pem explicitly to test clients.\n", *out, ca.NotAfter.UTC().Format(time.RFC3339), hex.EncodeToString(fp[:]))
}
