package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A live check of the agent's side of an update against the compiled server: the
// real enrollment, the real signed manifests, a release the server builds from
// its mirror and the team's key signs, an update rollout, the offer in the
// manifest, the build served over mutual TLS and the report the server keeps.
// Set VECTORY_TEST_SERVER to the absolute path of the server binary; without it
// the test is skipped. The agent runs as the engine does in production
// (OpenEngine); only the privileged step is a status the test writes.

type liveServer struct {
	t            *testing.T
	dir          string
	http, https  string
	caFile       string
	cookie, csrf string
	client       *http.Client
	log          string
}

func liveAddress(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

func liveSerial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 100))
	return n
}

// startLiveServer runs a copy of the server binary on fresh loopback ports with
// a certificate authority of its own, and waits until it answers.
func startLiveServer(t *testing.T, binary string) *liveServer {
	t.Helper()
	dir := realTempDir(t)
	s := &liveServer{t: t, dir: dir, client: &http.Client{Timeout: 15 * time.Second}}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	copied := filepath.Join(dir, "vectory-server")
	if err := os.WriteFile(copied, data, 0o700); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: liveSerial(), Subject: pkix.Name{CommonName: "agent-update-live-test"}, IsCA: true, BasicConstraintsValid: true, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: liveSerial(), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath, keyPath, secretPath := filepath.Join(dir, "server.pem"), filepath.Join(dir, "key.pem"), filepath.Join(dir, "bootstrap")
	s.caFile = filepath.Join(dir, "ca.pem")
	secret := fmt.Sprintf("%x%x", liveSerial().Bytes(), liveSerial().Bytes())
	for path, content := range map[string][]byte{
		certPath:   pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		keyPath:    pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
		s.caFile:   pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		secretPath: []byte(secret),
	} {
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	httpAddr, tlsAddr := liveAddress(t), liveAddress(t)
	s.http, s.https = "http://"+httpAddr, "https://"+tlsAddr
	s.log = filepath.Join(dir, "server.log")
	logFile, err := os.Create(s.log)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(copied)
	cmd.Env = append(os.Environ(), "VECTORY_DATA_DIR="+filepath.Join(dir, "state"), "VECTORY_HTTP_ADDR="+httpAddr, "VECTORY_AGENT_ADDR="+tlsAddr,
		"VECTORY_TLS_CERT="+certPath, "VECTORY_TLS_KEY="+keyPath, "VECTORY_BOOTSTRAP_SECRET_FILE="+secretPath, "VECTORY_COOKIE_SECURE=false",
		"VECTORY_DEVELOPMENT=true", "VECTORY_DASHBOARD_DIR="+dir, "VECTORY_RELEASES_DIR="+filepath.Join(dir, "releases"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		logFile.Close()
		if t.Failed() {
			text, _ := os.ReadFile(s.log)
			t.Logf("the server's log: %s", text)
		}
	})
	ready := false
	for i := 0; i < 150 && !ready; i++ {
		if res, err := s.client.Get(s.http + "/api/v1/status"); err == nil {
			res.Body.Close()
			ready = res.StatusCode == http.StatusOK
		}
		if !ready {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !ready {
		t.Fatal("the server did not become ready")
	}
	// The first administrator, who is signed in from here on.
	status, body, header := s.send("POST", "/api/v1/bootstrap", mustJSON(t, map[string]any{"bootstrap_secret": secret, "email": "live@example.invalid", "name": "Live check", "password": liveAdminPassword}), false)
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("bootstrap: HTTP %d %s", status, body)
	}
	var session map[string]any
	_ = json.Unmarshal(body, &session)
	s.cookie = strings.Split(header.Get("Set-Cookie"), ";")[0]
	s.csrf, _ = session["csrf_token"].(string)
	if s.cookie == "" || s.csrf == "" {
		t.Fatalf("bootstrap gave no session: %s", body)
	}
	return s
}

const liveAdminPassword = "test-only-password-29843"

// send makes one request as the signed-in administrator (when signed is set) and
// returns the status, the body and the headers.
func (s *liveServer) send(method, path string, body []byte, signed bool) (int, []byte, http.Header) {
	s.t.Helper()
	req, err := http.NewRequest(method, s.http+path, bytes.NewReader(body))
	if err != nil {
		s.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if signed {
		req.Header.Set("Cookie", s.cookie)
		if method != "GET" {
			req.Header.Set("X-CSRF-Token", s.csrf)
		}
	}
	res, err := s.client.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		s.t.Fatal(err)
	}
	return res.StatusCode, out, res.Header
}

// call is a request of the dashboard's API with a JSON body, answered with a
// JSON object.
func (s *liveServer) call(method, path string, body any) (int, map[string]any) {
	s.t.Helper()
	var raw []byte
	if body != nil {
		raw = mustJSON(s.t, body)
	}
	status, out, _ := s.send(method, "/api/v1"+path, raw, true)
	var parsed map[string]any
	_ = json.Unmarshal(out, &parsed)
	return status, parsed
}

func (s *liveServer) must(method, path string, body any) map[string]any {
	s.t.Helper()
	status, out := s.call(method, path, body)
	if status != http.StatusOK && status != http.StatusCreated {
		s.t.Fatalf("%s %s: HTTP %d %v", method, path, status, out)
	}
	return out
}

func TestAnAgentTakesAnOfferFromTheServer(t *testing.T) {
	binary := os.Getenv("VECTORY_TEST_SERVER")
	if binary == "" {
		t.Skip("a live check of agent updates needs the compiled server: set VECTORY_TEST_SERVER to its path")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("a release names builds for amd64 and arm64")
	}
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	srv := startLiveServer(t, binary)

	// The team's key: its private half stays here, as it stays offline.
	private := testPrivateKey(t, 9)
	public := testPublicKey(t, private, "live-check")
	pinnedAt := time.Now().UTC().Truncate(time.Second)

	// Updates on, with that key.
	current := srv.must("GET", "/agent-updates", nil)
	on := srv.must("PUT", "/agent-updates/settings", map[string]any{"enabled": true, "custody": map[string]any{"kind": "offline", "public_key": public.Line()}, "current_password": liveAdminPassword, "revision": current["revision"]})
	if key, _ := on["current_key"].(map[string]any); on["enabled"] != true || key["fingerprint"] != public.Fingerprint() {
		t.Fatalf("turning updates on: %v", on)
	}

	// The release mirror holds a build of 0.1.1 for this platform (and for the
	// other architecture, which no host here runs).
	build := bytes.Repeat([]byte("a build of the agent that a live check serves. "), 30_000)
	buildSHA := Digest(build)
	otherArch := map[string]string{"amd64": "arm64", "arm64": "amd64"}[runtime.GOARCH]
	mirror := filepath.Join(srv.dir, "releases")
	if err := os.MkdirAll(mirror, 0o755); err != nil {
		t.Fatal(err)
	}
	var catalog []map[string]any
	for _, b := range []struct {
		arch  string
		bytes []byte
	}{{runtime.GOARCH, build}, {otherArch, bytes.Repeat([]byte("a build for another architecture. "), 700)}} {
		file := "vectory-0.1.1-" + runtime.GOOS + "-" + b.arch
		if err := os.WriteFile(filepath.Join(mirror, file), b.bytes, 0o644); err != nil {
			t.Fatal(err)
		}
		catalog = append(catalog, map[string]any{"name": file, "os": runtime.GOOS, "arch": b.arch, "version": "0.1.1", "sha256": Digest(b.bytes), "size": len(b.bytes)})
	}
	if err := os.WriteFile(filepath.Join(mirror, "catalog.json"), mustJSON(t, catalog), 0o644); err != nil {
		t.Fatal(err)
	}

	// The host: set up as install does (settings), enrolled as enroll does, opened
	// as run opens it, and consenting to updates it applies when someone says so.
	state := filepath.Join(realTempDir(t), "state")
	if err := PrivateDir(state); err != nil {
		t.Fatal(err)
	}
	settings := Settings{Server: srv.https, CAFile: srv.caFile, Name: "live-check-1"}
	if err := WriteJSON(filepath.Join(state, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	token := srv.must("POST", "/tokens", map[string]any{"name": "live-check", "expires_hours": 1, "max_uses": 5, "name_prefix": "live-"})["token"].(string)
	if err := Enroll(context.Background(), state, settings, token); err != nil {
		t.Fatalf("enrollment: %v", err)
	}
	e, err := OpenEngine(state)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Client.Close()
	device := e.Credentials.DeviceID
	var said []string
	e.Notice = func(line string) {
		said = append(said, line)
		t.Log("the agent says: " + line)
	}
	e.State.Agent = &AgentBuild{Version: Version, SHA256: Digest([]byte("the build that runs"))}
	if err := WriteUpdatePolicy(UpdatePolicy{Consent: UpdateConsentAsk, Track: UpdateTrackPatch, Keys: []PinnedKey{{Key: public, PinnedAt: pinnedAt}}}); err != nil {
		t.Fatal(err)
	}
	step := func() {
		t.Helper()
		dir, err := ensureRootOwnedDir(paths.StepDir, rootReadable)
		if err != nil {
			t.Fatal(err)
		}
		defer dir.Close()
		if err := WriteUpdateStatus(dir, UpdateStatus{RunAt: time.Now().UTC().Truncate(time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1, HighestCounters: map[string]uint64{}}); err != nil {
			t.Fatal(err)
		}
	}
	step()
	beats := 0
	poll := func() {
		t.Helper()
		// The server lets a host check in 30 times a minute.
		if beats++; beats > 1 {
			time.Sleep(2100 * time.Millisecond)
		}
		if err := e.Poll(context.Background()); err != nil {
			t.Fatalf("a check-in: %v", err)
		}
		step()
	}
	held := func() map[string]any {
		t.Helper()
		got, _ := srv.must("GET", "/devices/"+device, nil)["agent_update"].(map[string]any)
		return got
	}

	t.Run("the-server-keeps-what-the-agent-reports", func(t *testing.T) {
		// The first check-in learns that the server speaks updates, so the next
		// ones carry the member.
		for i := 0; i < 3 && held() == nil; i++ {
			poll()
		}
		report := held()
		if report == nil {
			t.Fatal("after three check-ins the server holds no report of the agent update")
		}
		t.Logf("the server holds: %v", report)
		keys, _ := report["keys"].([]any)
		if report["consent"] != "ask" || report["paused"] != false || report["track"] != "patch" || report["eligibility"] != "eligible" || report["state"] != "idle" || len(keys) != 1 || keys[0] != public.Fingerprint() {
			t.Fatalf("the report as the server holds it: %v", report)
		}
		if e.update.memberRefused {
			t.Fatal("the server refused the member")
		}
	})

	t.Run("a-host-with-a-window-says-whether-it-is-open-and-when-it-opens", func(t *testing.T) {
		clock := func(at time.Time) string { return at.UTC().Format("15:04") }
		now := time.Now()
		closed := "daily " + clock(now.Add(3*time.Hour)) + "-" + clock(now.Add(4*time.Hour)) + " UTC"
		open := "daily " + clock(now.Add(-time.Hour)) + "-" + clock(now.Add(time.Hour)) + " UTC"
		for _, c := range []struct {
			window string
			open   bool
		}{{closed, false}, {open, true}} {
			if err := WriteUpdatePolicy(UpdatePolicy{Consent: UpdateConsentAuto, Track: UpdateTrackPatch, Windows: []string{c.window}, Keys: []PinnedKey{{Key: public, PinnedAt: pinnedAt}}}); err != nil {
				t.Fatal(err)
			}
			poll()
			report := held()
			windows, _ := report["windows"].([]any)
			if report == nil || report["consent"] != "auto" || len(windows) != 1 || windows[0] != c.window || report["window_open"] != c.open || (report["next_window_at"] != nil) != !c.open {
				t.Fatalf("the report of a host with the window %q: %v", c.window, report)
			}
		}
		if err := WriteUpdatePolicy(UpdatePolicy{Consent: UpdateConsentAsk, Track: UpdateTrackPatch, Keys: []PinnedKey{{Key: public, PinnedAt: pinnedAt}}}); err != nil {
			t.Fatal(err)
		}
	})

	var release map[string]any
	var manifest []byte
	t.Run("a-release-the-teams-key-signs-is-ready", func(t *testing.T) {
		release = srv.must("POST", "/agent-releases", map[string]any{"version": "0.1.1"})
		id, _ := release["id"].(string)
		status, raw, _ := srv.send("GET", "/api/v1/agent-releases/"+id+"/manifest", nil, true)
		if status != http.StatusOK {
			t.Fatalf("the manifest: HTTP %d %s", status, raw)
		}
		manifest = raw
		if Digest(manifest) != release["manifest_sha256"] {
			t.Fatal("the manifest served is not the one the release names")
		}
		parsed, err := ParseReleaseManifest(manifest)
		if err != nil {
			t.Fatalf("the agent can't read the manifest the server built: %v", err)
		}
		if mine, ok := parsed.ArtifactFor(runtime.GOOS, runtime.GOARCH); !ok || mine.SHA256 != buildSHA || mine.Size != int64(len(build)) {
			t.Fatalf("the release names another build for this platform: %+v", parsed.Artifacts)
		}
		signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(public, private.SignRelease(manifest))})
		if err != nil {
			t.Fatal(err)
		}
		status, raw, _ = srv.send("PUT", "/api/v1/agent-releases/"+id+"/signature", signatures, true)
		if status != http.StatusOK || !strings.Contains(string(raw), `"ready"`) {
			t.Fatalf("the server did not take the signature the agent's library built: HTTP %d %s", status, raw)
		}
	})

	var rollout string
	t.Run("the-review-lists-the-host-and-a-rollout-offers-it-the-release", func(t *testing.T) {
		request := map[string]any{"release_id": release["id"], "selector": map[string]any{"device_ids": []string{device}, "group_ids": []string{}, "exclude_ids": []string{}}, "rollout": map[string]any{"canary_size": 1, "batch_size": 10, "observation_seconds": 60, "failure_threshold": 100}}
		review := srv.must("POST", "/agent-update-rollouts/preview", request)
		if updated, _ := review["will_update"].([]any); len(updated) != 1 {
			t.Fatalf("the review of a host that reports eligible: %v", review)
		}
		request["review_token"] = review["review_token"]
		created := srv.must("POST", "/agent-update-rollouts", request)
		rollout, _ = created["id"].(string)
		if rollout == "" {
			t.Fatalf("the rollout: %v", created)
		}
	})

	manifestSHA := Digest(manifest)
	ex := UpdateExchangeFor(state)
	t.Run("the-agent-verifies-downloads-and-stages-the-build", func(t *testing.T) {
		deadline := time.Now().Add(90 * time.Second)
		for {
			poll()
			if d := e.update.download; d != nil {
				select {
				case <-d.done:
				case <-time.After(30 * time.Second):
					t.Fatal("the transfer did not end")
				}
			}
			if e.update.decision.state == UpdateStateStaged {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("the agent never staged the build; its decision is %+v and it said %q", e.update.decision, said)
			}
		}
		dir, err := ex.IncomingDir(manifestSHA)
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(dir, UpdateBuildFile(runtime.GOOS)))
		if err != nil || !bytes.Equal(got, build) {
			t.Fatalf("the staged build is not the one the mirror holds: %v", err)
		}
		if got, err := os.ReadFile(filepath.Join(dir, UpdateReleaseFile)); err != nil || !bytes.Equal(got, manifest) {
			t.Fatalf("the staged release manifest: %v", err)
		}
		signatures, err := os.ReadFile(filepath.Join(dir, UpdateSignaturesFile))
		if err != nil || !bytes.Contains(signatures, []byte(public.Fingerprint())) {
			t.Fatalf("the staged signature file: %v %s", err, signatures)
		}
		request, err := ReadUpdateRequest(ex.Request)
		if err != nil || request.ManifestSHA256 != manifestSHA || request.ArtifactSHA256 != buildSHA || request.RolloutID != rollout {
			t.Fatalf("the request for the step: %v %+v", err, request)
		}
		if _, err := os.Stat(filepath.Join(dir, UpdateBuildPartFile)); !os.IsNotExist(err) {
			t.Fatalf("a partial file is left: %v", err)
		}
	})

	t.Run("the-server-sees-a-host-that-waits-for-someone-on-it", func(t *testing.T) {
		poll() // the report of the decision reaches the server with the next check-in
		report := held()
		t.Logf("the server holds: %v", report)
		if report["state"] != "waiting_for_host" || report["release_version"] != "0.1.1" {
			t.Fatalf("the report of a staged build on a host that asks first: %v", report)
		}
		targets := srv.must("GET", "/agent-update-rollouts/"+rollout+"/targets", nil)
		items, _ := targets["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("the targets: %v", targets)
		}
		if target, _ := items[0].(map[string]any); target["state"] != "waiting_for_host" {
			t.Fatalf("the target of the staged host: %v", target)
		}
		health, err := ReadUpdateHealth(ex.Health)
		if err != nil || health.Offer != manifestSHA || health.AgentSHA256 != e.State.Agent.SHA256 {
			t.Fatalf("what the agent recorded for the step: %v %+v", err, health)
		}
	})

	t.Run("cancelling-the-rollout-takes-what-was-staged-away", func(t *testing.T) {
		srv.must("POST", "/agent-update-rollouts/"+rollout+"/cancel", nil)
		for i := 0; i < 4; i++ {
			poll()
			if _, err := os.Stat(ex.Request); os.IsNotExist(err) {
				break
			}
		}
		if _, err := os.Stat(ex.Request); !os.IsNotExist(err) {
			t.Fatalf("the request for the step stays after the rollout was cancelled: %v", err)
		}
		entries, _ := os.ReadDir(ex.Incoming)
		if len(entries) != 0 {
			t.Fatalf("what was staged stays after the rollout was cancelled: %v", entries)
		}
		poll()
		if report := held(); report["state"] != "idle" {
			t.Fatalf("the report after the offer was taken away: %v", report)
		}
		targets := srv.must("GET", "/agent-update-rollouts/"+rollout+"/targets", nil)
		items, _ := targets["items"].([]any)
		if target, _ := items[0].(map[string]any); target["state"] != "cancelled" {
			t.Fatalf("the target of a cancelled rollout: %v", target)
		}
		if e.update.memberRefused {
			t.Fatal("the server refused the member")
		}
	})
}
