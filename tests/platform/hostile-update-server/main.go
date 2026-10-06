// hostile-update-server stands in for an instance's agent listener on a CI
// runner and answers a real agent's check-ins with offers that the host must
// refuse: a release signed by a key it doesn't pin, one flipped byte, a replayed
// counter, an expired manifest, and the rest of the list in scenarios.go. It takes
// over the listener's port with the instance's own TLS chain and manifest signing
// key, authenticates the device by its certificate as the real listener does, and
// changes nothing but the offer: the generations, the desired configuration and
// the policy it answers with are the ones the agent already accepted, read from
// the agent's state directory.
//
// It exists for the platform checks (tests/platform/agent-update.mjs) and is never
// built into a release: nothing under tests/ is. It reads the instance's private
// keys, so it runs only where the instance does, as root, for a few minutes.
//
//	hostile-update-server serve [flags]   answer check-ins until told to stop
//	hostile-update-server dump  [flags]   write every scenario's offer to a file
//
// serve is steered over a loopback control port: POST /scenario {"name": ...}
// selects the offer, POST /bundle {"mode": "honest"|"lies"} the key bundle,
// GET /state shows what the agent reported and asked for, POST /stop ends it.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

type config struct {
	listen, control, token string
	keysDir                string
	tlsChain, tlsKey       string
	agentState, statusFile string
	pinnedKey, otherKey    string
	oldKey, build          string
	triedDir               string
	goos, goarch           string
	out                    string
	now                    string
	runningVersion         string
	floor                  uint64
}

func (c *config) flags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.StringVar(&c.listen, "listen", "127.0.0.1:8443", "the agent listener's address")
	fs.StringVar(&c.control, "control", "127.0.0.1:8665", "the control listener's address (loopback)")
	fs.StringVar(&c.token, "token", "", "what the control requests must present in X-Hostile-Token")
	fs.StringVar(&c.keysDir, "keys", "", "the instance's keys directory (manifest-signing.key, device-ca.pem)")
	fs.StringVar(&c.tlsChain, "tls-chain", "", "the agent listener's certificate chain")
	fs.StringVar(&c.tlsKey, "tls-key", "", "the agent listener's private key")
	fs.StringVar(&c.agentState, "agent-state", "", "the agent's state directory")
	fs.StringVar(&c.statusFile, "status", "/var/lib/vectory-update/status.json", "the privileged step's status.json")
	fs.StringVar(&c.pinnedKey, "pinned-key", "", "private key file of the key the host pins")
	fs.StringVar(&c.otherKey, "other-key", "", "private key file of a key the host doesn't pin")
	fs.StringVar(&c.oldKey, "old-key", "", "private key file of a key the host left")
	fs.StringVar(&c.build, "build", "", "a build the genuine release names (its size and SHA-256 are used)")
	fs.StringVar(&c.triedDir, "tried-release", "", "a directory holding release.json and release.json.sig of a release that rolled back on the host")
	fs.StringVar(&c.goos, "os", runtime.GOOS, "the host's operating system")
	fs.StringVar(&c.goarch, "arch", runtime.GOARCH, "the host's architecture")
	return fs
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: hostile-update-server serve|dump [flags]")
		os.Exit(2)
	}
	cfg := &config{}
	fs := cfg.flags(os.Args[1])
	switch os.Args[1] {
	case "serve":
	case "dump":
		fs.StringVar(&cfg.out, "out", "", "the file to write")
		fs.StringVar(&cfg.now, "now", "", "the time to craft at (RFC 3339), now when empty")
		fs.StringVar(&cfg.runningVersion, "running-version", "0.1.1", "the version the host runs")
		fs.Uint64Var(&cfg.floor, "floor", 5, "the highest counter the host attempted from the pinned key")
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
	if err := fs.Parse(os.Args[2:]); err != nil {
		os.Exit(2)
	}
	var err error
	if os.Args[1] == "serve" {
		err = serve(cfg)
	} else {
		err = dump(cfg)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "hostile-update-server:", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------- the instance's keys

// instance is what the real listener has and this one borrows: the key its
// manifests are signed with and the CA its devices' certificates come from.
type instance struct {
	signing  []byte // the 32-byte seed
	deviceCA *x509.CertPool
}

func loadInstance(dir string) (*instance, error) {
	seed, err := os.ReadFile(filepath.Join(dir, "manifest-signing.key"))
	if err != nil {
		return nil, err
	}
	if len(seed) != 32 {
		return nil, fmt.Errorf("manifest-signing.key is %d bytes, not 32", len(seed))
	}
	pemBytes, err := os.ReadFile(filepath.Join(dir, "device-ca.pem"))
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, errors.New("device-ca.pem holds no certificate")
	}
	return &instance{signing: seed, deviceCA: pool}, nil
}

// ---------------------------------------------------------------- the agent's state

// agentState is what the agent accepted from its server last, which the manifests
// this server signs repeat, so that the agent's own anti-rollback checks have
// nothing to refuse and the only new thing in a manifest is the offer.
type agentState struct {
	HighestGeneration       uint64          `json:"highest_generation"`
	HighestPolicyGeneration uint64          `json:"highest_policy_generation"`
	Desired                 json.RawMessage `json:"desired"`
	Policy                  json.RawMessage `json:"policy"`
}

func readAgentState(dir string) (agentState, error) {
	var st agentState
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return st, fmt.Errorf("state.json: %w", err)
	}
	if len(st.Policy) == 0 {
		st.Policy = json.RawMessage(`{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}`)
	}
	return st, nil
}

// ---------------------------------------------------------------- the server

type heartbeat struct {
	At            time.Time       `json:"at"`
	Scenario      string          `json:"scenario"`
	AgentVersion  string          `json:"agent_version"`
	AgentSHA256   string          `json:"agent_sha256"`
	BootID        string          `json:"boot_id"`
	AgentUpdate   json.RawMessage `json:"agent_update"`
	AnsweredOffer bool            `json:"answered_with_offer"`
}

type server struct {
	cfg  *config
	inst *instance

	mu         sync.Mutex
	scenario   string
	crafted    map[string]*crafted
	bundleMode string
	beats      []heartbeat
	total      int
	downloads  []string
	bundleHits int
	nudges     int
	wake       chan struct{}
	stop       chan struct{}
}

// wakeAll answers every wait the agent holds with "changed", which has it check
// in at once.
func (s *server) wakeAll() {
	s.mu.Lock()
	old := s.wake
	s.wake = make(chan struct{})
	s.mu.Unlock()
	close(old)
}

func serve(cfg *config) error {
	if cfg.token == "" || cfg.keysDir == "" || cfg.tlsChain == "" || cfg.tlsKey == "" || cfg.agentState == "" {
		return errors.New("serve needs --token, --keys, --tls-chain, --tls-key and --agent-state")
	}
	inst, err := loadInstance(cfg.keysDir)
	if err != nil {
		return err
	}
	pair, err := tls.LoadX509KeyPair(cfg.tlsChain, cfg.tlsKey)
	if err != nil {
		return err
	}
	s := &server{cfg: cfg, inst: inst, crafted: map[string]*crafted{}, bundleMode: "honest", wake: make(chan struct{}), stop: make(chan struct{})}

	agentListener, err := tls.Listen("tcp", cfg.listen, &tls.Config{
		Certificates: []tls.Certificate{pair},
		MinVersion:   tls.VersionTLS13,
		ClientAuth:   tls.VerifyClientCertIfGiven,
		ClientCAs:    inst.deviceCA,
	})
	if err != nil {
		return err
	}
	controlListener, err := net.Listen("tcp", cfg.control)
	if err != nil {
		return err
	}
	agentServer := &http.Server{Handler: http.HandlerFunc(s.agent), ReadHeaderTimeout: 10 * time.Second}
	controlServer := &http.Server{Handler: http.HandlerFunc(s.controlHandler), ReadHeaderTimeout: 10 * time.Second}
	go agentServer.Serve(agentListener)
	go controlServer.Serve(controlListener)
	// What a caller that asked for port 0 needs: the addresses it got.
	fmt.Printf("listening %s\ncontrol %s\n", agentListener.Addr(), controlListener.Addr())

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-signals:
	case <-s.stop:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = agentServer.Shutdown(ctx)
	_ = controlServer.Shutdown(ctx)
	return nil
}

func (s *server) now() time.Time { return time.Now().UTC().Truncate(time.Second) }

// ---------------------------------------------------------------- the agent listener

func (s *server) agent(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/agent/v1/heartbeat":
		s.heartbeat(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/agent/v1/wait":
		s.waitForChange(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/agent/v1/release-keys":
		s.keyBundle(w)
	case r.Method == http.MethodHead && r.URL.Path == "/agent/v1/install.sh":
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodGet && len(r.URL.Path) > len("/agent/v1/agent-releases/") && r.URL.Path[:len("/agent/v1/agent-releases/")] == "/agent/v1/agent-releases/":
		// No offer of this server is one a host may take, so no download is one this
		// server gives: a request for one is what the checks look for.
		s.mu.Lock()
		s.downloads = append(s.downloads, r.URL.Path)
		s.mu.Unlock()
		http.Error(w, `{"error":{"code":"FORBIDDEN"}}`, http.StatusForbidden)
	default:
		http.NotFound(w, r)
	}
}

// device is the device the client certificate names, or "" when there is none that
// the device CA signed.
func (s *server) device(r *http.Request) string {
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 {
		return ""
	}
	return r.TLS.VerifiedChains[0][0].Subject.CommonName
}

type request struct {
	Nonce        string          `json:"nonce"`
	BootID       string          `json:"boot_id"`
	AgentVersion string          `json:"agent_version"`
	AgentSHA256  string          `json:"agent_sha256"`
	AgentUpdate  json.RawMessage `json:"agent_update"`
}

type envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type manifest struct {
	ProtocolVersion  int             `json:"protocol_version"`
	DeviceID         string          `json:"device_id"`
	Nonce            string          `json:"nonce"`
	IssuedAt         time.Time       `json:"issued_at"`
	ExpiresAt        time.Time       `json:"expires_at"`
	Generation       uint64          `json:"generation"`
	PolicyGeneration uint64          `json:"policy_generation"`
	Policy           json.RawMessage `json:"policy"`
	Desired          json.RawMessage `json:"desired,omitempty"`
	Features         []string        `json:"features"`
	AgentUpdate      *offer          `json:"agent_update,omitempty"`
}

func (s *server) heartbeat(w http.ResponseWriter, r *http.Request) {
	device := s.device(r)
	if device == "" {
		http.Error(w, `{"error":{"code":"UNAUTHENTICATED"}}`, http.StatusUnauthorized)
		return
	}
	var req request
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil || req.Nonce == "" {
		http.Error(w, `{"error":{"code":"INVALID_INPUT"}}`, http.StatusBadRequest)
		return
	}
	state, err := readAgentState(s.cfg.agentState)
	if err != nil {
		http.Error(w, `{"error":{"code":"INTERNAL"}}`, http.StatusInternalServerError)
		fmt.Fprintln(os.Stderr, "agent state:", err)
		return
	}
	payload := manifest{
		ProtocolVersion: 1, DeviceID: device, Nonce: req.Nonce, IssuedAt: s.now(), ExpiresAt: s.now().Add(4 * time.Minute),
		Generation: state.HighestGeneration, PolicyGeneration: state.HighestPolicyGeneration,
		Policy: state.Policy, Desired: state.Desired, Features: []string{"wake", "agent_update"},
	}
	s.mu.Lock()
	name := s.scenario
	var chosen *crafted
	if name != "" {
		var err error
		if chosen, err = s.craftLocked(name); err != nil {
			s.mu.Unlock()
			http.Error(w, `{"error":{"code":"INTERNAL"}}`, http.StatusInternalServerError)
			fmt.Fprintln(os.Stderr, "scenario", name+":", err)
			return
		}
		payload.AgentUpdate = &chosen.Offer
	}
	s.beats = append(s.beats, heartbeat{At: s.now(), Scenario: name, AgentVersion: req.AgentVersion, AgentSHA256: req.AgentSHA256, BootID: req.BootID, AgentUpdate: req.AgentUpdate, AnsweredOffer: chosen != nil})
	if len(s.beats) > 50 {
		s.beats = s.beats[len(s.beats)-50:]
	}
	s.total++
	// What an agent reports in a check-in is what it made of the answer to the one
	// before, so a verdict on an offer arrives in the check-in after the one that
	// carried it. The agent is asked to check in again a few seconds after each of
	// the first two answers with an offer, so that a verdict doesn't wait for its
	// interval.
	if chosen != nil && s.nudges > 0 {
		s.nudges--
		time.AfterFunc(3*time.Second, s.wakeAll)
	}
	s.mu.Unlock()

	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, `{"error":{"code":"INTERNAL"}}`, http.StatusInternalServerError)
		return
	}
	reply, err := json.Marshal(envelope{Payload: base64.StdEncoding.EncodeToString(body), Signature: base64.StdEncoding.EncodeToString(signWith(s.inst.signing, body))})
	if err != nil {
		http.Error(w, `{"error":{"code":"INTERNAL"}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(reply)
}

// waitForChange parks the agent's wait until a scenario is selected, which asks it
// to check in at once, or for 20 seconds, which is shorter than the agent's own
// limit on a request.
func (s *server) waitForChange(w http.ResponseWriter, r *http.Request) {
	if s.device(r) == "" {
		http.Error(w, `{"error":{"code":"UNAUTHENTICATED"}}`, http.StatusUnauthorized)
		return
	}
	s.mu.Lock()
	wake := s.wake
	s.mu.Unlock()
	changed := false
	select {
	case <-wake:
		changed = true
	case <-time.After(20 * time.Second):
	case <-r.Context().Done():
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"changed":%t}`, changed)
}

// ---------------------------------------------------------------- the key bundle

func (s *server) keyBundle(w http.ResponseWriter) {
	s.mu.Lock()
	mode := s.bundleMode
	s.bundleHits++
	s.mu.Unlock()
	bundle, err := s.bundle(mode)
	if err != nil {
		http.Error(w, `{"error":{"code":"INTERNAL"}}`, http.StatusInternalServerError)
		fmt.Fprintln(os.Stderr, "bundle:", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(bundle)
}

// ---------------------------------------------------------------- the control port

func (s *server) controlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Hostile-Token") != s.cfg.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	reply := func(status int, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/scenario":
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			reply(http.StatusBadRequest, map[string]string{"error": "the body is {\"name\": ...}"})
			return
		}
		s.mu.Lock()
		if body.Name != "" {
			if _, known := scenarioByName(body.Name); !known {
				s.mu.Unlock()
				reply(http.StatusNotFound, map[string]string{"error": "no scenario " + body.Name})
				return
			}
			// A scenario is crafted again each time it is selected, from what the host
			// is now: its floors, and the key it pins.
			delete(s.crafted, body.Name)
			if _, err := s.craftLocked(body.Name); err != nil {
				s.mu.Unlock()
				reply(http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
		}
		s.scenario = body.Name
		s.beats, s.downloads, s.nudges = nil, nil, 2
		s.mu.Unlock()
		s.wakeAll()
		reply(http.StatusOK, map[string]string{"scenario": body.Name})
	case r.Method == http.MethodPost && r.URL.Path == "/bundle":
		var body struct {
			Mode string `json:"mode"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || (body.Mode != "honest" && body.Mode != "lies") {
			reply(http.StatusBadRequest, map[string]string{"error": "the body is {\"mode\": \"honest\"|\"lies\"}"})
			return
		}
		s.mu.Lock()
		s.bundleMode, s.bundleHits = body.Mode, 0
		s.mu.Unlock()
		reply(http.StatusOK, map[string]string{"mode": body.Mode})
	case r.Method == http.MethodGet && r.URL.Path == "/state":
		s.mu.Lock()
		// A list that is empty is [], so a check can compare it with one.
		state := map[string]any{
			"scenario": s.scenario, "heartbeats": s.total, "recent": nonNil(s.beats), "downloads": nonNil(s.downloads),
			"bundle_mode": s.bundleMode, "bundle_requests": s.bundleHits,
		}
		if s.scenario != "" {
			if chosen := s.crafted[s.scenario]; chosen != nil {
				state["expected_code"] = chosen.Code
			}
		}
		s.mu.Unlock()
		reply(http.StatusOK, state)
	case r.Method == http.MethodPost && r.URL.Path == "/stop":
		reply(http.StatusOK, map[string]string{"stopping": "yes"})
		select {
		case <-s.stop:
		default:
			close(s.stop)
		}
	default:
		http.NotFound(w, r)
	}
}

// nonNil makes a list that has nothing in it encode as [] and not as null.
func nonNil[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}
