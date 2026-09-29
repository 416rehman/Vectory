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
func setup(t *testing.T) *harness {
	binary := os.Getenv("VECTORY_SECURITY_SERVER")
	if binary == "" {
		t.Skip("native server security suite requires VECTORY_SECURITY_SERVER; not a passing native gate")
	}
	dir := t.TempDir()
	// Copy the input so native Windows tests do not hold the developer's build
	// output open or accidentally switch revisions during a concurrent rebuild.
	binaryBytes, copyError := os.ReadFile(binary)
	if copyError != nil {
		t.Fatal(copyError)
	}
	t.Logf("native server sha256=%x", sha256.Sum256(binaryBytes))
	binary = filepath.Join(dir, filepath.Base(binary))
	if copyError = os.WriteFile(binary, binaryBytes, 0700); copyError != nil {
		t.Fatal(copyError)
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
	certPath, keyPath, secretPath := filepath.Join(dir, "server.pem"), filepath.Join(dir, "key.pem"), filepath.Join(dir, "bootstrap")
	for p, b := range map[string][]byte{certPath: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), keyPath: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})} {
		if e = os.WriteFile(p, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	secret := fmt.Sprintf("%x", serial().Bytes()) + fmt.Sprintf("%x", serial().Bytes())
	if e = os.WriteFile(secretPath, []byte(secret), 0600); e != nil {
		t.Fatal(e)
	}
	httpAddr, tlsAddr := freePort(t), freePort(t)
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
	h := &harness{t: t, http: "http://" + httpAddr, https: "https://" + tlsAddr, plain: &http.Client{Timeout: 10 * time.Second}, tls: &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}}, bootstrap: secret, roots: roots}
	log, e := os.Create(filepath.Join(dir, "server.log"))
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command(binary)
	cmd.Env = append(os.Environ(), "VECTORY_DATA_DIR="+filepath.Join(dir, "state"), "VECTORY_HTTP_ADDR="+httpAddr, "VECTORY_AGENT_ADDR="+tlsAddr, "VECTORY_TLS_CERT="+certPath, "VECTORY_TLS_KEY="+keyPath, "VECTORY_BOOTSTRAP_SECRET_FILE="+secretPath, "VECTORY_COOKIE_SECURE=false", "VECTORY_DEVELOPMENT=true", "VECTORY_DASHBOARD_DIR="+dir, "VECTORY_RELEASES_DIR="+filepath.Join(dir, "releases"))
	cmd.Stdout = log
	cmd.Stderr = log
	if e = cmd.Start(); e != nil {
		log.Close()
		t.Fatal(e)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
		log.Close()
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(dir, "server.log"))
			t.Logf("server diagnostics: %s", data)
		}
	})
	ready := false
	for i := 0; i < 100; i++ {
		res, e := h.plain.Get(h.http + "/api/v1/status")
		if e == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		t.Fatal("isolated server did not become ready")
	}
	return h
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
func (h *harness) client(v map[string]any, key []byte) *http.Client {
	pair, e := tls.X509KeyPair([]byte(v["certificate_pem"].(string)), key)
	if e != nil {
		h.t.Fatal(e)
	}
	return &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: h.roots, MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{pair}}}}
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
