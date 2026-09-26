// dev-pki provisions an isolated TLS CA for local tests. It never installs trust.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
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
		panic(err)
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
func main() {
	out := flag.String("out", ".local/pki", "new output directory (must not exist)")
	hosts := flag.String("hosts", "localhost,127.0.0.1,::1", "comma-separated DNS/IP certificate SANs")
	days := flag.Int("days", 7, "test certificate lifetime, maximum 30 days")
	flag.Parse()
	if *days < 1 || *days > 30 {
		panic("development lifetime must be 1..30 days")
	}
	if strings.TrimSpace(*hosts) == "" {
		panic("at least one DNS/IP SAN is required")
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
			panic("empty SAN")
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
	fp := sha256.Sum256(der)
	fmt.Printf("Created development CA in %s; expires %s\nCA SHA256: %s\nNo trust store was modified. Pass ca.pem explicitly to test clients.\n", *out, ca.NotAfter.UTC().Format(time.RFC3339), hex.EncodeToString(fp[:]))
}
