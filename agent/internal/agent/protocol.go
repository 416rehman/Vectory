package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	HTTP       *http.Client
	Base       string
	RetryAfter time.Duration
}

var ErrManifestSignature = errors.New("manifest signature rejected")

func NormalizeServer(s string) (string, error) {
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, e := url.Parse(s)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("server must be an HTTPS origin with no path or credentials")
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}
func NewClient(s Settings, c *Credentials, key []byte) (*Client, error) {
	base, e := NormalizeServer(s.Server)
	if e != nil {
		return nil, e
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if s.CAFile != "" {
		b, e := os.ReadFile(s.CAFile)
		if e != nil {
			return nil, errors.New("cannot read trusted CA file")
		}
		if !roots.AppendCertsFromPEM(b) {
			return nil, errors.New("trusted CA file has no certificates")
		}
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots}
	if c != nil {
		pair, e := tls.X509KeyPair([]byte(c.CertificatePEM), key)
		if e != nil {
			return nil, errors.New("invalid device credential")
		}
		cfg.Certificates = []tls.Certificate{pair}
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = cfg
	tr.Proxy = http.ProxyFromEnvironment
	tr.MaxConnsPerHost = 2
	tr.ResponseHeaderTimeout = 20 * time.Second
	tr.DisableCompression = true
	return &Client{Base: base, HTTP: &http.Client{Transport: tr, Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("redirects forbidden") }}}, nil
}
func (c *Client) Close() { c.HTTP.CloseIdleConnections() }
func (c *Client) request(ctx context.Context, method, path string, body any) ([]byte, error) {
	var buf io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		buf = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, c.Base+path, buf)
	if e != nil {
		return nil, errors.New("invalid protocol request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Vectory/"+Version)
	res, e := c.HTTP.Do(req)
	if e != nil {
		return nil, errors.New("verified HTTPS request failed; check trust, reachability, proxy, credentials and clock")
	}
	defer res.Body.Close()
	c.RetryAfter = 0
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		if res.StatusCode == http.StatusTooManyRequests || res.StatusCode == http.StatusServiceUnavailable {
			value := res.Header.Get("Retry-After")
			if seconds, err := strconv.Atoi(value); err == nil {
				c.RetryAfter = time.Duration(min(max(seconds, 0), 3600)) * time.Second
			} else if at, err := http.ParseTime(value); err == nil {
				c.RetryAfter = min(max(time.Until(at), 0), time.Hour)
			}
		}
		return nil, fmt.Errorf("server rejected request (HTTP %d)", res.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, MaxArtifact+1))
	if e != nil {
		return nil, errors.New("response interrupted")
	}
	if len(b) > MaxArtifact {
		return nil, errors.New("response exceeds limit")
	}
	return b, nil
}
func EnsureKey(dir string) ([]byte, string, error) {
	return ensureKeyFile(filepath.Join(dir, "private-key.pem"))
}
func ensureKeyFile(path string) ([]byte, string, error) {
	if e := SafePath(path); e != nil {
		return nil, "", e
	}
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return nil, "", e
		}
		der, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return nil, "", e
		}
		b = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
		if e = AtomicWrite(path, b); e != nil {
			return nil, "", e
		}
	} else if e != nil {
		return nil, "", e
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, "", errors.New("invalid local key")
	}
	raw, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	if e != nil {
		return nil, "", e
	}
	key, ok := raw.(*ecdsa.PrivateKey)
	if !ok {
		return nil, "", errors.New("local key must be ECDSA")
	}
	der, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if e != nil {
		return nil, "", e
	}
	return b, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
}
func validateCredentials(c Credentials, key []byte, expectedDevice string) error {
	return validateCredentialsAt(c, key, expectedDevice, time.Now())
}
func validateCredentialsAt(c Credentials, key []byte, expectedDevice string, at time.Time) error {
	if c.DeviceID == "" || (expectedDevice != "" && c.DeviceID != expectedDevice) {
		return errors.New("credential recipient mismatch")
	}
	pk, e := base64.StdEncoding.DecodeString(c.SigningPublicKey)
	if e != nil || len(pk) != ed25519.PublicKeySize {
		return errors.New("invalid manifest signing key")
	}
	pair, e := tls.X509KeyPair([]byte(c.CertificatePEM), key)
	if e != nil {
		return errors.New("certificate does not match local private key")
	}
	cert, e := x509.ParseCertificate(pair.Certificate[0])
	if e != nil {
		return e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(c.CAPEM)) {
		return errors.New("invalid device CA")
	}
	intermediates := x509.NewCertPool()
	for _, der := range pair.Certificate[1:] {
		ci, e := x509.ParseCertificate(der)
		if e != nil {
			return e
		}
		intermediates.AddCert(ci)
	}
	if _, e = cert.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: at, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); e != nil {
		return errors.New("invalid device certificate chain or lifetime")
	}
	if cert.Subject.CommonName != c.DeviceID {
		return errors.New("certificate UUID mismatch")
	}
	if !cert.NotAfter.Equal(c.CertificateExpiresAt) {
		return errors.New("certificate expiry metadata mismatch")
	}
	return nil
}
func Enroll(ctx context.Context, dir string, s Settings, token string) error {
	unlock, e := Lock(dir)
	if e != nil {
		return e
	}
	defer unlock()
	if token == "" || len(token) > 4096 {
		return errors.New("invalid enrollment token")
	}
	if _, _, e = ReadIdentity(dir); e == nil {
		return errors.New("already enrolled; identity is preserved")
	} else if !os.IsNotExist(e) {
		return e
	}
	key, csr, e := EnsureKey(dir)
	if e != nil {
		return e
	}
	var pending struct {
		RequestID string `json:"request_id"`
		Name      string `json:"name"`
		Server    string `json:"server"`
	}
	pendingPath := filepath.Join(dir, "enrollment.json")
	e = ReadJSON(pendingPath, &pending)
	if os.IsNotExist(e) {
		pending.RequestID = RandomID()
		pending.Name = s.Name
		pending.Server = s.Server
		if e = WriteJSON(pendingPath, pending); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	if pending.Name != s.Name || pending.Server != s.Server {
		return errors.New("pending enrollment belongs to a different server or name; preserve identity and retry the original request")
	}
	c, e := NewClient(s, nil, nil)
	if e != nil {
		return e
	}
	defer c.Close()
	b, e := c.request(ctx, "POST", "/agent/v1/enroll", Enrollment{1, pending.RequestID, token, s.Name, csr, runtime.GOOS, runtime.GOARCH, Version, VectorVersion})
	if e != nil {
		return e
	}
	var cred Credentials
	if e = json.Unmarshal(b, &cred); e != nil {
		return errors.New("invalid enrollment response")
	}
	if e = validateCredentials(cred, key, ""); e != nil {
		return e
	}
	if e = StoreIdentity(dir, cred, key); e != nil {
		return e
	}
	st, e := LoadState(dir)
	if e != nil {
		return e
	}
	st.DeviceID = cred.DeviceID
	return SaveState(dir, st)
}
func (c *Client) Renew(ctx context.Context, dir string, current Credentials, key []byte, csr string) (Credentials, error) {
	b, e := c.request(ctx, "POST", "/agent/v1/renew", map[string]string{"csr_pem": csr})
	if e != nil {
		return current, e
	}
	var next Credentials
	if e = json.Unmarshal(b, &next); e != nil {
		return current, errors.New("invalid renewal response")
	}
	if e = validateCredentials(next, key, current.DeviceID); e != nil {
		return current, e
	}
	return next, nil
}

// Identity is the sole crash-atomic credential/key activation record. Legacy PEM
// mirrors remain for operator tooling, but runtime always prefers this bundle.
type IdentityBundle struct {
	Credentials   Credentials `json:"credentials"`
	PrivateKeyPEM string      `json:"private_key_pem"`
}

func ReadIdentity(dir string) (Credentials, []byte, error) {
	var b IdentityBundle
	e := ReadJSON(filepath.Join(dir, "identity.json"), &b)
	if e == nil {
		return b.Credentials, []byte(b.PrivateKeyPEM), nil
	}
	if !os.IsNotExist(e) {
		return Credentials{}, nil, e
	}
	var c Credentials
	if e = ReadJSON(filepath.Join(dir, "credentials.json"), &c); e != nil {
		return c, nil, e
	}
	path := filepath.Join(dir, "private-key.pem")
	if e = SafePath(path); e != nil {
		return c, nil, e
	}
	key, e := os.ReadFile(path)
	return c, key, e
}
func StoreIdentity(dir string, c Credentials, key []byte) error {
	if e := WriteJSON(filepath.Join(dir, "identity.json"), IdentityBundle{c, string(key)}); e != nil {
		return e
	}
	// Mirrors are not part of the atomic commit; repair them after a crash on next renewal.
	_ = AtomicWrite(filepath.Join(dir, "private-key.pem"), key)
	_ = WriteJSON(filepath.Join(dir, "credentials.json"), c)
	return nil
}

func VerifyEnvelope(env Envelope, pub, device, nonce string, now time.Time, st State) (Manifest, error) {
	var m Manifest
	p, e := base64.StdEncoding.DecodeString(env.Payload)
	if e != nil || len(p) > MaxArtifact {
		return m, errors.New("invalid manifest encoding")
	}
	sig, e := base64.StdEncoding.DecodeString(env.Signature)
	if e != nil {
		return m, errors.New("invalid signature encoding")
	}
	pk, e := base64.StdEncoding.DecodeString(pub)
	if e != nil || len(pk) != ed25519.PublicKeySize || !ed25519.Verify(ed25519.PublicKey(pk), p, sig) {
		return m, ErrManifestSignature
	}
	if e = json.Unmarshal(p, &m); e != nil {
		return m, errors.New("invalid manifest JSON")
	}
	if m.ProtocolVersion != 1 || m.DeviceID != device || m.Nonce != nonce {
		return m, errors.New("manifest protocol, recipient or nonce rejected")
	}
	if m.ExpiresAt.Before(now.Add(-60*time.Second)) || m.IssuedAt.After(now.Add(60*time.Second)) || !m.ExpiresAt.After(m.IssuedAt) || m.ExpiresAt.Sub(m.IssuedAt) > 5*time.Minute || m.IssuedAt.Before(now.Add(-6*time.Minute)) {
		return m, errors.New("manifest validity rejected; verify the host clock")
	}
	if m.Policy.HeartbeatSeconds < 10 || m.Policy.HeartbeatSeconds > 3600 {
		return m, errors.New("policy exceeds local heartbeat bounds")
	}
	if m.Desired != nil {
		d := m.Desired
		h, e := hex.DecodeString(d.SHA256)
		if e != nil || len(h) != 32 || strings.ToLower(d.SHA256) != d.SHA256 || d.Size < 1 || d.Size > MaxArtifact || d.VersionID == "" || d.ArtifactPath != "/agent/v1/artifacts/"+d.SHA256 {
			return m, errors.New("invalid artifact metadata")
		}
	}
	if m.Generation < st.HighestGeneration || m.PolicyGeneration < st.HighestPolicyGeneration {
		return m, errors.New("stale manifest generation rejected")
	}
	if st.Accepted && m.Generation == st.HighestGeneration && Identity(m.Desired) != st.DesiredIdentity {
		return m, errors.New("same-generation desired identity changed")
	}
	if st.Accepted && m.PolicyGeneration == st.HighestPolicyGeneration && Identity(m.Policy) != st.PolicyIdentity {
		return m, errors.New("same-generation policy changed")
	}
	return m, nil
}
func Identity(v any) string       { b, _ := json.Marshal(v); return Digest(b) }
func SamePublicKey(a, b any) bool { return reflect.DeepEqual(a, b) }
