// Run: go test -v tests/security/protocol_test.go
// Set VECTORY_SECURITY_SERVER to the absolute compiled server binary. Each run
// provisions its own private temporary CA/database/listeners; no fleet is reused.
package security_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type harness struct {
	t                       *testing.T
	http, https             string
	plain, tls              *http.Client
	cookie, csrf, bootstrap string
	roots                   *x509.CertPool
}

func freePort(t *testing.T) string {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	a := l.Addr().String()
	l.Close()
	return a
}
func serial() *big.Int { n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)); return n }
func totpCode(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.TrimRight(secret, "="))
	if err != nil {
		t.Fatal(err)
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/30))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 15
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(digest[offset:offset+4])&0x7fffffff)%1000000)
}
func keyCSR(t *testing.T) ([]byte, string) {
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := x509.MarshalPKCS8PrivateKey(k)
	if e != nil {
		t.Fatal(e)
	}
	csr, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "attacker-chosen-admin"}, DNSNames: []string{"admin"}}, k)
	if e != nil {
		t.Fatal(e)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}), string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))
}

// server is one isolated server process that a test may stop and start again
// on the same state, as an operator does around vectory-admin.
type server struct {
	t                                             *testing.T
	h                                             *harness
	dir, binary, admin, certPath, keyPath, secret string
	cmd                                           *exec.Cmd
	log                                           *os.File
	// descriptors, when set, limits the server's open files (POSIX only), as a
	// service manager's LimitNOFILE does.
	descriptors int
}

func setup(t *testing.T) *harness {
	s := newServer(t)
	s.start()
	return s.h
}

// copyBinary copies a build input so native Windows tests do not hold the
// developer's build output open or switch revisions during a concurrent rebuild.
func copyBinary(t *testing.T, dir, binary string) string {
	bytes, e := os.ReadFile(binary)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("native %s sha256=%x", filepath.Base(binary), sha256.Sum256(bytes))
	copied := filepath.Join(dir, filepath.Base(binary))
	if e = os.WriteFile(copied, bytes, 0700); e != nil {
		t.Fatal(e)
	}
	return copied
}

func newServer(t *testing.T) *server {
	binary := os.Getenv("VECTORY_SECURITY_SERVER")
	if binary == "" {
		t.Skip("native server security suite requires VECTORY_SECURITY_SERVER; not a passing native gate")
	}
	dir := t.TempDir()
	s := &server{t: t, dir: dir, binary: copyBinary(t, dir, binary)}
	// vectory-admin is built next to the server; VECTORY_SECURITY_ADMIN overrides.
	s.admin = os.Getenv("VECTORY_SECURITY_ADMIN")
	if s.admin == "" {
		s.admin = filepath.Join(filepath.Dir(binary), "vectory-admin"+filepath.Ext(binary))
	}
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "isolated-security-test"}, IsCA: true, BasicConstraintsValid: true, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageCertSign}
	caDER, e := x509.CreateCertificate(rand.Reader, ca, ca, &k.PublicKey, k)
	if e != nil {
		t.Fatal(e)
	}
	cert := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	certDER, e := x509.CreateCertificate(rand.Reader, cert, ca, &k.PublicKey, k)
	if e != nil {
		t.Fatal(e)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(k)
	s.certPath, s.keyPath, s.secret = filepath.Join(dir, "server.pem"), filepath.Join(dir, "key.pem"), filepath.Join(dir, "bootstrap")
	for p, b := range map[string][]byte{s.certPath: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), s.keyPath: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})} {
		if e = os.WriteFile(p, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	secret := fmt.Sprintf("%x", serial().Bytes()) + fmt.Sprintf("%x", serial().Bytes())
	if e = os.WriteFile(s.secret, []byte(secret), 0600); e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
	s.h = &harness{t: t, plain: &http.Client{Timeout: 10 * time.Second}, tls: &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}}, bootstrap: secret, roots: roots}
	if s.log, e = os.Create(filepath.Join(dir, "server.log")); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		s.stop()
		s.log.Close()
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(dir, "server.log"))
			t.Logf("server diagnostics: %s", data)
		}
	})
	return s
}

// start runs the server on fresh loopback ports and waits until it answers.
func (s *server) start() {
	t, h := s.t, s.h
	httpAddr, tlsAddr := freePort(t), freePort(t)
	h.http, h.https = "http://"+httpAddr, "https://"+tlsAddr
	cmd := exec.Command(s.binary)
	if s.descriptors > 0 {
		cmd = exec.Command("sh", "-c", fmt.Sprintf(`ulimit -n %d && exec "$0"`, s.descriptors), s.binary)
	}
	cmd.Env = append(os.Environ(), "VECTORY_DATA_DIR="+filepath.Join(s.dir, "state"), "VECTORY_HTTP_ADDR="+httpAddr, "VECTORY_AGENT_ADDR="+tlsAddr, "VECTORY_TLS_CERT="+s.certPath, "VECTORY_TLS_KEY="+s.keyPath, "VECTORY_BOOTSTRAP_SECRET_FILE="+s.secret, "VECTORY_COOKIE_SECURE=false", "VECTORY_DEVELOPMENT=true", "VECTORY_DASHBOARD_DIR="+s.dir, "VECTORY_RELEASES_DIR="+filepath.Join(s.dir, "releases"))
	cmd.Stdout = s.log
	cmd.Stderr = s.log
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	s.cmd = cmd
	for i := 0; i < 100; i++ {
		res, e := h.plain.Get(h.http + "/api/v1/status")
		if e == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("isolated server did not become ready")
}

// stop ends the server process; its exclusive data-directory lock goes with it.
func (s *server) stop() {
	if s.cmd != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
		s.cmd = nil
	}
}

// adminTool runs vectory-admin on this server's state, returning its combined
// output and exit code.
func (s *server) adminTool(args ...string) (string, int) {
	s.t.Helper()
	cmd := exec.Command(s.admin, append([]string{"--data-dir", filepath.Join(s.dir, "state")}, args...)...)
	out, e := cmd.CombinedOutput()
	if exit, ok := e.(*exec.ExitError); ok {
		return string(out), exit.ExitCode()
	}
	if e != nil {
		s.t.Fatalf("vectory-admin did not run (set VECTORY_SECURITY_ADMIN): %v", e)
	}
	return string(out), 0
}
func (h *harness) req(client *http.Client, base, method, path string, v any, cookie, csrf string) (int, map[string]any, http.Header) {
	h.t.Helper()
	b, _ := json.Marshal(v)
	r, e := http.NewRequest(method, base+path, bytes.NewReader(b))
	if e != nil {
		h.t.Fatal(e)
	}
	r.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	res, e := client.Do(r)
	if e != nil {
		h.t.Fatal(e)
	}
	defer res.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024))
	if e != nil {
		h.t.Fatal(e)
	}
	var result map[string]any
	json.Unmarshal(raw, &result)
	return res.StatusCode, result, res.Header
}
func (h *harness) oversized(client *http.Client, url string, v any) (int, map[string]any, http.Header) {
	h.t.Helper()
	b, _ := json.Marshal(v)
	r, e := http.NewRequest("POST", url, bytes.NewReader(b))
	if e != nil {
		h.t.Fatal(e)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Expect", "100-continue")
	res, e := client.Do(r)
	if e != nil {
		h.t.Fatal(e)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	var result map[string]any
	json.Unmarshal(raw, &result)
	return res.StatusCode, result, res.Header
}
func (h *harness) api(method, path string, v any) (int, map[string]any, http.Header) {
	return h.req(h.plain, h.http, method, "/api/v1"+path, v, h.cookie, h.csrf)
}
func expect(t *testing.T, got, want int, v any) {
	t.Helper()
	if got != want {
		t.Fatalf("HTTP got %d want %d; sanitized response: %#v", got, want, v)
	}
}
func okay(t *testing.T, got int, v any) {
	t.Helper()
	if got != 200 && got != 201 {
		t.Fatalf("HTTP got %d; response %#v", got, v)
	}
}
func (h *harness) token(options map[string]any) string {
	n, v, _ := h.api("POST", "/tokens", options)
	okay(h.t, n, v)
	return v["token"].(string)
}
func (h *harness) enroll(token, name, request, csr string) (int, map[string]any) {
	n, v, _ := h.req(h.tls, h.https, "POST", "/agent/v1/enroll", map[string]any{"protocol_version": 1, "request_id": request, "token": token, "name": name, "csr_pem": csr, "os": "windows", "arch": "amd64", "agent_version": "security-test", "vector_version": "0.58.0"}, "", "")
	return n, v
}
func containsValue(values []any, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
func (h *harness) client(v map[string]any, key []byte) *http.Client {
	pair, e := tls.X509KeyPair([]byte(v["certificate_pem"].(string)), key)
	if e != nil {
		h.t.Fatal(e)
	}
	return &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: h.roots, MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair}}}}
}

// from is a client for the agent listener whose connections come from another
// loopback address, so a test can play two hosts. It skips the test where the
// machine has no such address.
func (h *harness) from(t *testing.T, local string) *http.Client {
	t.Helper()
	ip := net.ParseIP(local)
	probe, err := net.ListenTCP("tcp", &net.TCPAddr{IP: ip})
	if err != nil {
		t.Skipf("this machine has no loopback address %s: %v", local, err)
	}
	probe.Close()
	dialer := &net.Dialer{LocalAddr: &net.TCPAddr{IP: ip}, Timeout: 5 * time.Second}
	return &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{DialContext: dialer.DialContext, ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{RootCAs: h.roots, MinVersion: tls.VersionTLS13}}}
}

// status sends one request and returns its HTTP status, draining the body.
func status(t *testing.T, client *http.Client, method, target string, body []byte) int {
	t.Helper()
	r, err := http.NewRequest(method, target, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	res, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res.StatusCode
}

func TestIndependentSecurityBoundaries(t *testing.T) {
	h := setup(t)
	t.Run("anonymous-cannot-enumerate", func(t *testing.T) {
		for _, path := range []string{"/devices", "/groups", "/tokens", "/audit", "/releases", "/configurations"} {
			n, v, _ := h.api("GET", path, nil)
			expect(t, n, 401, v)
		}
	})
	n, v, headers := h.api("POST", "/bootstrap", map[string]any{"bootstrap_secret": h.bootstrap, "email": "security-admin@example.invalid", "name": "Security test", "password": "test-only-password-29843"})
	okay(t, n, v)
	h.cookie = strings.Split(headers.Get("Set-Cookie"), ";")[0]
	h.csrf = v["csrf_token"].(string)
	t.Run("csrf-and-bootstrap-boundary", func(t *testing.T) {
		n, v, _ := h.req(h.plain, h.http, "POST", "/api/v1/tokens", map[string]any{"name": "bad", "expires_hours": 1}, h.cookie, "")
		expect(t, n, 403, v)
		n, v, _ = h.api("POST", "/bootstrap", map[string]any{"bootstrap_secret": h.bootstrap, "email": "other@example.invalid", "name": "other", "password": "test-only-password-29843"})
		expect(t, n, 409, v)
	})
	t.Run("viewer-denied-admin-and-deployment", func(t *testing.T) {
		n, v, _ := h.api("POST", "/users", map[string]any{"email": "viewer@example.invalid", "name": "viewer", "role": "viewer", "password": "test-only-password-82734"})
		okay(t, n, v)
		n, v, headers := h.req(h.plain, h.http, "POST", "/api/v1/login", map[string]any{"email": "viewer@example.invalid", "password": "test-only-password-82734"}, "", "")
		okay(t, n, v)
		cookie := strings.Split(headers.Get("Set-Cookie"), ";")[0]
		csrf := v["csrf_token"].(string)
		for _, path := range []string{"/tokens", "/users", "/deployments", "/groups", "/configurations"} {
			n, v, _ = h.req(h.plain, h.http, "POST", "/api/v1"+path, map[string]any{}, cookie, csrf)
			expect(t, n, 403, v)
		}
	})
	t.Run("untrusted-ca-rejected", func(t *testing.T) {
		client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool(), MinVersion: tls.VersionTLS13}}}
		_, e := client.Get(h.https + "/agent/v1/heartbeat")
		if e == nil {
			t.Fatal("untrusted CA accepted")
		}
	})
	t.Run("tls12-rejected", func(t *testing.T) {
		client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: h.roots, MinVersion: tls.VersionTLS12, MaxVersion: tls.VersionTLS12}}}
		_, e := client.Get(h.https + "/agent/v1/heartbeat")
		if e == nil {
			t.Fatal("TLS 1.2 accepted")
		}
	})
	t.Run("wrong-hostname-rejected", func(t *testing.T) {
		client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: h.roots, MinVersion: tls.VersionTLS13, ServerName: "wrong.example.invalid"}}}
		_, err := client.Get(h.https + "/agent/v1/heartbeat")
		if err == nil {
			t.Fatal("wrong TLS hostname accepted")
		}
	})
	t.Run("spoofed-proxy-identity-rejected", func(t *testing.T) {
		r, _ := http.NewRequest("POST", h.https+"/agent/v1/heartbeat", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Client-Cert", "admin")
		r.Header.Set("X-Forwarded-Client-Cert", "admin")
		res, e := h.tls.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatalf("spoofed identity HTTP %d", res.StatusCode)
		}
	})
	token := h.token(map[string]any{"name": "security-token", "expires_hours": 1, "max_uses": 10, "name_prefix": "sec-"})
	key, csr := keyCSR(t)
	t.Run("malformed-and-out-of-scope-token-rejected", func(t *testing.T) {
		for _, tc := range []struct{ token, name string }{{"invalid", "sec-invalid"}, {token, "outside-scope"}} {
			n, v := h.enroll(tc.token, tc.name, fmt.Sprintf("%x", serial()), csr)
			if n < 400 {
				t.Fatalf("invalid enrollment accepted: %#v", v)
			}
		}
	})
	request := fmt.Sprintf("%x", serial())
	t.Run("invalid-csr-signature-rejected", func(t *testing.T) {
		block, _ := pem.Decode([]byte(csr))
		block.Bytes[len(block.Bytes)-1] ^= 1
		badCSR := string(pem.EncodeToMemory(block))
		n, _ := h.enroll(token, "sec-bad-proof", fmt.Sprintf("%x", serial()), badCSR)
		if n < 400 {
			t.Fatal("invalid CSR proof of possession accepted")
		}
	})
	n, device := h.enroll(token, "sec-one", request, csr)
	okay(t, n, device)
	t.Run("csr-privileges-overridden", func(t *testing.T) {
		block, _ := pem.Decode([]byte(device["certificate_pem"].(string)))
		cert, e := x509.ParseCertificate(block.Bytes)
		if e != nil {
			t.Fatal(e)
		}
		if cert.Subject.CommonName != device["device_id"] || cert.IsCA || len(cert.DNSNames) > 0 || len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
			t.Fatal("caller CSR privilege leaked into issued certificate")
		}
	})
	t.Run("idempotent-enrollment-bound-to-key", func(t *testing.T) {
		n, retry := h.enroll(token, "sec-one", request, csr)
		okay(t, n, retry)
		if retry["device_id"] != device["device_id"] {
			t.Fatal("idempotent retry changed identity")
		}
		_, other := keyCSR(t)
		n, v := h.enroll(token, "sec-one", request, other)
		if n < 400 {
			t.Fatalf("different key recovered identity: %#v", v)
		}
	})
	t.Run("duplicate-name-race-admits-one", func(t *testing.T) {
		_, csrA := keyCSR(t)
		_, csrB := keyCSR(t)
		var wg sync.WaitGroup
		codes := make(chan int, 2)
		for _, c := range []string{csrA, csrB} {
			wg.Add(1)
			go func(c string) {
				defer wg.Done()
				n, _ := h.enroll(token, "sec-race", fmt.Sprintf("%x", serial()), c)
				codes <- n
			}(c)
		}
		wg.Wait()
		close(codes)
		success := 0
		for n := range codes {
			if n == 200 || n == 201 {
				success++
			}
		}
		if success != 1 {
			t.Fatalf("duplicate race admitted %d", success)
		}
	})
	client := h.client(device, key)
	defer client.CloseIdleConnections()
	nonce := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32))
	beat := map[string]any{"protocol_version": 1, "request_id": fmt.Sprintf("%x", serial()), "nonce": nonce, "boot_id": "security-test", "agent_version": "security-test", "vector_version": "0.58.0", "reported_generation": 0, "policy_generation": 0, "actual_sha256": "", "apply_state": "unmanaged", "local_paused": false, "remote_pause_acknowledged": false}
	t.Run("manifest-cryptography-and-unmanaged-enrollment", func(t *testing.T) {
		n, env, _ := h.req(client, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
		okay(t, n, env)
		payload, e := base64.StdEncoding.DecodeString(env["payload"].(string))
		if e != nil {
			t.Fatal(e)
		}
		sig, _ := base64.StdEncoding.DecodeString(env["signature"].(string))
		pub, _ := base64.StdEncoding.DecodeString(device["signing_public_key"].(string))
		if !ed25519.Verify(pub, payload, sig) {
			t.Fatal("manifest signature invalid")
		}
		var m map[string]any
		json.Unmarshal(payload, &m)
		if m["device_id"] != device["device_id"] || m["nonce"] != nonce || m["desired"] != nil {
			t.Fatalf("wrong manifest binding/default desired: %#v", m)
		}
		if features, _ := m["features"].([]any); !containsValue(features, "wake") {
			t.Fatalf("manifest does not offer wake-ups: %#v", m["features"])
		}
		payload[0] ^= 1
		if ed25519.Verify(pub, payload, sig) {
			t.Fatal("tampered manifest accepted")
		}
	})
	t.Run("older-server-generations-fail-closed", func(t *testing.T) {
		advanced := make(map[string]any)
		for key, value := range beat {
			advanced[key] = value
		}
		advanced["reported_generation"] = 999
		advanced["policy_generation"] = 999
		n, rejected, _ := h.req(client, h.https, "POST", "/agent/v1/heartbeat", advanced, "", "")
		expect(t, n, 409, rejected)
	})
	t.Run("oversized-browser-and-agent-bodies-rejected", func(t *testing.T) {
		body := map[string]any{"oversized": strings.Repeat("x", 5*1024*1024)}
		// The server rejects from Content-Length and closes without reading the
		// body, so a client streaming 5 MiB can race into a broken pipe. Ask for
		// 100-continue: the 413 arrives before any body bytes are sent.
		continued := func(c *http.Client) *http.Client {
			var transport *http.Transport
			if base, ok := c.Transport.(*http.Transport); ok {
				transport = base.Clone()
			} else {
				transport = http.DefaultTransport.(*http.Transport).Clone()
			}
			transport.ExpectContinueTimeout = 5 * time.Second
			return &http.Client{Timeout: c.Timeout, Transport: transport}
		}
		n, rejected, _ := h.oversized(continued(h.plain), h.http+"/api/v1/login", body)
		expect(t, n, 413, rejected)
		n, rejected, _ = h.oversized(continued(client), h.https+"/agent/v1/heartbeat", body)
		expect(t, n, 413, rejected)
	})
	t.Run("exhausted-and-revoked-token-rejected", func(t *testing.T) {
		limited := h.token(map[string]any{"name": "one-use", "expires_hours": 1, "max_uses": 1})
		_, limitedCSR := keyCSR(t)
		n, v := h.enroll(limited, "limited-one", fmt.Sprintf("%x", serial()), limitedCSR)
		okay(t, n, v)
		n, v = h.enroll(limited, "limited-two", fmt.Sprintf("%x", serial()), limitedCSR)
		if n < 400 {
			t.Fatal("exhausted token accepted")
		}
		n, v, _ = h.api("POST", "/tokens", map[string]any{"name": "revoke-test", "expires_hours": 1})
		okay(t, n, v)
		revokedSecret := v["token"].(string)
		record := v["record"].(map[string]any)
		n, v, _ = h.api("POST", "/tokens/"+record["id"].(string)+"/revoke", map[string]any{})
		okay(t, n, v)
		n, v = h.enroll(revokedSecret, "revoked-new", fmt.Sprintf("%x", serial()), limitedCSR)
		if n < 400 {
			t.Fatal("revoked token accepted")
		}
	})
	t.Run("token-scope-preapproved-names-and-labels-grant-nothing", func(t *testing.T) {
		tooMany := map[string]string{}
		for i := 0; i < 9; i++ {
			tooMany[fmt.Sprintf("k%d", i)] = "v"
		}
		for _, bad := range []map[string]any{
			{"name": "scope-bad", "expires_hours": 1, "name_prefix": "scope-", "allowed_names": []string{"elsewhere-1"}},
			{"name": "scope-bad", "expires_hours": 1, "allowed_names": []string{}},
			{"name": "scope-bad", "expires_hours": 1, "allowed_names": []string{"scope-a", "SCOPE-A"}},
			{"name": "scope-bad", "expires_hours": 1, "allowed_names": []string{"not a name"}},
			{"name": "scope-bad", "expires_hours": 1, "labels": map[string]string{"bad key": "x"}},
			{"name": "scope-bad", "expires_hours": 1, "labels": tooMany},
		} {
			n, v, _ := h.api("POST", "/tokens", bad)
			expect(t, n, 400, v)
		}
		// A group named like a label: a label must not put a device in it.
		n, group, _ := h.api("POST", "/groups", map[string]any{"name": "production", "device_ids": []string{}})
		okay(t, n, group)
		n, created, _ := h.api("POST", "/tokens", map[string]any{"name": "scoped", "expires_hours": 1, "max_uses": 10, "name_prefix": "scope-", "allowed_names": []string{" Scope-A", "scope-b"}, "labels": map[string]string{"Site": " Berlin ", "group": "production"}})
		okay(t, n, created)
		record := created["record"].(map[string]any)
		if fmt.Sprint(record["allowed_names"]) != "[scope-a scope-b]" || fmt.Sprint(record["labels"]) != "map[group:production site:Berlin]" {
			t.Fatalf("scope not normalized: %#v", record)
		}
		secret := created["token"].(string)
		listed := func() map[string]bool {
			r, e := http.NewRequest("GET", h.http+"/api/v1/devices", nil)
			if e != nil {
				t.Fatal(e)
			}
			r.Header.Set("Cookie", h.cookie)
			res, e := h.plain.Do(r)
			if e != nil {
				t.Fatal(e)
			}
			defer res.Body.Close()
			var devices []map[string]any
			if e = json.NewDecoder(res.Body).Decode(&devices); e != nil {
				t.Fatal(e)
			}
			names := map[string]bool{}
			for _, d := range devices {
				names[d["name"].(string)] = true
			}
			return names
		}
		before := listed()
		_, outsideCSR := keyCSR(t)
		// Matches the prefix but isn't on the list; then matches neither.
		for _, name := range []string{"scope-c", "elsewhere-2"} {
			n, v := h.enroll(secret, name, fmt.Sprintf("%x", serial()), outsideCSR)
			if n < 400 {
				t.Fatalf("%s enrolled outside the token's scope: %#v", name, v)
			}
		}
		if after := listed(); len(after) != len(before) || after["scope-c"] || after["elsewhere-2"] {
			t.Fatal("a refused enrollment created a device record")
		}
		key, csr := keyCSR(t)
		n, enrolled := h.enroll(secret, "Scope-A", fmt.Sprintf("%x", serial()), csr)
		okay(t, n, enrolled)
		_, againCSR := keyCSR(t)
		n, v := h.enroll(secret, "scope-a", fmt.Sprintf("%x", serial()), againCSR)
		if n < 400 {
			t.Fatalf("a preapproved name enrolled twice: %#v", v)
		}
		reasons := map[string]string{}
		n, activity, _ := h.api("GET", "/agent-install/activity?since="+url.QueryEscape(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)), nil)
		okay(t, n, activity)
		for _, raw := range activity["events"].([]any) {
			event := raw.(map[string]any)
			if event["token_id"] == record["id"] && event["outcome"] == "failure" {
				if _, seen := reasons[fmt.Sprint(event["device_name"])]; !seen {
					reasons[fmt.Sprint(event["device_name"])] = fmt.Sprint(event["reason_code"])
				}
			}
		}
		if reasons["scope-c"] != "NAME_NOT_PREAPPROVED" || reasons["elsewhere-2"] != "NAME_PREFIX_MISMATCH" || reasons["scope-a"] != "NAME_ALREADY_ENROLLED" {
			t.Fatalf("refusal reasons not recorded: %#v", reasons)
		}
		// Labels arrive on the device; they grant no group, assignment or policy.
		id := enrolled["device_id"].(string)
		n, detail, _ := h.api("GET", "/devices/"+id+"?include=groups", nil)
		okay(t, n, detail)
		if fmt.Sprint(detail["labels"]) != "map[group:production site:Berlin]" || detail["name"] != "scope-a" {
			t.Fatalf("labels not applied: %#v", detail)
		}
		if detail["groups"].(map[string]any)["total"] != float64(0) || detail["desired_version_id"] != nil || detail["desired_generation"] != float64(0) || detail["assignment"] != nil || detail["policy_assignment"] != nil {
			t.Fatalf("enrollment scope granted membership or an assignment: %#v", detail)
		}
		n, members, _ := h.api("GET", "/groups/"+group["id"].(string)+"/members", nil)
		okay(t, n, members)
		if members["total"] != float64(0) {
			t.Fatalf("a label added group membership: %#v", members)
		}
		scoped := h.client(enrolled, key)
		defer scoped.CloseIdleConnections()
		n, envelope, _ := h.req(scoped, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
		okay(t, n, envelope)
		payload, _ := base64.StdEncoding.DecodeString(envelope["payload"].(string))
		var manifest map[string]any
		if err := json.Unmarshal(payload, &manifest); err != nil {
			t.Fatal(err)
		}
		if manifest["desired"] != nil || manifest["generation"] != float64(0) {
			t.Fatalf("a scoped enrollment received desired state: %#v", manifest)
		}
		// The other listed name, with the prefix, enrolls under the same token.
		_, secondCSR := keyCSR(t)
		n, second := h.enroll(secret, "scope-b", fmt.Sprintf("%x", serial()), secondCSR)
		okay(t, n, second)
	})
	t.Run("token-name-binding-and-preapproved-list-are-independent-limits", func(t *testing.T) {
		n, created, _ := h.api("POST", "/tokens", map[string]any{"name": "both", "expires_hours": 1, "max_uses": 5, "device_name": "Bound-A", "allowed_names": []string{"bound-a", "bound-b"}})
		okay(t, n, created)
		record := created["record"].(map[string]any)
		if record["device_name"] != "bound-a" || fmt.Sprint(record["allowed_names"]) != "[bound-a bound-b]" {
			t.Fatalf("both limits were not stored: %#v", record)
		}
		secret := created["token"].(string)
		// On the list but not the bound name: refused. The bound name enrolls.
		_, listedCSR := keyCSR(t)
		n, v := h.enroll(secret, "bound-b", fmt.Sprintf("%x", serial()), listedCSR)
		if n < 400 {
			t.Fatalf("a listed name other than the bound one enrolled: %#v", v)
		}
		_, boundCSR := keyCSR(t)
		n, v = h.enroll(secret, "bound-a", fmt.Sprintf("%x", serial()), boundCSR)
		okay(t, n, v)
		// A bound name that isn't on the list, and a listed name that isn't the
		// bound one, can never enroll: the limits are not alternatives.
		n, contradictory, _ := h.api("POST", "/tokens", map[string]any{"name": "never", "expires_hours": 1, "device_name": "solo-a", "allowed_names": []string{"solo-b"}})
		okay(t, n, contradictory)
		_, neverCSR := keyCSR(t)
		for _, name := range []string{"solo-a", "solo-b"} {
			n, v := h.enroll(contradictory["token"].(string), name, fmt.Sprintf("%x", serial()), neverCSR)
			if n < 400 {
				t.Fatalf("%s enrolled although the token's limits contradict each other: %#v", name, v)
			}
		}
	})
	t.Run("editor-and-operator-restrictions", func(t *testing.T) {
		for role, paths := range map[string][]string{"editor": {"/users", "/tokens", "/groups", "/deployments"}, "operator": {"/users", "/configurations"}} {
			email := role + "@example.invalid"
			n, v, _ := h.api("POST", "/users", map[string]any{"email": email, "name": role, "role": role, "password": "test-only-password-82734"})
			okay(t, n, v)
			n, v, headers := h.req(h.plain, h.http, "POST", "/api/v1/login", map[string]any{"email": email, "password": "test-only-password-82734"}, "", "")
			okay(t, n, v)
			cookie := strings.Split(headers.Get("Set-Cookie"), ";")[0]
			csrf := v["csrf_token"].(string)
			for _, path := range paths {
				n, v, _ = h.req(h.plain, h.http, "POST", "/api/v1"+path, map[string]any{}, cookie, csrf)
				expect(t, n, 403, v)
			}
		}
	})
	t.Run("cross-device-artifacts-and-status-isolated", func(t *testing.T) {
		otherKey, otherCSR := keyCSR(t)
		n, other := h.enroll(token, "sec-other", fmt.Sprintf("%x", serial()), otherCSR)
		okay(t, n, other)
		otherClient := h.client(other, otherKey)
		defer otherClient.CloseIdleConnections()
		config := map[string]any{"sources": map[string]any{"test": map[string]any{"type": "demo_logs", "format": "json"}}, "sinks": map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"test"}}}}
		n, created, _ := h.api("POST", "/configurations", map[string]any{"name": "isolated synthetic security fixture", "description": "test only", "graph": map[string]any{"nodes": []any{}, "edges": []any{}}, "config": config})
		okay(t, n, created)
		n, version, _ := h.api("POST", "/configurations/"+created["id"].(string)+"/publish", map[string]any{"revision": created["revision"], "message": "security test"})
		okay(t, n, version)
		deployment := map[string]any{"version_id": version["id"], "priority": 1, "target_mode": "snapshot", "selector": map[string]any{"device_ids": []string{device["device_id"].(string)}, "group_ids": []string{}, "exclude_ids": []string{}}, "rollout": map[string]any{"kind": "all", "canary_size": 1, "batch_size": 10, "observation_seconds": 0, "failure_threshold": 0}}
		n, v, _ := h.api("POST", "/deployments/preview", deployment)
		okay(t, n, v)
		n, v, _ = h.api("POST", "/deployments", deployment)
		okay(t, n, v)
		path := "/agent/v1/artifacts/" + version["sha256"].(string)
		n, v, _ = h.req(client, h.https, "GET", path, nil, "", "")
		expect(t, n, 200, v)
		n, v, _ = h.req(otherClient, h.https, "GET", path, nil, "", "")
		expect(t, n, 403, v)
		spoofed := make(map[string]any)
		for k, value := range beat {
			spoofed[k] = value
		}
		spoofed["device_id"] = device["device_id"]
		spoofed["labels"] = map[string]string{"group": "production"}
		n, envelope, _ := h.req(otherClient, h.https, "POST", "/agent/v1/heartbeat", spoofed, "", "")
		okay(t, n, envelope)
		payload, _ := base64.StdEncoding.DecodeString(envelope["payload"].(string))
		var manifest map[string]any
		json.Unmarshal(payload, &manifest)
		if manifest["device_id"] != other["device_id"] || manifest["desired"] != nil {
			t.Fatal("request identity overrode mTLS principal")
		}
	})
	t.Run("check-on-devices", func(t *testing.T) {
		type host struct {
			id          string
			client      *http.Client
			credentials map[string]any
		}
		enrollHost := func(name string) host {
			key, csr := keyCSR(t)
			n, credentials := h.enroll(token, name, fmt.Sprintf("%x", serial()), csr)
			okay(t, n, credentials)
			client := h.client(credentials, key)
			t.Cleanup(client.CloseIdleConnections)
			return host{credentials["device_id"].(string), client, credentials}
		}
		a, b, c := enrollHost("sec-check-a"), enrollHost("sec-check-b"), enrollHost("sec-check-c")
		// beatAs sends a heartbeat like an agent that announced the feature and
		// returns the signed payload bytes, its JSON and the envelope.
		beatAs := func(who host, nonce string, extra map[string]any) (map[string]any, []byte, map[string]any) {
			body := map[string]any{"agent_features": []string{"validation"}}
			for k, v := range beat {
				body[k] = v
			}
			body["nonce"], body["request_id"] = nonce, fmt.Sprintf("%x", serial())
			for k, v := range extra {
				body[k] = v
			}
			n, envelope, _ := h.req(who.client, h.https, "POST", "/agent/v1/heartbeat", body, "", "")
			okay(t, n, envelope)
			payload, e := base64.StdEncoding.DecodeString(envelope["payload"].(string))
			if e != nil {
				t.Fatal(e)
			}
			var manifest map[string]any
			if e = json.Unmarshal(payload, &manifest); e != nil {
				t.Fatal(e)
			}
			return manifest, payload, envelope
		}
		signedFor := func(who host, payload []byte, envelope map[string]any) bool {
			public, _ := base64.StdEncoding.DecodeString(who.credentials["signing_public_key"].(string))
			signature, _ := base64.StdEncoding.DecodeString(envelope["signature"].(string))
			return ed25519.Verify(public, payload, signature)
		}
		fetch := func(who host, digest string) (int, []byte) {
			res, e := who.client.Get(h.https + "/agent/v1/artifacts/" + digest)
			if e != nil {
				t.Fatal(e)
			}
			defer res.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024))
			return res.StatusCode, body
		}
		nonce := func(n byte) string { return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{n}, 32)) }

		// An operator reviews a version whose variable differs per device and asks the devices to check it.
		for _, who := range []host{a, b, c} {
			beatAs(who, nonce(7), nil)
		}
		config := map[string]any{"sources": map[string]any{"test": map[string]any{"type": "demo_logs", "format": "json", "interval": 1}}, "sinks": map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"test"}}}}
		n, created, _ := h.api("POST", "/configurations", map[string]any{"name": "isolated device check fixture", "description": "test only", "graph": map[string]any{"nodes": []any{}, "edges": []any{}}, "config": config, "variables": []any{map[string]any{"name": "interval", "path": "/sources/test/interval", "type": "integer"}}})
		okay(t, n, created)
		n, version, _ := h.api("POST", "/configurations/"+created["id"].(string)+"/publish", map[string]any{"revision": created["revision"], "message": "device check fixture"})
		okay(t, n, version)
		login := func(label, role string) (string, string) {
			email := "check-" + label + "@example.invalid"
			n, v, _ := h.api("POST", "/users", map[string]any{"email": email, "name": "check " + label, "role": role, "password": "test-only-password-82734"})
			okay(t, n, v)
			n, v, headers := h.req(h.plain, h.http, "POST", "/api/v1/login", map[string]any{"email": email, "password": "test-only-password-82734"}, "", "")
			okay(t, n, v)
			return strings.Split(headers.Get("Set-Cookie"), ";")[0], v["csrf_token"].(string)
		}
		cookie, csrf := login("requester", "operator")
		request := map[string]any{"version_id": version["id"], "priority": 1, "target_mode": "snapshot", "selector": map[string]any{"device_ids": []string{a.id, b.id}, "group_ids": []string{}, "exclude_ids": []string{}}, "rollout": map[string]any{"kind": "all", "canary_size": 1, "batch_size": 10, "observation_seconds": 0, "failure_threshold": 0}, "variable_bindings": map[string]any{"defaults": map[string]any{"interval": 1}, "devices": map[string]any{b.id: map[string]any{"interval": 2}}}, "device_validation": true}
		// A device that holds a wait when the check is requested hears of it at once, with the unsigned hint
		// and nothing else; a device the check did not address does not.
		type hint struct {
			status int
			body   string
			at     time.Time
			err    error
		}
		hold := func(who host) chan hint {
			out := make(chan hint, 1)
			go func() {
				res, e := who.client.Get(h.https + "/agent/v1/wait?generation=0&policy_generation=0")
				if e != nil {
					out <- hint{err: e}
					return
				}
				defer res.Body.Close()
				body, e := io.ReadAll(io.LimitReader(res.Body, 4096))
				out <- hint{res.StatusCode, string(body), time.Now(), e}
			}()
			return out
		}
		heldA, heldC := hold(a), hold(c)
		select {
		case x := <-heldA:
			t.Fatalf("a wait at the current generations answered before any check: %+v", x)
		case <-time.After(500 * time.Millisecond):
		}
		requested := time.Now()
		n, preview, _ := h.req(h.plain, h.http, "POST", "/api/v1/deployments/preview", request, cookie, csrf)
		okay(t, n, preview)
		check := preview["validation_id"].(string)
		select {
		case x := <-heldA:
			if x.err != nil || x.status != 200 || x.body != `{"changed":true}` {
				t.Fatalf("the device the check asked did not hear of it: %+v", x)
			}
			if late := x.at.Sub(requested); late > 2*time.Second {
				t.Fatalf("the parked wait answered %v after the check was requested", late)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("a check never answered the wait of a device it asked")
		}
		select {
		case x := <-heldC:
			t.Fatalf("a device the check did not address was woken: %+v", x)
		case <-time.After(500 * time.Millisecond):
		}
		digests := map[string]string{}
		for _, raw := range preview["artifact_previews"].([]any) {
			entry := raw.(map[string]any)
			digests[entry["device_id"].(string)] = entry["sha256"].(string)
		}
		if digests[a.id] == digests[b.id] {
			t.Fatal("the two devices were reviewed with the same bytes; the isolation probe needs different ones")
		}

		var payloadA []byte
		var envelopeA map[string]any
		t.Run("manifest-is-signed-and-bound-to-recipient-and-nonce", func(t *testing.T) {
			manifest, payload, envelope := beatAs(a, nonce(11), nil)
			payloadA, envelopeA = payload, envelope
			if !signedFor(a, payload, envelope) {
				t.Fatal("manifest signature invalid")
			}
			if manifest["device_id"] != a.id || manifest["nonce"] != nonce(11) {
				t.Fatalf("manifest not bound to its recipient and nonce: %#v", manifest)
			}
			validation, _ := manifest["validation"].(map[string]any)
			if validation == nil || validation["id"] != check || validation["sha256"] != digests[a.id] || validation["artifact_path"] != "/agent/v1/artifacts/"+digests[a.id] || validation["run_tests"] != false {
				t.Fatalf("manifest does not carry this device's check: %#v", manifest["validation"])
			}
			expires, e := time.Parse(time.RFC3339, validation["expires_at"].(string))
			if e != nil || time.Until(expires) > 11*time.Minute || time.Until(expires) < 8*time.Minute {
				t.Fatalf("a check expires ten minutes after it was asked for: %v", validation["expires_at"])
			}
			// The check moves no generation, assignment or policy.
			if manifest["desired"] != nil || manifest["generation"] != float64(0) || manifest["policy_generation"] != float64(0) {
				t.Fatalf("a device check changed desired state: %#v", manifest)
			}
			// Another device is asked for its own candidate, under its own recipient and nonce.
			other, otherPayload, otherEnvelope := beatAs(b, nonce(12), nil)
			if other["device_id"] != b.id || other["nonce"] != nonce(12) || other["validation"].(map[string]any)["sha256"] != digests[b.id] || !signedFor(b, otherPayload, otherEnvelope) {
				t.Fatalf("second device's manifest: %#v", other)
			}
			// A fresh nonce is a fresh signature: the first payload is never valid for the second request.
			again, againPayload, againEnvelope := beatAs(a, nonce(13), nil)
			if again["nonce"] != nonce(13) || bytes.Equal(againPayload, payload) || againEnvelope["signature"] == envelope["signature"] {
				t.Fatal("a repeated heartbeat with another nonce reused the earlier signed payload")
			}
			// The device that was not reviewed is never asked.
			outside, _, _ := beatAs(c, nonce(14), nil)
			if _, asked := outside["validation"]; asked {
				t.Fatalf("a device outside the check was asked: %#v", outside)
			}
		})
		t.Run("tampered-validation-fails-the-signature-check", func(t *testing.T) {
			if len(payloadA) == 0 {
				t.Skip("needs the manifest of the previous subtest")
			}
			mutations := map[string][]byte{
				"digest swapped for the other device's candidate": bytes.ReplaceAll(payloadA, []byte(digests[a.id]), []byte(digests[b.id])),
				"digest changed":            bytes.ReplaceAll(payloadA, []byte(digests[a.id]), []byte(strings.Repeat("0", 64))),
				"tests switched on":         bytes.Replace(payloadA, []byte(`"run_tests":false`), []byte(`"run_tests":true`), 1),
				"check ID changed":          bytes.Replace(payloadA, []byte(check), []byte(strings.Repeat("a", 8)+check[8:]), 1),
				"recipient changed":         bytes.Replace(payloadA, []byte(a.id), []byte(b.id), 1),
				"check removed":             bytes.Replace(payloadA, []byte(`"validation":`), []byte(`"validatio_":`), 1),
				"one byte flipped anywhere": append([]byte{payloadA[0] ^ 1}, payloadA[1:]...),
			}
			for name, tampered := range mutations {
				if bytes.Equal(tampered, payloadA) {
					t.Fatalf("%s: the mutation changed nothing", name)
				}
				if signedFor(a, tampered, envelopeA) {
					t.Fatalf("%s: a tampered check passed the signature", name)
				}
			}
			if !signedFor(a, payloadA, envelopeA) {
				t.Fatal("the untouched payload no longer verifies")
			}
		})
		t.Run("a-candidate-is-fetched-only-by-its-own-device", func(t *testing.T) {
			status, body := fetch(a, digests[a.id])
			if status != 200 || fmt.Sprintf("%x", sha256.Sum256(body)) != digests[a.id] {
				t.Fatalf("a device cannot fetch its own candidate: %d", status)
			}
			if status, _ = fetch(b, digests[b.id]); status != 200 {
				t.Fatalf("second device cannot fetch its own candidate: %d", status)
			}
			for _, probe := range []struct {
				who    host
				digest string
				label  string
			}{
				{b, digests[a.id], "another device's candidate"},
				{a, digests[b.id], "another device's candidate (reverse)"},
				{c, digests[a.id], "a candidate of a check that did not address this device"},
				{c, digests[b.id], "a candidate of a check that did not address this device (second)"},
				{a, strings.Repeat("0", 64), "an unknown digest"},
			} {
				if status, _ = fetch(probe.who, probe.digest); status != 403 {
					t.Fatalf("%s: HTTP %d", probe.label, status)
				}
			}
			n, v, _ := h.req(h.tls, h.https, "GET", "/agent/v1/artifacts/"+digests[a.id], nil, "", "")
			expect(t, n, 401, v)
		})
		t.Run("answers-and-reads-are-scoped-and-change-nothing-else", func(t *testing.T) {
			// A device outside the check, and one answering for another, are ignored.
			result := map[string]any{"id": check, "valid": true, "diagnostics": []any{}, "tests": []any{}, "duration_ms": 5, "secrets_missing": []string{}}
			beatAs(c, nonce(21), map[string]any{"validation_result": result})
			n, v, _ := h.req(h.plain, h.http, "GET", "/api/v1/device-validations/"+check, nil, cookie, csrf)
			okay(t, n, v)
			for _, raw := range v["devices"].([]any) {
				if raw.(map[string]any)["state"] != "pending" {
					t.Fatalf("an answer from a device outside the check was recorded: %#v", v)
				}
			}
			// An oversized answer refuses the whole heartbeat, with nothing recorded.
			diagnostics := make([]any, 21)
			for i := range diagnostics {
				diagnostics[i] = map[string]any{"severity": "error", "code": "X", "message": "m"}
			}
			body := map[string]any{"validation_result": map[string]any{"id": check, "valid": false, "diagnostics": diagnostics}}
			for k, value := range beat {
				body[k] = value
			}
			n, rejected, _ := h.req(a.client, h.https, "POST", "/agent/v1/heartbeat", body, "", "")
			expect(t, n, 400, rejected)
			// Its own answer counts, ends the check for it, and withdraws its candidate.
			manifest, _, _ := beatAs(a, nonce(22), map[string]any{"validation_result": map[string]any{"id": check, "valid": false, "diagnostics": []any{map[string]any{"severity": "error", "code": "SECRET_BINDING_MISSING", "message": "A device secret is not bound."}}, "tests": []any{}, "duration_ms": 12, "secrets_missing": []string{"TOKEN"}}})
			if _, asked := manifest["validation"]; asked {
				t.Fatalf("an answered check is still in the manifest: %#v", manifest)
			}
			if status, _ := fetch(a, digests[a.id]); status != 403 {
				t.Fatalf("an answered check still authorizes its candidate: %d", status)
			}
			if status, _ := fetch(b, digests[b.id]); status != 200 {
				t.Fatalf("another device's pending check was affected by this answer: %d", status)
			}
			// Reads: the requester and an administrator; another operator, an editor and a viewer are refused.
			n, v, _ = h.req(h.plain, h.http, "GET", "/api/v1/device-validations/"+check, nil, cookie, csrf)
			okay(t, n, v)
			states := map[string]any{}
			for _, raw := range v["devices"].([]any) {
				entry := raw.(map[string]any)
				states[entry["id"].(string)] = entry["state"]
			}
			if states[a.id] != "failed" || states[b.id] != "pending" || v["state"] != "running" {
				t.Fatalf("states after one answer: %#v", v)
			}
			n, v, _ = h.api("GET", "/device-validations/"+check, nil)
			okay(t, n, v)
			read := func(who, role string) (int, map[string]any) {
				whoCookie, whoCSRF := login(who, role)
				n, v, _ := h.req(h.plain, h.http, "GET", "/api/v1/device-validations/"+check, nil, whoCookie, whoCSRF)
				return n, v
			}
			if n, v = read("second-operator", "operator"); n != 404 {
				t.Fatalf("another operator read a check they did not request: HTTP %d %#v", n, v)
			}
			for _, role := range []string{"viewer", "editor"} {
				if n, v = read("check-"+role, role); n != 403 {
					t.Fatalf("%s read a check: HTTP %d %#v", role, n, v)
				}
			}
			n, v, _ = h.req(h.plain, h.http, "GET", "/api/v1/device-validations/"+check, nil, "", "")
			expect(t, n, 401, v)
			// The audit event names the pipeline version and counts, never the configuration.
			n, v, _ = h.api("GET", "/audit/history?action=deployment.device_validation_requested", nil)
			okay(t, n, v)
			items, _ := v["items"].([]any)
			if len(items) != 1 {
				t.Fatalf("expected one audit event for the check: %#v", v)
			}
			n, v, _ = h.api("GET", "/audit/"+items[0].(map[string]any)["id"].(string), nil)
			okay(t, n, v)
			details := v["details"].(map[string]any)
			if details["validation_id"] != check || details["device_count"] != float64(2) || details["pending_count"] != float64(2) || strings.Contains(fmt.Sprint(v), "demo_logs") {
				t.Fatalf("audit event: %#v", v)
			}
		})
	})
	t.Run("wake-up-hint-is-authenticated-and-carries-no-state", func(t *testing.T) {
		n, v, _ := h.req(h.tls, h.https, "GET", "/agent/v1/wait?generation=0&policy_generation=0", nil, "", "")
		expect(t, n, 401, v)
		for _, query := range []string{"generation=0", "generation=0&policy_generation=0&device_id=admin", "generation=-1&policy_generation=0"} {
			n, v, _ = h.req(client, h.https, "GET", "/agent/v1/wait?"+query, nil, "", "")
			expect(t, n, 400, v)
		}
		manifest := func() map[string]any {
			n, envelope, _ := h.req(client, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
			okay(t, n, envelope)
			payload, _ := base64.StdEncoding.DecodeString(envelope["payload"].(string))
			var m map[string]any
			if err := json.Unmarshal(payload, &m); err != nil {
				t.Fatal(err)
			}
			return m
		}
		current := manifest()
		generation, policy := int(current["generation"].(float64)), int(current["policy_generation"].(float64))
		if generation < 1 {
			t.Fatalf("expected a released deployment: %#v", current)
		}
		// Generations the agent is behind on answer at once, with no state.
		n, v, _ = h.req(client, h.https, "GET", fmt.Sprintf("/agent/v1/wait?generation=%d&policy_generation=%d", generation-1, policy), nil, "", "")
		okay(t, n, v)
		if len(v) != 1 || v["changed"] != true {
			t.Fatalf("stale wait: %#v", v)
		}
		type answer struct {
			status int
			body   string
			at     time.Time
			err    error
		}
		answers := make(chan answer, 1)
		go func() {
			res, err := client.Get(fmt.Sprintf("%s/agent/v1/wait?generation=%d&policy_generation=%d", h.https, generation, policy))
			if err != nil {
				answers <- answer{err: err}
				return
			}
			defer res.Body.Close()
			body, err := io.ReadAll(io.LimitReader(res.Body, 4096))
			answers <- answer{res.StatusCode, string(body), time.Now(), err}
		}()
		select {
		case a := <-answers:
			t.Fatalf("a wait at current generations answered before any change: %+v", a)
		case <-time.After(700 * time.Millisecond):
		}
		config := map[string]any{"sources": map[string]any{"test": map[string]any{"type": "demo_logs", "format": "json", "interval": 2}}, "sinks": map[string]any{"discard": map[string]any{"type": "blackhole", "inputs": []string{"test"}}}}
		n, created, _ := h.api("POST", "/configurations", map[string]any{"name": "isolated wake-up fixture", "description": "test only", "graph": map[string]any{"nodes": []any{}, "edges": []any{}}, "config": config})
		okay(t, n, created)
		n, version, _ := h.api("POST", "/configurations/"+created["id"].(string)+"/publish", map[string]any{"revision": created["revision"], "message": "wake-up test"})
		okay(t, n, version)
		n, v, _ = h.api("POST", "/deployments", map[string]any{"version_id": version["id"], "priority": 2, "target_mode": "snapshot", "selector": map[string]any{"device_ids": []string{device["device_id"].(string)}, "group_ids": []string{}, "exclude_ids": []string{}}, "rollout": map[string]any{"kind": "all", "canary_size": 1, "batch_size": 10, "observation_seconds": 0, "failure_threshold": 0}})
		okay(t, n, v)
		deployed := time.Now()
		select {
		case a := <-answers:
			if a.err != nil || a.status != 200 || a.body != `{"changed":true}` {
				t.Fatalf("parked wait: %+v", a)
			}
			if late := a.at.Sub(deployed); late > 2*time.Second {
				t.Fatalf("the parked wait answered %v after the deployment", late)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the deployment never answered the parked wait")
		}
		// The change itself arrives only through the signed manifest.
		if next := manifest(); int(next["generation"].(float64)) <= generation || next["desired"].(map[string]any)["version_id"] != version["id"] {
			t.Fatalf("manifest after the wake-up: %#v", next)
		}
	})
	t.Run("silent-connections-do-not-delay-a-mutually-authenticated-request", func(t *testing.T) {
		address := strings.TrimPrefix(h.https, "https://")
		var idle []net.Conn
		defer func() {
			for _, c := range idle {
				c.Close()
			}
		}()
		for i := 0; i < 200; i++ {
			c, err := net.DialTimeout("tcp", address, 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			idle = append(idle, c)
		}
		time.Sleep(300 * time.Millisecond)
		// A new connection: the device's pooled ones finished their handshakes long ago.
		fresh := h.client(device, key)
		fresh.Timeout = 2 * time.Second
		defer fresh.CloseIdleConnections()
		started := time.Now()
		body, _ := json.Marshal(beat)
		res, err := fresh.Post(h.https+"/agent/v1/heartbeat", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("a mutually authenticated request failed after %v behind %d silent connections: %v", time.Since(started), len(idle), err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		expect(t, res.StatusCode, 200, nil)
		// A connection that sends nothing is closed long before the ten seconds a handshake may take.
		idle[0].SetReadDeadline(time.Now().Add(6 * time.Second))
		if _, err := idle[0].Read(make([]byte, 1)); err == nil {
			t.Fatal("the server sent bytes to a connection that never spoke")
		} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Fatal("a silent connection was still open after six seconds")
		}
	})
	t.Run("one-address-cannot-lock-enrollment-or-the-installer-for-others", func(t *testing.T) {
		noisy := h.from(t, "127.0.0.2")
		defer noisy.CloseIdleConnections()
		junk, _ := json.Marshal(map[string]any{"protocol_version": 1, "token": strings.Repeat("0", 64)})
		limited := 0
		for i := 0; i < 700; i++ {
			if status(t, noisy, "POST", h.https+"/agent/v1/enroll", junk) == 429 {
				limited++
			}
		}
		if limited == 0 {
			t.Fatal("the enrollment flood was never limited")
		}
		limited = 0
		for i := 0; i < 1250; i++ {
			if status(t, noisy, "GET", h.https+"/agent/v1/install.sh", nil) == 429 {
				limited++
			}
		}
		if limited == 0 {
			t.Fatal("the installer flood was never limited")
		}
		// Another host still enrolls and installs.
		after := h.token(map[string]any{"name": "after-a-flood", "expires_hours": 1, "max_uses": 1})
		_, afterCSR := keyCSR(t)
		n, v := h.enroll(after, "after-a-flood-host", fmt.Sprintf("%x", serial()), afterCSR)
		okay(t, n, v)
		if code := status(t, h.tls, "GET", h.https+"/agent/v1/install.sh", nil); code != 200 {
			t.Fatalf("install.sh answered %d for another address after one address flooded it", code)
		}
	})
	t.Run("refused-enrollments-with-a-real-token-are-recorded-once-per-reason", func(t *testing.T) {
		host := h.from(t, "127.0.0.3")
		defer host.CloseIdleConnections()
		n, created, _ := h.api("POST", "/tokens", map[string]any{"name": "audit-dedupe", "expires_hours": 1, "max_uses": 5})
		okay(t, n, created)
		secret, id := created["token"].(string), created["record"].(map[string]any)["id"].(string)
		n, v, _ := h.api("POST", "/tokens/"+id+"/revoke", map[string]any{})
		okay(t, n, v)
		_, csr := keyCSR(t)
		for i := 0; i < 50; i++ {
			body, _ := json.Marshal(map[string]any{"protocol_version": 1, "request_id": fmt.Sprintf("%x", serial()), "token": secret, "name": "audit-host", "csr_pem": csr, "os": "linux", "arch": "amd64", "agent_version": "security-test", "vector_version": "0.58.0"})
			if code := status(t, host, "POST", h.https+"/agent/v1/enroll", body); code != 401 {
				t.Fatalf("attempt %d: HTTP %d", i, code)
			}
		}
		n, activity, _ := h.api("GET", "/agent-install/activity?since="+url.QueryEscape(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)), nil)
		okay(t, n, activity)
		rows := 0
		for _, raw := range activity["events"].([]any) {
			event := raw.(map[string]any)
			if event["token_id"] == id && event["outcome"] == "failure" {
				rows++
			}
		}
		if rows == 0 || rows > 3 {
			t.Fatalf("50 refused attempts left %d audit rows for the token", rows)
		}
	})
	t.Run("revoked-pooled-connection-rejected", func(t *testing.T) {
		n, v, _ := h.api("POST", "/devices/"+device["device_id"].(string)+"/revoke", map[string]any{})
		okay(t, n, v)
		body, _ := json.Marshal(beat)
		request, _ := http.NewRequest("POST", h.https+"/agent/v1/heartbeat", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		reused := false
		request = request.WithContext(httptrace.WithClientTrace(request.Context(), &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { reused = info.Reused }}))
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if !reused {
			t.Fatal("test did not exercise a pooled connection")
		}
		expect(t, response.StatusCode, 401, nil)
		n, rejected, _ := h.req(client, h.https, "GET", "/agent/v1/wait?generation=0&policy_generation=0", nil, "", "")
		expect(t, n, 401, rejected)
	})
	t.Run("authorized-device-recovery-is-new-unmanaged-identity", func(t *testing.T) {
		n, recovery, _ := h.api("POST", "/devices/"+device["device_id"].(string)+"/recover", map[string]any{})
		okay(t, n, recovery)
		secret := recovery["token"].(string)
		newKey, csr := keyCSR(t)
		n, rejected := h.enroll(secret, "wrong-recovery-name", fmt.Sprintf("%x", serial()), csr)
		if n < 400 {
			t.Fatal("recovery token permitted another name", rejected)
		}
		n, replacement := h.enroll(secret, "sec-one", fmt.Sprintf("%x", serial()), csr)
		okay(t, n, replacement)
		if replacement["device_id"] == device["device_id"] {
			t.Fatal("recovery reused old identity")
		}
		replacementClient := h.client(replacement, newKey)
		defer replacementClient.CloseIdleConnections()
		n, envelope, _ := h.req(replacementClient, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
		okay(t, n, envelope)
		payload, _ := base64.StdEncoding.DecodeString(envelope["payload"].(string))
		var manifest map[string]any
		if err := json.Unmarshal(payload, &manifest); err != nil {
			t.Fatal(err)
		}
		if manifest["desired"] != nil || manifest["generation"] != float64(0) || manifest["device_id"] != replacement["device_id"] {
			t.Fatal("recovery inherited assignment or generation", manifest)
		}
		n, rejected = h.enroll(secret, "sec-one", fmt.Sprintf("%x", serial()), csr)
		if n < 400 {
			t.Fatal("recovery token reused", rejected)
		}
		n, rejected, _ = h.req(client, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
		expect(t, n, 401, rejected)
		n, rejected, _ = h.api("POST", "/devices/"+device["device_id"].(string)+"/recover", map[string]any{})
		expect(t, n, 409, rejected)
	})
	t.Run("mfa-replay-recovery-and-session-boundaries", func(t *testing.T) {
		email, password := "mfa-security@example.invalid", "test-only-password-89374"
		n, user, _ := h.api("POST", "/users", map[string]any{"email": email, "name": "MFA fixture", "role": "viewer", "password": password})
		okay(t, n, user)
		login := func(extra map[string]any) (int, map[string]any, http.Header) {
			body := map[string]any{"email": email, "password": password}
			for key, value := range extra {
				body[key] = value
			}
			return h.req(h.plain, h.http, "POST", "/api/v1/login", body, "", "")
		}
		n, session, headers := login(nil)
		okay(t, n, session)
		cookie, csrf := strings.Split(headers.Get("Set-Cookie"), ";")[0], session["csrf_token"].(string)
		n, olderSession, olderHeaders := login(nil)
		okay(t, n, olderSession)
		olderCookie := strings.Split(olderHeaders.Get("Set-Cookie"), ";")[0]
		n, enrollment, _ := h.req(h.plain, h.http, "POST", "/api/v1/mfa/setup", map[string]any{"password": password}, cookie, csrf)
		okay(t, n, enrollment)
		secret := enrollment["secret"].(string)
		confirmation := totpCode(t, secret, time.Now().Add(-30*time.Second))
		n, confirmed, _ := h.req(h.plain, h.http, "POST", "/api/v1/mfa/confirm", map[string]any{"code": confirmation}, cookie, csrf)
		okay(t, n, confirmed)
		codes, ok := confirmed["recovery_codes"].([]any)
		if !ok || len(codes) != 8 {
			t.Fatal("missing one-time recovery codes")
		}
		n, denied, _ := h.req(h.plain, h.http, "GET", "/api/v1/session", nil, olderCookie, "")
		expect(t, n, 401, denied)
		// Password-only sign-in now yields a staged MFA challenge, never a session.
		n, challenged, challengeHeaders := login(nil)
		okay(t, n, challenged)
		if challenged["mfa_required"] != true || challenged["csrf_token"] != nil || challengeHeaders.Get("Set-Cookie") != "" {
			t.Fatalf("password-only sign-in must return only an MFA challenge: %#v", challenged)
		}
		n, denied, _ = login(map[string]any{"totp_code": confirmation})
		expect(t, n, 401, denied)
		current := totpCode(t, secret, time.Now())
		n, success, _ := login(map[string]any{"totp_code": current})
		okay(t, n, success)
		n, denied, _ = login(map[string]any{"totp_code": current})
		expect(t, n, 401, denied)
		n, success, recoveryHeaders := login(map[string]any{"recovery_code": codes[0]})
		okay(t, n, success)
		recoveryCookie := strings.Split(recoveryHeaders.Get("Set-Cookie"), ";")[0]
		n, denied, _ = login(map[string]any{"recovery_code": codes[0]})
		expect(t, n, 401, denied)
		// A wrong re-authentication password is 403 WRONG_PASSWORD, not 401:
		// the session stays valid and must not look ended to the client.
		n, denied, _ = h.req(h.plain, h.http, "POST", "/api/v1/mfa/disable", map[string]any{"password": "incorrect", "recovery_code": codes[1]}, cookie, csrf)
		expect(t, n, 403, denied)
		if denied["error"].(map[string]any)["code"] != "WRONG_PASSWORD" {
			t.Fatalf("wrong password must be reported as WRONG_PASSWORD: %#v", denied)
		}
		n, disabled, _ := h.req(h.plain, h.http, "POST", "/api/v1/mfa/disable", map[string]any{"password": password, "recovery_code": codes[1]}, cookie, csrf)
		okay(t, n, disabled)
		n, denied, _ = h.req(h.plain, h.http, "GET", "/api/v1/session", nil, recoveryCookie, "")
		expect(t, n, 401, denied)
	})
}

// Running out of file descriptors makes accept fail. The server keeps running,
// says so in its log, and answers again once descriptors are free.
func TestDescriptorExhaustionDoesNotEndTheServer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a descriptor limit is a POSIX setting")
	}
	s := newServer(t)
	s.descriptors = 80
	s.start()
	h := s.h
	address := strings.TrimPrefix(h.https, "https://")
	// Once the accept queue is full a connect waits, so stop at a few refusals.
	var held []net.Conn
	refused := 0
	for i := 0; i < 300 && refused < 5; i++ {
		if c, err := net.DialTimeout("tcp", address, 300*time.Millisecond); err == nil {
			held = append(held, c)
			refused = 0
		} else {
			refused++
		}
	}
	time.Sleep(2 * time.Second)
	for _, c := range held {
		c.Close()
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		res, err := h.plain.Get(h.http + "/api/v1/status")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the server stopped answering after it ran out of descriptors")
		}
		time.Sleep(200 * time.Millisecond)
	}
	log, _ := os.ReadFile(filepath.Join(s.dir, "server.log"))
	if !strings.Contains(string(log), "os error 24") || !strings.Contains(string(log), "could not accept a connection") {
		t.Fatalf("the test never ran the server out of descriptors, or the listener said nothing: %s", log)
	}
}

// Device CA rotation with the real vectory-admin tool: refused while the
// server runs; devices on the old CA keep working and renew onto the new one;
// the manifest signing trust is unchanged; a forgery chained to neither CA is
// refused; retiring waits for the devices that still hold old certificates;
// afterwards the old CA's certificates are refused at TLS.
func TestDeviceCARotationWithTheAdminTool(t *testing.T) {
	s := newServer(t)
	s.start()
	h := s.h
	n, v, headers := h.api("POST", "/bootstrap", map[string]any{"bootstrap_secret": h.bootstrap, "email": "rotation-admin@example.invalid", "name": "Rotation test", "password": "test-only-password-29843"})
	okay(t, n, v)
	h.cookie = strings.Split(headers.Get("Set-Cookie"), ";")[0]
	h.csrf = v["csrf_token"].(string)
	fingerprint := func(text string) string {
		block, _ := pem.Decode([]byte(text))
		if block == nil {
			t.Fatalf("not a PEM certificate: %q", text)
		}
		return fmt.Sprintf("%x", sha256.Sum256(block.Bytes))
	}
	issuer := func(text string) string {
		block, _ := pem.Decode([]byte(text))
		certificate, e := x509.ParseCertificate(block.Bytes)
		if e != nil {
			t.Fatal(e)
		}
		return certificate.Issuer.String()
	}
	nonce := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	beat := map[string]any{"protocol_version": 1, "request_id": "rotation", "nonce": nonce, "boot_id": "rotation", "agent_version": "security-test", "vector_version": "0.58.0", "reported_generation": 0, "policy_generation": 0, "actual_sha256": "", "apply_state": "unmanaged", "local_paused": false, "remote_pause_acknowledged": false}
	// Go's TLS client withholds a certificate whose issuer the server doesn't
	// advertise, so an attacker's client always presents it: the server's own
	// verifier must refuse it.
	checkIn := func(credentials map[string]any, key []byte) (int, map[string]any, error) {
		pair, e := tls.X509KeyPair([]byte(credentials["certificate_pem"].(string)), key)
		if e != nil {
			t.Fatal(e)
		}
		client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: h.roots, MinVersion: tls.VersionTLS13, GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return &pair, nil }}}}
		defer client.CloseIdleConnections()
		body, _ := json.Marshal(beat)
		request, _ := http.NewRequest("POST", h.https+"/agent/v1/heartbeat", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response, e := client.Do(request)
		if e != nil {
			return 0, nil, e
		}
		defer response.Body.Close()
		var out map[string]any
		json.NewDecoder(response.Body).Decode(&out)
		return response.StatusCode, out, nil
	}
	token := h.token(map[string]any{"name": "rotation", "expires_hours": 1, "max_uses": 10})
	keyA, csrA := keyCSR(t)
	n, a := h.enroll(token, "rot-a", fmt.Sprintf("%x", serial()), csrA)
	okay(t, n, a)
	keyB, csrB := keyCSR(t)
	n, b := h.enroll(token, "rot-b", fmt.Sprintf("%x", serial()), csrB)
	okay(t, n, b)
	oldCA, signing := fingerprint(a["ca_pem"].(string)), a["signing_public_key"].(string)
	signedBy := func(envelope map[string]any) bool {
		payload, _ := base64.StdEncoding.DecodeString(envelope["payload"].(string))
		signature, _ := base64.StdEncoding.DecodeString(envelope["signature"].(string))
		public, _ := base64.StdEncoding.DecodeString(signing)
		return ed25519.Verify(public, payload, signature)
	}

	if out, code := s.adminTool("rotate-device-ca"); code != 1 || !strings.Contains(out, "still running") {
		t.Fatalf("rotation ran next to a live server: %d %s", code, out)
	}
	s.stop()
	out, code := s.adminTool("rotate-device-ca")
	current := regexp.MustCompile(`Current CA   sha256 ([0-9a-f]{64})`).FindStringSubmatch(out)
	if code != 0 || current == nil || !strings.Contains(out, "Previous CA  sha256 "+oldCA) || !strings.Contains(out, "2 devices hold certificates from the previous CA") {
		t.Fatalf("rotate-device-ca: %d %s", code, out)
	}
	newCA := current[1]
	if out, code := s.adminTool("rotate-device-ca"); code != 1 || !strings.Contains(out, "Retire it first") {
		t.Fatalf("a second overlap was started: %d %s", code, out)
	}
	s.start()

	// Overlap: both old-CA devices keep working under the same signing key.
	for _, device := range []struct {
		credentials map[string]any
		key         []byte
	}{{a, keyA}, {b, keyB}} {
		n, envelope, e := checkIn(device.credentials, device.key)
		if e != nil || n != 200 || !signedBy(envelope) {
			t.Fatalf("an old-CA device stopped working during the overlap: %d %v %#v", n, e, envelope)
		}
		// The agent's own transport offers its certificate only for a CA the
		// server names in its request: the previous CA is named during the overlap.
		agentLike := h.client(device.credentials, device.key)
		n, envelope, _ = h.req(agentLike, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
		agentLike.CloseIdleConnections()
		if n != 200 || !signedBy(envelope) {
			t.Fatalf("an agent-like client on the old CA stopped working during the overlap: %d %#v", n, envelope)
		}
	}
	// A forgery chained to neither CA, named like the original CA, is refused.
	attackerKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	attackerTemplate := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Vectory device CA"}, IsCA: true, BasicConstraintsValid: true, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageCertSign}
	attackerDER, _ := x509.CreateCertificate(rand.Reader, attackerTemplate, attackerTemplate, &attackerKey.PublicKey, attackerKey)
	attackerCA, _ := x509.ParseCertificate(attackerDER)
	forgedKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	forgedDER, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: a["device_id"].(string)}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}, attackerCA, &forgedKey.PublicKey, attackerKey)
	forgedPKCS8, _ := x509.MarshalPKCS8PrivateKey(forgedKey)
	forged := map[string]any{"certificate_pem": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: forgedDER}))}
	forgedKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: forgedPKCS8})
	if n, _, e := checkIn(forged, forgedKeyPEM); e == nil {
		t.Fatalf("a certificate from an unknown CA passed TLS: HTTP %d", n)
	}
	// Renewal moves a device onto the new CA; signing trust is unchanged.
	nextKey, nextCSR := keyCSR(t)
	clientB := h.client(b, keyB)
	n, renewed, _ := h.req(clientB, h.https, "POST", "/agent/v1/renew", map[string]any{"csr_pem": nextCSR}, "", "")
	clientB.CloseIdleConnections()
	okay(t, n, renewed)
	if fingerprint(renewed["ca_pem"].(string)) != newCA || renewed["signing_public_key"] != signing || issuer(renewed["certificate_pem"].(string)) == issuer(b["certificate_pem"].(string)) {
		t.Fatalf("renewal did not move the device onto the new CA: %#v", renewed)
	}
	if n, envelope, e := checkIn(renewed, nextKey); e != nil || n != 200 || !signedBy(envelope) {
		t.Fatalf("the renewed certificate does not work: %d %v", n, e)
	}
	keyC, csrC := keyCSR(t)
	n, c := h.enroll(token, "rot-c", fmt.Sprintf("%x", serial()), csrC)
	okay(t, n, c)
	if fingerprint(c["ca_pem"].(string)) != newCA {
		t.Fatal("a device enrolled during the overlap got a certificate from the old CA")
	}
	n, settings, _ := h.api("GET", "/settings", nil)
	okay(t, n, settings)
	status := settings["device_ca"].(map[string]any)
	previous, _ := status["previous"].(map[string]any)
	if status["current"].(map[string]any)["sha256"] != newCA || previous == nil || previous["sha256"] != oldCA || previous["devices"] != float64(2) || fmt.Sprint(previous["device_names"]) != "[rot-a rot-b]" {
		t.Fatalf("device CA status: %#v", status)
	}

	// Retiring waits for both devices: A never renewed, and B's old
	// certificate stays valid for a day after its renewal.
	s.stop()
	for _, args := range [][]string{{"retire-device-ca"}, {"retire-device-ca", "--apply"}} {
		if out, code := s.adminTool(args...); code != 1 || !strings.Contains(out, "2 devices still hold certificates it issued: rot-a, rot-b") {
			t.Fatalf("%v retired while devices remained: %d %s", args, code, out)
		}
	}
	if out, code := s.adminTool("device-ca-status"); code != 0 || !strings.Contains(out, "sha256 "+newCA) || !strings.Contains(out, "2 devices still hold certificates from the previous CA") {
		t.Fatalf("device-ca-status: %d %s", code, out)
	}
	s.start()
	for _, device := range []map[string]any{a, b} {
		n, v, _ := h.api("POST", "/devices/"+device["device_id"].(string)+"/revoke", map[string]any{})
		okay(t, n, v)
	}
	s.stop()
	if out, code := s.adminTool("retire-device-ca"); code != 0 || !strings.Contains(out, "Ready") {
		t.Fatalf("retire check: %d %s", code, out)
	}
	if out, code := s.adminTool("retire-device-ca", "--apply"); code != 0 || !strings.Contains(out, "Retired the previous device CA (sha256 "+oldCA) {
		t.Fatalf("retire: %d %s", code, out)
	}
	s.start()

	// The old CA's certificates are refused at TLS; the new CA's pass TLS,
	// and revocation still decides after that. An agent-like client that
	// withholds the retired certificate is simply unauthenticated.
	if n, _, e := checkIn(a, keyA); e == nil {
		t.Fatalf("a certificate from the retired CA passed TLS: HTTP %d", n)
	}
	agentLike := h.client(a, keyA)
	n, v, _ = h.req(agentLike, h.https, "POST", "/agent/v1/heartbeat", beat, "", "")
	agentLike.CloseIdleConnections()
	expect(t, n, 401, v)
	if n, _, e := checkIn(renewed, nextKey); e != nil || n != 401 {
		t.Fatalf("a revoked device's new-CA certificate: %d %v", n, e)
	}
	if n, envelope, e := checkIn(c, keyC); e != nil || n != 200 || !signedBy(envelope) {
		t.Fatalf("a new-CA device stopped working after retirement: %d %v", n, e)
	}
	n, settings, _ = h.api("GET", "/settings", nil)
	okay(t, n, settings)
	if settings["device_ca"].(map[string]any)["previous"] != nil {
		t.Fatalf("a retired CA is still reported: %#v", settings["device_ca"])
	}
}
