package agent

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// tarpit is a loopback destination that accepts connections and never answers
// them, and notices when the peer goes away.
type tarpit struct {
	listener net.Listener
	mu       sync.Mutex
	accepted int
	gone     int
}

func newTarpit(t *testing.T) *tarpit {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &tarpit{listener: listener}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			p.accepted++
			p.mu.Unlock()
			go func() {
				defer conn.Close()
				buf := make([]byte, 4096)
				for {
					// The requests are read and never answered: only the peer
					// going away ends this.
					if _, err := conn.Read(buf); err != nil {
						p.mu.Lock()
						p.gone++
						p.mu.Unlock()
						return
					}
				}
			}()
		}
	}()
	return p
}

func (p *tarpit) counts() (accepted, gone int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.accepted, p.gone
}

// A real `vector validate` that outlasts the time limit is killed and its
// version is rejected as unverified, while the Vector that runs the old
// configuration is the same process, untouched. The candidate has a sink whose
// health check never gets an answer, so validation waits for it.
func TestNativeValidationTimeoutKillsVectorAndKeepsTheOldConfiguration(t *testing.T) {
	e, driver := nativeRuntimeFixture(t)
	ctx := context.Background()
	managed := e.Settings.ManagedConfig

	old := writeManaged(t, managed, pipeline(nil))
	if err := driver.Validate(ctx, managed); err != nil {
		t.Fatal(err)
	}
	if err := driver.Activate(ctx, managed); err != nil || !driver.Alive() {
		t.Fatalf("the old configuration didn't start: %v", err)
	}
	child := driver.child
	if err := AtomicWrite(filepath.Join(e.Dir, "good-"+Digest(old)+".json"), old); err != nil {
		t.Fatal(err)
	}

	pit := newTarpit(t)
	candidate := []byte(`{"sources":{"app":{"type":"demo_logs","format":"json","interval":0.5}},"sinks":{"discard":{"type":"blackhole","inputs":["app"]},"es":{"type":"elasticsearch","inputs":["app"],"endpoints":["http://` + pit.listener.Addr().String() + `"],"api_version":"v8"}}}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(candidate) }))
	defer server.Close()
	m := sampleManifest()
	m.Desired = &Desired{VersionID: "v2", SHA256: Digest(candidate), Size: int64(len(candidate)), ArtifactPath: "/agent/v1/artifacts/" + Digest(candidate), VectorVersion: VectorVersion}
	e.State = State{Accepted: true, HighestGeneration: m.Generation, HighestPolicyGeneration: m.PolicyGeneration, DesiredIdentity: Identity(m.Desired), PolicyIdentity: Identity(m.Policy), Desired: m.Desired, Policy: m.Policy, LastGoodSHA256: Digest(old), ReportedGeneration: 1, ApplyState: "verified_applied"}
	e.Settings.ValidationSeconds, driver.Settings.ValidationSeconds = 1, 1
	e.Client = &Client{HTTP: server.Client(), Base: server.URL}
	if err := e.save(); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	if err := e.Reconcile(ctx, m); err == nil {
		t.Fatal("a validation that timed out was treated as valid")
	}
	if took := time.Since(started); took < time.Second || took > 8*time.Second {
		t.Fatalf("validation ended after %s: killed at its one-second limit, not at Vector's ten-second health check", took)
	}
	issue := e.State.Error
	found := diagnostic(issue, "VECTOR_TIMEOUT")
	if e.State.ApplyState != "failed" || issue == nil || issue.Code != "VALIDATION_FAILED" || found == nil || !strings.Contains(found.Message, "within 1 s") {
		t.Fatalf("state %s, issue %+v", e.State.ApplyState, issue)
	}
	if e.State.FailedGeneration == nil {
		t.Fatal("a version that could not be verified isn't held back")
	}

	// The validating Vector connected to the destination, and it is gone: its
	// connection ended, which only its death explains.
	deadline := time.Now().Add(10 * time.Second)
	for {
		accepted, gone := pit.counts()
		if accepted > 0 && gone == accepted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the validating Vector was not stopped: %d connections, %d ended", accepted, gone)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// The running Vector is the same process, still on the old configuration.
	if !driver.Alive() || driver.child != child {
		t.Fatal("the running Vector was replaced or stopped by a validation that timed out")
	}
	if got, _ := os.ReadFile(managed); Digest(got) != Digest(old) {
		t.Fatal("the managed configuration changed")
	}
	if got, err := os.ReadFile(filepath.Join(e.Dir, "good-"+Digest(old)+".json")); err != nil || Digest(got) != Digest(old) {
		t.Fatalf("the last known good is damaged: %v", err)
	}
	for _, dir := range []string{e.Dir, filepath.Dir(managed)} {
		if left := leftovers(t, dir); len(left) != 0 {
			t.Fatalf("temporary files left in %s: %v", dir, left)
		}
	}
}
