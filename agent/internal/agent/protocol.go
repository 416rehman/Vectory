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
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
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
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("server must be an HTTPS origin with no path or credentials")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("server port must be between 1 and 65535")
		}
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
			return nil, errors.New("cannot read trusted CA file; check the saved path and the agent account's read access")
		}
		if !roots.AppendCertsFromPEM(b) {
			return nil, errors.New("trusted CA file has no certificates; use public CA certificates in PEM format")
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
	// A request that never reached WroteHeaders/WroteRequest provably left no
	// byte on the connection; enrollment uses that to tell unsent from maybe-sent.
	var wrote atomic.Bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		WroteHeaders: func() { wrote.Store(true) },
		WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) },
	}))
	res, e := c.HTTP.Do(req)
	if e != nil {
		target, _ := url.Parse(c.Base)
		proxy, _ := http.ProxyFromEnvironment(req)
		return nil, classifyTransport(target, proxy, wrote.Load(), e)
	}
	defer res.Body.Close()
	c.RetryAfter = retryAfter(res)
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		target, _ := url.Parse(c.Base)
		return nil, classifyStatus(target, path, res.StatusCode, c.RetryAfter, body)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, MaxArtifact+1))
	if e != nil {
		return nil, &bodyInterrupted{cause: e}
	}
	if len(b) > MaxArtifact {
		return nil, errResponseTooLarge
	}
	return b, nil
}

// bodyInterrupted is a response the server began and did not finish: it
// closed the connection, reset it or stopped sending before the client's time
// limit.
type bodyInterrupted struct{ cause error }

func (e *bodyInterrupted) Error() string { return "response interrupted" }
func (e *bodyInterrupted) Unwrap() error { return e.cause }

// timedOut reports a body that stopped arriving rather than one cut short.
func (e *bodyInterrupted) timedOut() bool {
	var timeout interface{ Timeout() bool }
	return errors.Is(e.cause, context.DeadlineExceeded) || errors.As(e.cause, &timeout) && timeout.Timeout()
}

var errResponseTooLarge = errors.New("response exceeds limit")

// retryAfter is the server's Retry-After on a 429 or 503 answer, in seconds
// or as a date, at most an hour; zero for any other answer.
func retryAfter(res *http.Response) time.Duration {
	if res.StatusCode != http.StatusTooManyRequests && res.StatusCode != http.StatusServiceUnavailable {
		return 0
	}
	value := res.Header.Get("Retry-After")
	if seconds, err := strconv.Atoi(value); err == nil {
		return time.Duration(min(max(seconds, 0), 3600)) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		return min(max(time.Until(at), 0), time.Hour)
	}
	return 0
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
	csr, e := enrollmentCSR(b)
	return b, csr, e
}
func enrollmentCSR(b []byte) (string, error) {
	block, _ := pem.Decode(b)
	if block == nil {
		return "", errors.New("invalid local key")
	}
	raw, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	if e != nil {
		return "", e
	}
	key, ok := raw.(*ecdsa.PrivateKey)
	if !ok {
		return "", errors.New("local key must be ECDSA")
	}
	der, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if e != nil {
		return "", e
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
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
	s, token, e = enrollmentInput(s, token)
	if e != nil {
		return e
	}
	if e = enrollmentPreflight(dir, s); e != nil {
		return e
	}
	c, e := NewClient(s, nil, nil)
	if e != nil {
		return e
	}
	defer c.Close()
	return enrollPrepared(ctx, dir, s, token, c)
}

func enrollPrepared(ctx context.Context, dir string, s Settings, token string, c *Client) error {
	return enrollPreparedAs(ctx, dir, s, token, c, "")
}

// enrollPreparedAs enrolls and names the service manager setup registered
// (empty: not known, omitted). Servers that predate the field ignore it.
func enrollPreparedAs(ctx context.Context, dir string, s Settings, token string, c *Client, serviceManager string) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	key, csr, e := EnsureKey(dir)
	if e != nil {
		return e
	}
	var pending enrollmentPending
	pendingPath := filepath.Join(dir, "enrollment.json")
	e = ReadJSON(pendingPath, &pending)
	// previous is what the server can have seen before this attempt.
	previous := "maybe"
	switch {
	case os.IsNotExist(e), e == nil && pending.rebindable() && (pending.Delivery == "refused" || pending.Name != s.Name || pending.Server != s.Server):
		// Nothing under the old request can exist on the server: start afresh.
		pending, previous = enrollmentPending{RequestID: RandomID(), Name: s.Name, Server: s.Server}, "no"
	case e != nil:
		return e
	case pending.Name != s.Name || pending.Server != s.Server:
		return pendingBindingError(pending)
	case pending.Delivery == "no":
		previous = "no"
	}
	// Persist before sending: a crash mid-request must leave the conservative
	// "maybe" record, never one that permits rebinding.
	if pending.Delivery != "maybe" {
		pending.Delivery = "maybe"
		if e = WriteJSON(pendingPath, pending); e != nil {
			return e
		}
	}
	b, e := c.request(ctx, "POST", "/agent/v1/enroll", Enrollment{ProtocolVersion: 1, RequestID: pending.RequestID, Token: token, Name: s.Name, CSRPEM: csr, OS: runtime.GOOS, Arch: runtime.GOARCH, AgentVersion: Version, VectorVersion: s.adoptedVectorVersion(), ConfigurationMode: s.CapabilityPolicy.ConfigurationMode(), ServiceManager: serviceManager})
	if e != nil {
		if ce, ok := AsConnectionError(e); ok {
			outcome := pending
			switch {
			case ce.Delivery == NotSent:
				outcome.Delivery = previous
			case ce.Code == "ENROLLMENT_REFUSED":
				// The server looks up this request before checking the token, so
				// a refusal means no device exists for it.
				outcome.Delivery = "refused"
			}
			outcome.LastFailure = ce.Code
			if outcome != pending {
				// Best effort: if this write fails, the "maybe" record stays.
				_ = WriteJSON(pendingPath, outcome)
			}
		}
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
		return fmt.Errorf("enrollment identity was saved but durable state could not be read; preserve local files and inspect recovery before retrying: %w", e)
	}
	st.DeviceID = cred.DeviceID
	if e = SaveState(dir, st); e != nil {
		return fmt.Errorf("enrollment identity was saved but durable state update is incomplete; preserve local files and inspect recovery before retrying: %w", e)
	}
	return nil
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
	if m.Generation > MaxJSONCounter || m.PolicyGeneration > MaxJSONCounter || (m.Desired != nil && m.Generation == 0) {
		return m, errors.New("manifest generation exceeds protocol bounds")
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
