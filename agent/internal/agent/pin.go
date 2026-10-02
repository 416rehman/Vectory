package agent

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

// ServerCAFile is where a pinned server CA is kept inside the state directory.
// After enrollment, later connections use it as an ordinary trusted CA file.
const ServerCAFile = "server-ca.pem"

// ParseCAFingerprint accepts a SHA-256 fingerprint as 64 hex digits, with or
// without colons or spaces (as shown on the Add device page).
func ParseCAFingerprint(value string) ([]byte, error) {
	clean := strings.NewReplacer(":", "", " ", "", "-", "").Replace(strings.TrimSpace(value))
	clean = strings.TrimPrefix(strings.TrimPrefix(clean, "sha256"), "SHA256")
	sum, err := hex.DecodeString(clean)
	if err != nil || len(sum) != 32 {
		return nil, errors.New("--ca-sha256 must be the 64-character SHA-256 fingerprint shown on the Add device page")
	}
	return sum, nil
}

// errPinnedChainChecked ends the probe's handshake once the chain is judged.
var errPinnedChainChecked = errors.New("pinned chain checked")

// ProbePinnedCA returns the server certificate whose SHA-256 equals pin, after
// proving that the server's presented chain verifies against it as the only
// root, including the host name and validity period. No request, token or
// credential is ever sent: the handshake is abandoned as soon as the chain is
// judged. This host's own roots and platform verifier play no part, so the
// result and its explanation are the same on every OS. This is the
// specification's "trust fingerprint obtained through a separately trusted
// channel": the fingerprint comes from the authenticated dashboard, and a
// certificate is never trusted merely because it was presented.
func ProbePinnedCA(ctx context.Context, server string, pin []byte) (*x509.Certificate, error) {
	base, err := NormalizeServer(server)
	if err != nil {
		return nil, err
	}
	target, _ := url.Parse(base)
	var (
		pinned  *x509.Certificate
		judged  bool
		refusal error
	)
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		DisableKeepAlives:     true,
		DisableCompression:    true,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13,
			// Not skipped: replaced. VerifyConnection verifies the presented
			// chain with the pinned certificate as the only root, and the
			// handshake never completes, so nothing is sent either way.
			InsecureSkipVerify: true,
			VerifyConnection: func(state tls.ConnectionState) error {
				judged = true
				if pinned, refusal = verifyPinnedChain(target, state.PeerCertificates, pin, time.Now()); refusal != nil {
					return refusal
				}
				return errPinnedChainChecked
			}},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, base+"/agent/v1/install.sh", nil)
	if err != nil {
		return nil, errors.New("invalid server address")
	}
	request.Header.Set("User-Agent", "Vectory/"+Version)
	response, err := client.Do(request)
	if err == nil {
		// Unreachable: the handshake always ends in VerifyConnection.
		response.Body.Close()
		return nil, errors.New("the pinned-certificate check did not run")
	}
	proxy, _ := http.ProxyFromEnvironment(request)
	switch {
	case judged && refusal != nil:
		if ce, ok := AsConnectionError(refusal); ok {
			return nil, withProxyNote(ce, proxy)
		}
		return nil, refusal
	case judged && pinned != nil:
		return pinned, nil
	}
	return nil, classifyTransport(target, proxy, false, err)
}

func verifyPinnedChain(target *url.URL, chain []*x509.Certificate, pin []byte, now time.Time) (*x509.Certificate, error) {
	if len(chain) == 0 {
		return nil, &ConnectionError{Code: "TLS_NO_CERTIFICATE", Message: "The server presented no certificate.", Fix: "Check the agent listener's TLS configuration.", Delivery: NotSent}
	}
	var pinned *x509.Certificate
	for _, certificate := range chain {
		if subtle.ConstantTimeCompare(certificateSHA256(certificate), pin) == 1 {
			pinned = certificate
			break
		}
	}
	if pinned == nil {
		return nil, &ConnectionError{
			Code:     "TLS_PIN_MISMATCH",
			Message:  "The server's certificates don't match the pinned CA:\n" + FingerprintMismatch(pin, certificateSHA256(chain[len(chain)-1])),
			Fix:      "Compare them with the full fingerprint on Add device, and copy the command again from there. If it still doesn't match, this address may lead to a different server; don't continue.",
			Delivery: NotSent,
		}
	}
	roots := x509.NewCertPool()
	roots.AddCert(pinned)
	intermediates := x509.NewCertPool()
	for _, certificate := range chain[1:] {
		intermediates.AddCert(certificate)
	}
	if _, err := chain[0].Verify(x509.VerifyOptions{DNSName: target.Hostname(), Roots: roots, Intermediates: intermediates, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		var unknown x509.UnknownAuthorityError
		if errors.As(err, &unknown) {
			return nil, &ConnectionError{
				Code:     "TLS_PIN_NOT_ISSUER",
				Message:  fmt.Sprintf("The pinned certificate %q didn't issue the server's certificate.", certificateName(pinned)),
				Fix:      "Copy the command again from Add device; the server's certificate may have changed.",
				Delivery: NotSent,
				cause:    err,
			}
		}
		return nil, classifyCertificate(target, err, chain)
	}
	return pinned, nil
}

// PinnedCAPEM encodes a pinned certificate for the state directory.
func PinnedCAPEM(certificate *x509.Certificate) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
}

func savePinnedCA(dir string, certificate *x509.Certificate) (string, error) {
	path := filepath.Join(dir, ServerCAFile)
	return path, AtomicWrite(path, PinnedCAPEM(certificate))
}
