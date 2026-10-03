//go:build !windows

package agent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The platform checks answer a real agent with offers a host must refuse, from a
// program under tests/platform. These tests hold that program to two things the
// platform run can't show a reader quickly: that each offer it crafts is refused,
// by the verification every host runs, with the code the scenario names (so a
// scenario that stopped being what it says fails here and not in a run that takes
// an hour), and that what it signs and serves is what a real agent's client
// accepts: the connection, the device's certificate, the signed envelope.

func buildHostileServer(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "hostile-update-server")
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, ".")
	build.Dir = filepath.Join("..", "..", "..", "tests", "platform", "hostile-update-server")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return binary
}

// hostileKeys writes three release private keys the way `vectory release keygen`
// does and returns their files and keys.
type hostileKeys struct {
	pinnedFile, otherFile, oldFile string
	pinned, other, old             ReleaseKey
	pinnedPrivate                  ReleasePrivateKey
}

func writeHostileKeys(t *testing.T, dir string) hostileKeys {
	t.Helper()
	var keys hostileKeys
	for i, target := range []struct {
		file    *string
		public  *ReleaseKey
		seed    byte
		name    string
		private *ReleasePrivateKey
	}{
		{&keys.pinnedFile, &keys.pinned, 11, "team", &keys.pinnedPrivate},
		{&keys.otherFile, &keys.other, 12, "stranger", nil},
		{&keys.oldFile, &keys.old, 13, "team-old", nil},
	} {
		private := testPrivateKey(t, target.seed)
		*target.file = filepath.Join(dir, fmt.Sprintf("key-%d", i))
		if err := WriteReleasePrivateKey(*target.file, private); err != nil {
			t.Fatal(err)
		}
		*target.public = testPublicKey(t, private, target.name)
		if target.private != nil {
			*target.private = private
		}
	}
	return keys
}

type hostileDump struct {
	Host struct {
		OS             string `json:"os"`
		Arch           string `json:"arch"`
		RunningVersion string `json:"running_version"`
		Track          string `json:"track"`
		Now            string `json:"now"`
	} `json:"host"`
	Pins      []string          `json:"pins"`
	Floors    map[string]uint64 `json:"floors"`
	Tried     string            `json:"tried_manifest_sha256"`
	Bundles   map[string]string `json:"bundles"`
	Scenarios []struct {
		Name  string `json:"name"`
		Code  string `json:"code"`
		About string `json:"about"`
		Offer struct {
			RolloutID  string             `json:"rollout_id"`
			ReleaseID  string             `json:"release_id"`
			Manifest   string             `json:"manifest"`
			Signatures string             `json:"signatures"`
			Rollovers  []RolloverEnvelope `json:"rollovers"`
			Artifact   struct {
				SHA256 string `json:"sha256"`
				Size   int64  `json:"size"`
				Path   string `json:"path"`
			} `json:"artifact"`
		} `json:"offer"`
	} `json:"scenarios"`
}

func TestEveryOfferTheHostileServerCraftsIsRefusedByTheVerificationAHostRunsWithTheCodeItNames(t *testing.T) {
	binary := buildHostileServer(t)
	dir := t.TempDir()
	keys := writeHostileKeys(t, dir)
	buildFile := filepath.Join(dir, "build")
	if err := os.WriteFile(buildFile, []byte("a build of the agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)

	// The release that rolled back on the host: counter 4, signed by the pinned key.
	built := sha256.Sum256([]byte("a build of the agent"))
	manifest, err := BuildReleaseManifest(ReleaseManifest{
		Version: "0.1.2", Counter: 4, IssuedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(180 * 24 * time.Hour), MinFrom: "0.1.0", ServiceDefinition: 1,
		Artifacts: []ReleaseArtifact{{OS: "linux", Arch: "amd64", Format: "executable", File: "vectory-0.1.2-linux-amd64", Size: int64(len("a build of the agent")), SHA256: hex.EncodeToString(built[:])}},
	})
	if err != nil {
		t.Fatal(err)
	}
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(keys.pinned, keys.pinnedPrivate.SignRelease(manifest))})
	if err != nil {
		t.Fatal(err)
	}
	tried := filepath.Join(dir, "tried")
	if err := os.Mkdir(tried, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"release.json": manifest, "release.json.sig": signatures} {
		if err := os.WriteFile(filepath.Join(tried, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	out := filepath.Join(dir, "scenarios.json")
	command := exec.Command(binary, "dump", "--out", out, "--pinned-key", keys.pinnedFile, "--other-key", keys.otherFile, "--old-key", keys.oldFile,
		"--build", buildFile, "--tried-release", tried, "--os", "linux", "--arch", "amd64", "--running-version", "0.1.1", "--floor", "5", "--now", now.Format(time.RFC3339))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("dump: %v\n%s", err, output)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var dump hostileDump
	if err := json.Unmarshal(data, &dump); err != nil {
		t.Fatal(err)
	}
	pins := make([]ReleaseKey, 0, len(dump.Pins))
	for _, line := range dump.Pins {
		key, err := ParseReleaseKey(line)
		if err != nil {
			t.Fatal(err)
		}
		pins = append(pins, key)
	}
	if len(dump.Scenarios) < 14 {
		t.Fatalf("the dump holds %d scenarios", len(dump.Scenarios))
	}

	seen := map[string]bool{}
	for _, scenario := range dump.Scenarios {
		seen[scenario.Name] = true
		offer := scenario.Offer
		manifestBytes, err := DecodeCanonicalBase64(offer.Manifest)
		if err != nil {
			t.Fatalf("%s: %v", scenario.Name, err)
		}
		signatureBytes, err := DecodeCanonicalBase64(offer.Signatures)
		if err != nil {
			t.Fatalf("%s: %v", scenario.Name, err)
		}
		if len(offer.Rollovers) > MaxRolloverChain || offer.Rollovers == nil {
			t.Errorf("%s: %d statements (a list, at most %d)", scenario.Name, len(offer.Rollovers), MaxRolloverChain)
		}
		input := VerifyInput{
			Manifest: manifestBytes, Signatures: signatureBytes, Rollovers: offer.Rollovers, Pins: pins, Floors: dump.Floors,
			Now: now, RunningVersion: dump.Host.RunningVersion, OS: dump.Host.OS, Arch: dump.Host.Arch, Track: dump.Host.Track, ServiceDefinition: 1,
		}
		if scenario.Name == "already_tried" {
			input.Last = &ReleaseResult{Release: dump.Tried, Outcome: "rolled_back"}
		}
		verified, err := VerifyRelease(input)
		switch scenario.Code {
		case "", "UPDATES_OFF", "MANIFEST_INVALID":
			// The first two are a good release (the host's consent, not the release,
			// decides the second). The third is either the manifest's own rule or the
			// offer disagreeing with the manifest, which the agent checks.
			if scenario.Name == "issued_ahead" {
				wantRefusal(t, err, "MANIFEST_INVALID")
				continue
			}
			if err != nil {
				t.Errorf("%s: the verification refused it: %v", scenario.Name, err)
				continue
			}
			entry := verified.Artifact
			agrees := offer.Artifact.SHA256 == entry.SHA256 && offer.Artifact.Size == entry.Size && offer.Artifact.Path == "/agent/v1/agent-releases/"+entry.SHA256
			if wantDisagreement := strings.HasPrefix(scenario.Name, "artifact_"); agrees == wantDisagreement {
				t.Errorf("%s: the offer's artifact %+v and the manifest's entry %+v: agree=%v", scenario.Name, offer.Artifact, entry, agrees)
			}
		default:
			wantRefusal(t, err, scenario.Code)
		}
	}
	for _, name := range []string{"genuine", "wrong_key", "flipped_byte", "lower_counter", "expired", "issued_ahead", "wrong_platform", "artifact_path_elsewhere", "artifact_disagrees",
		"old_statement", "unpinned_rollover", "already_tried", "consent_off", "fork"} {
		if !seen[name] {
			t.Errorf("the dump has no %s", name)
		}
	}
	if last := dump.Scenarios[len(dump.Scenarios)-1].Name; last != "fork" {
		t.Errorf("the last scenario is %s: a fork freezes the host, so nothing may follow it", last)
	}

	// The key bundle that lies names the operator's fingerprint over another key.
	for mode, lies := range map[string]bool{"honest": false, "lies": true} {
		var bundle struct {
			Keys []struct {
				PublicKey   string `json:"public_key"`
				Fingerprint string `json:"fingerprint"`
			} `json:"keys"`
		}
		if err := json.Unmarshal([]byte(dump.Bundles[mode]), &bundle); err != nil || len(bundle.Keys) != 1 {
			t.Fatalf("the %s bundle: %v", mode, err)
		}
		key, err := ParseReleaseKey(bundle.Keys[0].PublicKey)
		if err != nil {
			t.Fatal(err)
		}
		if got := bundle.Keys[0].Fingerprint == key.Fingerprint(); got == lies {
			t.Errorf("the %s bundle's fingerprint member matches its key: %v", mode, got)
		}
		if bundle.Keys[0].Fingerprint != keys.pinned.Fingerprint() {
			t.Errorf("the %s bundle names the fingerprint %s, not the operator's", mode, bundle.Keys[0].Fingerprint)
		}
	}
}

// ---------------------------------------------------------------- against a real agent's client

type hostileProcess struct {
	t        *testing.T
	agent    string
	control  string
	token    string
	command  *exec.Cmd
	controlC *http.Client
}

func (h *hostileProcess) call(method, path string, body any) (int, []byte) {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, "http://"+h.control+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	request.Header.Set("X-Hostile-Token", h.token)
	response, err := h.controlC.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, data
}

func TestTheHostileServerAnswersARealAgentsClientAsAnInstanceDoes(t *testing.T) {
	binary := buildHostileServer(t)
	dir := t.TempDir()
	keys := writeHostileKeys(t, dir)
	buildFile := filepath.Join(dir, "build")
	if err := os.WriteFile(buildFile, []byte("a build of the agent"), 0o755); err != nil {
		t.Fatal(err)
	}

	// An instance in miniature: one CA for the devices and for the listener, the
	// manifest signing key, and the files the agent and the step keep.
	ca := makeCA(t)
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(24 * time.Hour)
	chain := ca.issue(t, &serverKey.PublicKey, "localhost", true, expires) + ca.pem
	files := map[string][]byte{
		"ca.pem": []byte(ca.pem), "chain.pem": []byte(chain), "server-key.pem": privatePEM(t, serverKey),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keysDir := filepath.Join(dir, "keys")
	if err := os.Mkdir(keysDir, 0o700); err != nil {
		t.Fatal(err)
	}
	signingSeed := bytes.Repeat([]byte{0x42}, ed25519.SeedSize)
	if err := os.WriteFile(filepath.Join(keysDir, "manifest-signing.key"), signingSeed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(keysDir, "device-ca.pem"), []byte(ca.pem), 0o600); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(dir, "state")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "state.json"), []byte(`{"highest_generation":7,"highest_policy_generation":3,"policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	status := filepath.Join(dir, "status.json")
	if err := os.WriteFile(status, []byte(fmt.Sprintf(`{"highest_counters":{%q:5}}`, keys.pinned.Fingerprint())), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &hostileProcess{t: t, token: "a-token-for-this-test", controlC: &http.Client{Timeout: 10 * time.Second}}
	h.command = exec.Command(binary, "serve", "--listen", "127.0.0.1:0", "--control", "127.0.0.1:0", "--token", h.token,
		"--keys", keysDir, "--tls-chain", filepath.Join(dir, "chain.pem"), "--tls-key", filepath.Join(dir, "server-key.pem"), "--agent-state", stateDir, "--status", status,
		"--pinned-key", keys.pinnedFile, "--other-key", keys.otherFile, "--old-key", keys.oldFile, "--build", buildFile, "--os", "linux", "--arch", "amd64")
	stdout, err := h.command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	h.command.Stderr = os.Stderr
	if err := h.command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = h.command.Process.Kill()
		_ = h.command.Wait()
	})
	lines := bufio.NewScanner(stdout)
	for _, want := range []string{"listening ", "control "} {
		if !lines.Scan() || !strings.HasPrefix(lines.Text(), want) {
			t.Fatalf("the server printed %q, want a line that starts with %q", lines.Text(), want)
		}
		address := strings.TrimPrefix(lines.Text(), want)
		if want == "listening " {
			h.agent = address
		} else {
			h.control = address
		}
	}

	// A real agent's client, as setup builds it: the CA file, the device's credentials.
	deviceID := "9b1c2f60-3a41-4a0c-8d0e-6b7f1a2c3d4e"
	deviceKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	devicePEM := ca.issue(t, &deviceKey.PublicKey, deviceID, false, expires)
	public := ed25519.NewKeyFromSeed(signingSeed).Public().(ed25519.PublicKey)
	credentials := Credentials{DeviceID: deviceID, CertificatePEM: devicePEM, CAPEM: ca.pem, SigningPublicKey: base64.StdEncoding.EncodeToString(public), CertificateExpiresAt: expires.Truncate(time.Second)}
	base := "https://" + h.agent
	client, err := NewClient(Settings{Server: base, CAFile: filepath.Join(dir, "ca.pem")}, &credentials, privatePEM(t, deviceKey))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	checkIn := func() (Manifest, map[string]json.RawMessage) {
		t.Helper()
		var raw [32]byte
		rand.Read(raw[:])
		nonce := base64.StdEncoding.EncodeToString(raw[:])
		body, err := client.request(ctx, "POST", "/agent/v1/heartbeat", map[string]any{
			"protocol_version": 1, "request_id": RandomID(), "nonce": nonce, "boot_id": RandomID(), "agent_version": "0.1.1", "agent_sha256": RandomID(),
			"agent_update": map[string]any{"consent": "auto", "state": "idle"},
		})
		if err != nil {
			t.Fatalf("a check-in: %v", err)
		}
		var envelope Envelope
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		m, err := VerifyEnvelope(envelope, credentials.SigningPublicKey, deviceID, nonce, time.Now(), State{})
		if err != nil {
			t.Fatalf("the agent's verification of the manifest: %v", err)
		}
		payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
		if err != nil {
			t.Fatal(err)
		}
		var members map[string]json.RawMessage
		if err := json.Unmarshal(payload, &members); err != nil {
			t.Fatal(err)
		}
		return m, members
	}

	// With no scenario the manifest is the agent's own state, and carries no offer.
	m, members := checkIn()
	if m.Generation != 7 || m.PolicyGeneration != 3 || m.Policy.HeartbeatSeconds != 60 || m.Desired != nil {
		t.Errorf("the manifest isn't what the agent already accepted: %+v", m)
	}
	if _, offered := members["agent_update"]; offered {
		t.Error("an offer with no scenario")
	}
	if got := strings.Join(m.Features, ","); got != "wake,agent_update" {
		t.Errorf("features: %s", got)
	}

	// A wait the agent holds is answered at once when a scenario is chosen.
	waited := make(chan wakeAnswer, 1)
	go func() { waited <- client.waitForChange(ctx, 7, 3) }()
	time.Sleep(200 * time.Millisecond)
	if status, body := h.call("POST", "/scenario", map[string]string{"name": "wrong_key"}); status != 200 {
		t.Fatalf("selecting a scenario: %d %s", status, body)
	}
	select {
	case answer := <-waited:
		if answer.err != nil || !answer.changed {
			t.Errorf("the wait: %+v", answer)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("choosing a scenario didn't answer the agent's wait")
	}

	// The offer arrives in the signed manifest, and the host's verification refuses it.
	_, members = checkIn()
	var offered struct {
		RolloutID  string             `json:"rollout_id"`
		ReleaseID  string             `json:"release_id"`
		Manifest   string             `json:"manifest"`
		Signatures string             `json:"signatures"`
		Rollovers  []RolloverEnvelope `json:"rollovers"`
		Artifact   struct {
			SHA256 string `json:"sha256"`
			Path   string `json:"path"`
		} `json:"artifact"`
	}
	if err := json.Unmarshal(members["agent_update"], &offered); err != nil || offered.Manifest == "" {
		t.Fatalf("no offer in %v: %v", members, err)
	}
	manifestBytes, err := DecodeCanonicalBase64(offered.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	signatureBytes, err := DecodeCanonicalBase64(offered.Signatures)
	if err != nil {
		t.Fatal(err)
	}
	_, err = VerifyRelease(VerifyInput{Manifest: manifestBytes, Signatures: signatureBytes, Rollovers: offered.Rollovers, Pins: []ReleaseKey{keys.pinned},
		Now: time.Now(), RunningVersion: "0.1.1", OS: "linux", Arch: "amd64", Track: "patch", ServiceDefinition: 1})
	wantRefusal(t, err, "KEY_NOT_PINNED")

	// The floor the step reports is the one a replay is crafted from.
	if status, body := h.call("POST", "/scenario", map[string]string{"name": "lower_counter"}); status != 200 {
		t.Fatalf("lower_counter: %d %s", status, body)
	}
	_, members = checkIn()
	if err := json.Unmarshal(members["agent_update"], &offered); err != nil {
		t.Fatal(err)
	}
	manifestBytes, _ = DecodeCanonicalBase64(offered.Manifest)
	if parsed, err := ParseReleaseManifest(manifestBytes); err != nil || parsed.Counter != 5 {
		t.Errorf("a replay is crafted at the floor: %+v, %v", parsed, err)
	}
	// With no floor there is nothing to replay: the control says so.
	if err := os.WriteFile(status, []byte(`{"highest_counters":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, body := h.call("POST", "/scenario", map[string]string{"name": "lower_counter"}); code != http.StatusConflict {
		t.Errorf("a replay with no floor: %d %s", code, body)
	}
	if code, _ := h.call("POST", "/scenario", map[string]string{"name": "no such scenario"}); code != http.StatusNotFound {
		t.Errorf("an unknown scenario: %d", code)
	}

	// No build is ever served, and a request for one is recorded.
	response, err := client.HTTP.Get(base + "/agent/v1/agent-releases/" + offered.Artifact.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Errorf("a download: %d", response.StatusCode)
	}
	var state struct {
		Downloads []string `json:"downloads"`
		Scenario  string   `json:"scenario"`
	}
	_, body := h.call("GET", "/state", nil)
	if err := json.Unmarshal(body, &state); err != nil || len(state.Downloads) != 1 || !strings.HasSuffix(state.Downloads[0], offered.Artifact.SHA256) {
		t.Errorf("the state: %s (%v)", body, err)
	}

	// The key bundle needs no client certificate, and says what the mode says.
	plain := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: certPool(t, ca.pem), MinVersion: tls.VersionTLS13}}}
	for mode, lies := range map[string]bool{"honest": false, "lies": true} {
		if status, body := h.call("POST", "/bundle", map[string]string{"mode": mode}); status != 200 {
			t.Fatalf("%s: %d %s", mode, status, body)
		}
		response, err := plain.Get(base + "/agent/v1/release-keys")
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(response.Body)
		response.Body.Close()
		var bundle struct {
			Keys []struct {
				PublicKey   string `json:"public_key"`
				Fingerprint string `json:"fingerprint"`
			} `json:"keys"`
		}
		if err := json.Unmarshal(data, &bundle); err != nil || len(bundle.Keys) != 1 {
			t.Fatalf("%s: %s %v", mode, data, err)
		}
		key, err := ParseReleaseKey(bundle.Keys[0].PublicKey)
		if err != nil {
			t.Fatal(err)
		}
		if (bundle.Keys[0].Fingerprint != key.Fingerprint()) != lies {
			t.Errorf("%s: the fingerprint member is %s for the key %s", mode, bundle.Keys[0].Fingerprint, key.Fingerprint())
		}
	}

	// Authentication is the device's certificate, as on the instance's listener.
	response, err = plain.Post(base+"/agent/v1/heartbeat", "application/json", strings.NewReader(`{"nonce":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Errorf("a check-in with no certificate: %d", response.StatusCode)
	}
	stranger := makeCA(t)
	strangerKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	strangers := credentials
	strangers.CertificatePEM = stranger.issue(t, &strangerKey.PublicKey, deviceID, false, expires)
	other, err := NewClient(Settings{Server: base, CAFile: filepath.Join(dir, "ca.pem")}, &strangers, privatePEM(t, strangerKey))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.request(ctx, "POST", "/agent/v1/heartbeat", map[string]any{"nonce": "x"}); err == nil {
		t.Error("a certificate another CA signed was served")
	}
	other.Close()

	// The control port answers to its token alone, and the server stops when asked.
	request, _ := http.NewRequest("GET", "http://"+h.control+"/state", nil)
	if response, err := h.controlC.Do(request); err != nil || response.StatusCode != http.StatusUnauthorized {
		t.Errorf("the control port without its token: %v %v", response, err)
	}
	if status, _ := h.call("POST", "/stop", nil); status != 200 {
		t.Errorf("stop: %d", status)
	}
	done := make(chan error, 1)
	go func() { done <- h.command.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 0 {
				t.Errorf("the server ended with %v", err)
			}
		}
	case <-time.After(15 * time.Second):
		t.Error("the server didn't stop")
	}
}

func certPool(t *testing.T, pem string) *x509.CertPool {
	t.Helper()
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(pem)) {
		t.Fatal("no certificate")
	}
	return pool
}
