package agent

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// connectProxy is a forward proxy of the kind an enterprise runs: it takes
// CONNECT requests and tunnels TLS to a server it resolves itself. It can ask
// for a password, refuse everything, or answer for the server with a
// certificate of its own, as a proxy that inspects TLS does.
type connectProxy struct {
	listener net.Listener
	// routes maps the host:port a client asks for to the address to dial.
	routes map[string]string
	// auth is the Proxy-Authorization value every CONNECT must carry; empty
	// asks for no sign-in.
	auth string
	// deny answers every CONNECT with 403.
	deny bool
	// inspect answers for the server with this certificate instead of passing
	// the connection on.
	inspect *tls.Config

	mu       sync.Mutex
	connects []proxyConnect
	// inspected counts TLS handshakes the client completed with the proxy's own
	// certificate, and requests the requests it then sent.
	inspected, requests atomic.Int32
}

type proxyConnect struct{ target, authorization string }

func startConnectProxy(t *testing.T, routes map[string]string) *connectProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &connectProxy{listener: listener, routes: routes}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go p.serve(conn)
		}
	}()
	return p
}

func (p *connectProxy) address() string { return p.listener.Addr().String() }

// url is the HTTPS_PROXY value for this proxy, with sign-in when given.
func (p *connectProxy) url(user, password string) string {
	if user == "" {
		return "http://" + p.address()
	}
	return "http://" + url.UserPassword(user, password).String() + "@" + p.address()
}

func (p *connectProxy) seen() []proxyConnect {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]proxyConnect(nil), p.connects...)
}

func (p *connectProxy) serve(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	request, err := http.ReadRequest(reader)
	if err != nil || request.Method != http.MethodConnect {
		return
	}
	p.mu.Lock()
	p.connects = append(p.connects, proxyConnect{target: request.Host, authorization: request.Header.Get("Proxy-Authorization")})
	p.mu.Unlock()
	switch {
	case p.auth != "" && request.Header.Get("Proxy-Authorization") != p.auth:
		fmt.Fprint(conn, "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\n\r\n")
		return
	case p.deny:
		fmt.Fprint(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
		return
	}
	target, routed := p.routes[request.Host]
	if !routed && p.inspect == nil {
		fmt.Fprint(conn, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
		return
	}
	fmt.Fprint(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	if p.inspect != nil {
		tlsConn := tls.Server(conn, p.inspect)
		if tlsConn.Handshake() != nil {
			return
		}
		p.inspected.Add(1)
		if _, err := http.ReadRequest(bufio.NewReader(tlsConn)); err == nil {
			p.requests.Add(1)
		}
		return
	}
	upstream, err := net.Dial("tcp", target)
	if err != nil {
		return
	}
	defer upstream.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, reader); done <- struct{}{} }()
	go func() { _, _ = io.Copy(conn, upstream); done <- struct{}{} }()
	<-done
}

// leafFor is a certificate ca issued for the names.
func leafFor(t *testing.T, ca testCA, names ...string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: names, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der, ca.cert.Raw}, PrivateKey: key}
}

// proxiedServer is a Vectory server that only a proxy can reach by name: the
// agent is given a host name that resolves nowhere, and the proxy knows where
// it is.
type proxiedServer struct {
	*setupServer
	// origin is what the agent is told, host what the proxy is asked for.
	origin, host string
	routes       map[string]string
}

func newProxiedServer(t *testing.T) *proxiedServer {
	t.Helper()
	server := newSetupServerFor(t, []string{"vectory.test"})
	address, err := url.Parse(server.url)
	if err != nil {
		t.Fatal(err)
	}
	host := "vectory.test:" + address.Port()
	return &proxiedServer{setupServer: server, origin: "https://" + host, host: host, routes: map[string]string{host: address.Host}}
}

// runAgent runs the agent's own code in a child process whose environment
// names proxyURL as HTTPS_PROXY, and returns what it reports.
func runAgent(t *testing.T, proxyURL string, request proxyClientRequest) proxyClientResult {
	t.Helper()
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
	for _, entry := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if !strings.HasSuffix(name, "_PROXY") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, proxyClientEnv+"="+string(raw))
	if proxyURL != "" {
		cmd.Env = append(cmd.Env, "HTTPS_PROXY="+proxyURL)
	}
	out, err := cmd.Output()
	if err != nil {
		var stderr []byte
		if exit, ok := err.(*exec.ExitError); ok {
			stderr = exit.Stderr
		}
		t.Fatalf("the agent process failed: %v\n%s", err, stderr)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var result proxyClientResult
	if err = json.Unmarshal([]byte(lines[len(lines)-1]), &result); err != nil {
		t.Fatalf("the agent process said %q: %v", out, err)
	}
	return result
}

// requireNothingOf fails if any file under dir holds one of the secrets.
func requireNothingOf(t *testing.T, dir string, secrets ...string) {
	t.Helper()
	_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		content, _ := os.ReadFile(path)
		for _, secret := range secrets {
			if strings.Contains(string(content), secret) {
				t.Errorf("%s holds %q", filepath.Base(path), secret)
			}
		}
		return nil
	})
}

func fingerprintOfPEMFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatalf("%s holds no certificate", path)
	}
	sum := sha256.Sum256(block.Bytes)
	return hex.EncodeToString(sum[:])
}

func normalizedPin(pin string) string {
	return strings.ToLower(strings.ReplaceAll(pin, ":", ""))
}

// Enrollment and check-ins reach the server through a CONNECT proxy, with and
// without sign-in, exactly as they do directly: the server's CA is verified
// against the pin through the tunnel, the token and the device certificate
// travel inside it, and the proxy never sees them.
func TestEnrollmentAndCheckInGoThroughAConnectProxy(t *testing.T) {
	const user, password = "agent-proxy-user", "proxy-pass-do-not-leak"
	for _, test := range []struct {
		name         string
		authenticate bool
	}{{"without sign-in", false}, {"with sign-in", true}} {
		t.Run(test.name, func(t *testing.T) {
			server := newProxiedServer(t)
			proxy := startConnectProxy(t, server.routes)
			proxyURL := proxy.url("", "")
			if test.authenticate {
				proxy.auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
				proxyURL = proxy.url(user, password)
			}
			dir := filepath.Join(privateTempDir(t), "state")
			result := runAgent(t, proxyURL, proxyClientRequest{Action: "enroll", Server: server.origin, Pin: server.pin, Dir: dir, Name: "proxied-edge", Token: "synthetic-setup-token"})
			if !result.Enrolled || !result.CheckedIn || result.Error != "" {
				t.Fatalf("enrollment and check-in through the proxy: %+v", result)
			}
			if server.enrolls.Load() != 1 || server.authenticated.Load() < 1 {
				t.Fatalf("the server saw %d enrollments and %d authenticated check-ins", server.enrolls.Load(), server.authenticated.Load())
			}
			// The pin held through the tunnel: the CA saved for later
			// connections is the pinned one.
			if got := fingerprintOfPEMFile(t, filepath.Join(dir, ServerCAFile)); got != normalizedPin(server.pin) {
				t.Fatalf("saved CA %s is not the pinned %s", got, normalizedPin(server.pin))
			}
			connects := proxy.seen()
			if len(connects) < 3 {
				t.Fatalf("the pin check, the enrollment and the check-in should each open a tunnel: %+v", connects)
			}
			want := ""
			if test.authenticate {
				want = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
			}
			for _, connect := range connects {
				if connect.target != server.host || connect.authorization != want {
					t.Fatalf("a tunnel asked for %q with %q", connect.target, connect.authorization)
				}
			}
			// Neither the proxy password nor the token is kept anywhere.
			requireNothingOf(t, dir, password, "synthetic-setup-token")
			if strings.Contains(result.Message+result.Fix+result.Error, password) {
				t.Fatal("the proxy password was printed")
			}
		})
	}
}

// A proxy that refuses, wants a password the agent doesn't have or has wrong,
// or isn't there is named in the diagnostic, with what to do. Nothing is
// enrolled, no token is sent, and no password is ever printed.
func TestProxyThatRefusesOrNeedsSignInIsNamed(t *testing.T) {
	const wrong = "wrong-proxy-password"
	unreachable := func(t *testing.T) string {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		address := listener.Addr().String()
		listener.Close()
		return address
	}
	for _, test := range []struct {
		name   string
		setup  func(t *testing.T, p *connectProxy) string
		code   string
		says   []string
		absent string
	}{
		{name: "refuses the server",
			setup: func(t *testing.T, p *connectProxy) string { p.deny = true; return p.url("", "") },
			code:  "PROXY_REFUSED", says: []string{"refused to connect to vectory.test:", "Forbidden", "NO_PROXY"}},
		{name: "needs a password the agent lacks",
			setup: func(t *testing.T, p *connectProxy) string { p.auth = "Basic x"; return p.url("", "") },
			code:  "PROXY_AUTH_REQUIRED", says: []string{"requires a user name and password", "HTTPS_PROXY to http://USER:PASSWORD@"}},
		{name: "rejects the password in HTTPS_PROXY",
			setup:  func(t *testing.T, p *connectProxy) string { p.auth = "Basic x"; return p.url("agent", wrong) },
			code:   "PROXY_AUTH_REQUIRED",
			says:   []string{"did not accept the user name and password in HTTPS_PROXY", "percent-encode"},
			absent: wrong},
		{name: "is not running",
			setup: func(t *testing.T, p *connectProxy) string { return "http://" + unreachable(t) },
			code:  "PROXY_UNREACHABLE", says: []string{"Can't reach the proxy at 127.0.0.1:", "HTTPS_PROXY"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := newProxiedServer(t)
			proxy := startConnectProxy(t, server.routes)
			proxyURL := test.setup(t, proxy)
			dir := filepath.Join(privateTempDir(t), "state")
			result := runAgent(t, proxyURL, proxyClientRequest{Action: "enroll", Server: server.origin, Pin: server.pin, Dir: dir, Name: "proxied-edge", Token: "synthetic-setup-token"})
			if result.Enrolled || result.CheckedIn || result.Code != test.code {
				t.Fatalf("expected %s, got %+v", test.code, result)
			}
			text := result.Message + " " + result.Fix
			for _, says := range test.says {
				if !strings.Contains(text, says) {
					t.Fatalf("the diagnostic doesn't say %q:\n%s", says, text)
				}
			}
			if test.name != "is not running" && !strings.Contains(text, strings.TrimPrefix(proxy.address(), "")) {
				t.Fatalf("the diagnostic doesn't name the proxy %s:\n%s", proxy.address(), text)
			}
			if test.absent != "" && strings.Contains(result.Error+text, test.absent) {
				t.Fatal("the proxy password was printed")
			}
			if server.enrolls.Load() != 0 {
				t.Fatal("the token reached the server")
			}
			for _, name := range []string{"identity.json", "credentials.json", ServerCAFile} {
				if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
					t.Fatalf("%s exists after a failed enrollment", name)
				}
			}
			requireNothingOf(t, dir, "synthetic-setup-token", wrong)
		})
	}
}

// A proxy that inspects TLS answers for the server with a certificate of its
// own. The pin rejects it, the diagnostic names the proxy, and the token and
// the device certificate are never sent: at enrollment, and at every later
// check-in of a device that enrolled through an honest proxy.
func TestProxyThatInspectsTLSFailsThePin(t *testing.T) {
	server := newProxiedServer(t)
	attacker := makeCA(t)
	inspecting := &tls.Config{Certificates: []tls.Certificate{leafFor(t, attacker, "vectory.test")}, MinVersion: tls.VersionTLS13}

	t.Run("at enrollment", func(t *testing.T) {
		proxy := startConnectProxy(t, server.routes)
		proxy.inspect = inspecting
		dir := filepath.Join(privateTempDir(t), "state")
		result := runAgent(t, proxy.url("", ""), proxyClientRequest{Action: "enroll", Server: server.origin, Pin: server.pin, Dir: dir, Name: "proxied-edge", Token: "synthetic-setup-token"})
		if result.Enrolled || result.Code != "TLS_PIN_MISMATCH" || !strings.Contains(result.Message, "don't match the pinned CA") {
			t.Fatalf("the inspecting proxy's certificate passed the pin: %+v", result)
		}
		if !strings.Contains(result.Fix, "goes through the proxy at "+proxy.address()) || !strings.Contains(result.Fix, "inspects TLS") || !strings.Contains(result.Fix, "NO_PROXY") {
			t.Fatalf("the diagnostic doesn't name the proxy:\n%s", result.Fix)
		}
		if proxy.inspected.Load() != 0 || proxy.requests.Load() != 0 || server.enrolls.Load() != 0 {
			t.Fatal("the agent trusted the proxy's certificate")
		}
		for _, name := range []string{"identity.json", "credentials.json", ServerCAFile, "enrollment.json"} {
			if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
				t.Fatalf("%s exists after a refused certificate", name)
			}
		}
		requireNothingOf(t, dir, "synthetic-setup-token")
	})

	t.Run("at a later check-in", func(t *testing.T) {
		honest := startConnectProxy(t, server.routes)
		dir := filepath.Join(privateTempDir(t), "state")
		enrolled := runAgent(t, honest.url("", ""), proxyClientRequest{Action: "enroll", Server: server.origin, Pin: server.pin, Dir: dir, Name: "later-edge", Token: "synthetic-setup-token"})
		if !enrolled.Enrolled || !enrolled.CheckedIn {
			t.Fatalf("setup: %+v", enrolled)
		}
		before := server.heartbeats.Load()
		proxy := startConnectProxy(t, server.routes)
		proxy.inspect = inspecting
		result := runAgent(t, proxy.url("", ""), proxyClientRequest{Action: "check-in", Server: server.origin, Dir: dir})
		if result.CheckedIn || result.Code != "TLS_UNKNOWN_AUTHORITY" {
			t.Fatalf("the inspecting proxy's certificate was accepted for the device: %+v", result)
		}
		if !strings.Contains(result.Fix, "goes through the proxy at "+proxy.address()) {
			t.Fatalf("the diagnostic doesn't name the proxy:\n%s", result.Fix)
		}
		if proxy.inspected.Load() != 0 || proxy.requests.Load() != 0 || server.heartbeats.Load() != before {
			t.Fatal("the agent talked to the inspecting proxy")
		}
	})
}
