package agent

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// killControlPlane is the server the crash tests' agent checks in with: it
// signs a manifest for the new version for every heartbeat, serves that
// version, and records what each heartbeat said.
type killControlPlane struct {
	*httptest.Server
	mu    sync.Mutex
	beats []map[string]any
	// manifest is what the heartbeats are answered with; setManifest changes it.
	manifest Manifest
}

// setManifest changes the manifest the next heartbeats are answered with.
func (p *killControlPlane) setManifest(m Manifest) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.manifest = m
}

func newKillControlPlane(t *testing.T, m Manifest, key ed25519.PrivateKey, artifact []byte) *killControlPlane {
	t.Helper()
	plane := &killControlPlane{manifest: m}
	plane.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agent/v1/heartbeat":
			var beat map[string]any
			if err := json.NewDecoder(r.Body).Decode(&beat); err != nil {
				http.Error(w, "bad", http.StatusBadRequest)
				return
			}
			plane.mu.Lock()
			plane.beats = append(plane.beats, beat)
			signedManifest := plane.manifest
			plane.mu.Unlock()
			signedManifest.Nonce, _ = beat["nonce"].(string)
			signedManifest.IssuedAt = time.Now().UTC()
			signedManifest.ExpiresAt = signedManifest.IssuedAt.Add(5 * time.Minute)
			_ = json.NewEncoder(w).Encode(signed(t, signedManifest, key))
		case m.Desired.ArtifactPath:
			_, _ = w.Write(artifact)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(plane.Close)
	return plane
}

func (p *killControlPlane) heartbeats() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.beats...)
}

// killChild is a running agent process.
type killChild struct {
	cmd   *exec.Cmd
	lines chan string
}

func startKillChild(t *testing.T, request killRequest) *killChild {
	t.Helper()
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	for _, entry := range os.Environ() {
		if !strings.HasSuffix(strings.ToUpper(strings.SplitN(entry, "=", 2)[0]), "_PROXY") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, killHelperEnv+"="+string(raw))
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	child := &killChild{cmd: cmd, lines: make(chan string, 64)}
	go func() {
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			child.lines <- scanner.Text()
		}
		close(child.lines)
	}()
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return child
}

// waitFor returns when the child has printed line.
func (c *killChild) waitFor(t *testing.T, line string) {
	t.Helper()
	deadline := time.After(45 * time.Second)
	for {
		select {
		case got, ok := <-c.lines:
			if !ok {
				t.Fatalf("the agent process ended before %q", line)
			}
			if got == line {
				return
			}
		case <-deadline:
			t.Fatalf("the agent process never reached %q", line)
		}
	}
}

// kill ends the process the hard way and waits for the system to say it is gone.
func (c *killChild) kill(t *testing.T) {
	t.Helper()
	if err := c.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = c.cmd.Wait()
}

// finish reads what a child that runs to its end reports.
func (c *killChild) finish(t *testing.T) []killSnapshot {
	t.Helper()
	var snapshots []killSnapshot
	deadline := time.After(60 * time.Second)
	for {
		select {
		case line, ok := <-c.lines:
			if !ok {
				if err := c.cmd.Wait(); err != nil {
					t.Fatalf("the restarted agent failed: %v", err)
				}
				return snapshots
			}
			var snapshot killSnapshot
			if err := json.Unmarshal([]byte(line), &snapshot); err != nil {
				t.Fatalf("the restarted agent said %q", line)
			}
			snapshots = append(snapshots, snapshot)
		case <-deadline:
			t.Fatal("the restarted agent never finished")
		}
	}
}

func snapshotAt(t *testing.T, snapshots []killSnapshot, step string) killSnapshot {
	t.Helper()
	for _, snapshot := range snapshots {
		if snapshot.Step == step {
			return snapshot
		}
	}
	t.Fatalf("the restarted agent never reported %q: %+v", step, snapshots)
	return killSnapshot{}
}

// killStage is what a process killed at one boundary of the apply leaves on
// disk, and where a restart takes the device.
type killStage struct {
	name string
	// managed is what the managed file holds when the process dies, journal the
	// stage of the recovery journal then ("" for none).
	managed, journal string
	// afterRestart says where recovery leaves the device before it checks in
	// again: "old" (the previous verified configuration, the candidate held
	// back), "new" (the new version, durably verified) or "pending" (the old
	// configuration, the candidate not started and not held).
	afterRestart string
}

var killStages = []killStage{
	{"accepted", "old", "", "pending"},
	{"validated", "old", "", "pending"},
	{"prepared", "old", "prepared", "old"},
	{"written", "new", "written", "old"},
	{"reload_requested", "new", "written", "old"},
	{"activated", "new", "written", "old"},
	{"verified", "new", "written", "new"},
}

// The agent process is killed for real at every boundary of the apply
// transaction, and restarted. Whatever the boundary, the managed file is
// complete (the old configuration or the new one, never part of either), the
// last known good survives, the killed process's lock is free, recovery is
// deterministic (the previous verified configuration or the new verified one),
// and a device whose old Vector still runs is never reported as having
// applied the new version.
func TestKillAtEveryApplyBoundaryRecoversDeterministically(t *testing.T) {
	for _, stage := range killStages {
		t.Run(stage.name, func(t *testing.T) {
			d := newApplyDevice(t)
			publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			plane := newKillControlPlane(t, d.m, privateKey, newConfig)
			request := killRequest{Dir: d.e.Dir, Managed: d.managed, Server: plane.URL, PublicKey: base64.StdEncoding.EncodeToString(publicKey)}
			digests := map[string]string{"old": Digest(oldConfig), "new": Digest(newConfig)}

			// Apply, and kill the process exactly at the boundary.
			apply := request
			apply.Mode, apply.Stop = "apply", stage.name
			child := startKillChild(t, apply)
			child.waitFor(t, "stage "+stage.name)
			child.kill(t)

			managed, err := os.ReadFile(d.managed)
			if err != nil || Digest(managed) != digests[stage.managed] {
				t.Fatalf("the managed file is %q after a kill at %s: %v", managed, stage.name, err)
			}
			d.e.State.ReportedGeneration = 0
			durable, err := LoadState(d.e.Dir)
			if err != nil {
				t.Fatalf("the state is unreadable after the kill: %v", err)
			}
			good, err := os.ReadFile(filepath.Join(d.e.Dir, "good-"+durable.LastGoodSHA256+".json"))
			if err != nil || Digest(good) != durable.LastGoodSHA256 {
				t.Fatalf("the last known good is lost or damaged after the kill: %v", err)
			}
			if stage.name != "verified" && (durable.LastGoodSHA256 != digests["old"] || durable.ReportedGeneration != 1) {
				t.Fatalf("the state already claims the new version: %+v", durable)
			}
			if got := journalStage(t, d.e.Dir); got != stage.journal {
				t.Fatalf("journal %q, want %q", got, stage.journal)
			}
			if stage.name != "accepted" {
				// Killed mid-transaction: only files the agent itself owns are
				// left, and setup accepts the folder.
				for _, dir := range []string{d.e.Dir, filepath.Dir(d.managed)} {
					entries, _ := os.ReadDir(dir)
					for _, entry := range entries {
						if strings.HasPrefix(entry.Name(), ".") && !agentLeftover(entry.Name()) {
							t.Fatalf("unknown hidden file %s", entry.Name())
						}
					}
				}
				if err := checkManagedDirectory(d.managed, filepath.Join(t.TempDir(), "state"), false); err != nil {
					t.Fatalf("leftovers of the killed process block setup: %v", err)
				}
			}

			// Restart it, as the service manager does.
			beforeRestart := len(plane.heartbeats())
			restart := request
			restart.Mode = "restart"
			snapshots := startKillChild(t, restart).finish(t)
			if !snapshotAt(t, snapshots, "locked").Locked {
				t.Fatal("the restarted agent could not take the lock")
			}
			recovered := snapshotAt(t, snapshots, "recovered")
			started := snapshotAt(t, snapshots, "started")
			final := snapshotAt(t, snapshots, "checked in")
			for _, snapshot := range []killSnapshot{recovered, started} {
				if snapshot.Error != "" {
					t.Fatalf("%s failed: %s", snapshot.Step, snapshot.Error)
				}
			}
			if recovered.Journal {
				t.Fatal("recovery left its journal behind")
			}
			if !started.Alive {
				t.Fatal("the restarted agent didn't start Vector")
			}
			switch stage.afterRestart {
			case "old", "pending":
				if recovered.ManagedSHA256 != digests["old"] || started.ManagedSHA256 != digests["old"] || started.LastGoodSHA256 != digests["old"] || started.ReportedGeneration != 1 || started.ApplyState == "verified_applied" && started.ReportedGeneration != 1 {
					t.Fatalf("recovery didn't return to the previous verified configuration: %+v", started)
				}
				if held := started.Held; held != (stage.afterRestart == "old") {
					t.Fatalf("held back: %v, want %v", held, stage.afterRestart == "old")
				}
			case "new":
				if recovered.ManagedSHA256 != digests["new"] || started.LastGoodSHA256 != digests["new"] || started.ReportedGeneration != 2 || started.ApplyState != "verified_applied" {
					t.Fatalf("recovery lost a durably verified configuration: %+v", started)
				}
			}
			// The first heartbeat after the restart reports what is true.
			beats := plane.heartbeats()
			if len(beats) <= beforeRestart {
				t.Fatal("the restarted agent never checked in")
			}
			first := beats[beforeRestart]
			generation, _ := first["reported_generation"].(float64)
			if stage.name != "verified" && (uint64(generation) != 1 || first["actual_sha256"] != digests["old"]) {
				t.Fatalf("a device whose old Vector runs reported %v (%v) after the restart", first["reported_generation"], first["actual_sha256"])
			}
			if stage.name != "verified" && first["apply_state"] == "verified_applied" && first["actual_sha256"] != digests["old"] {
				t.Fatal("the restarted agent claims a version it does not run")
			}

			switch stage.afterRestart {
			case "pending":
				// Nothing was held back: the next check-in applies the version.
				if final.ApplyState != "verified_applied" || final.ReportedGeneration != 2 || final.ManagedSHA256 != digests["new"] {
					t.Fatalf("the next check-in didn't apply the version: %+v", final)
				}
			case "old":
				// A version whose apply was interrupted is held back like a
				// failed one, until a retry is asked for.
				if final.ApplyState != "rolled_back" || final.ReportedGeneration != 1 || final.ManagedSHA256 != digests["old"] {
					t.Fatalf("an interrupted version changed the device without a retry: %+v", final)
				}
				if err := QueueRetry(d.e.Dir); err != nil {
					t.Fatal(err)
				}
				retry := request
				retry.Mode, retry.Retry = "restart", true
				snapshots = startKillChild(t, retry).finish(t)
				_ = snapshotAt(t, snapshots, "retry taken")
				final = snapshotAt(t, snapshots, "checked in")
				fallthrough
			case "new":
				if final.ApplyState != "verified_applied" || final.ReportedGeneration != 2 || final.ManagedSHA256 != digests["new"] || final.LastGoodSHA256 != digests["new"] || final.Journal {
					t.Fatalf("the device doesn't end on the new verified version: %+v", final)
				}
			}
		})
	}
}
