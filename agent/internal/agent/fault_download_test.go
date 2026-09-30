package agent

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// downloadFault serves the new configuration the way a failing network does.
type downloadFault struct {
	name string
	// serve answers the artifact request; body is the true configuration.
	serve func(w http.ResponseWriter, r *http.Request, body []byte)
	// issue is the failure the device reports: its code, the diagnostic's code
	// and the words the diagnostic must contain.
	issue, finding, says string
	// timeout is the client's time limit, for a download that stalls.
	timeout time.Duration
}

func downloadFaults() []downloadFault {
	half := func(b []byte) []byte { return b[:len(b)/2] }
	return []downloadFault{
		{name: "connection closed after half of a declared length",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				_, _ = w.Write(half(body))
				w.(http.Flusher).Flush()
				panic(http.ErrAbortHandler)
			},
			issue: "DOWNLOAD_FAILED", finding: "DOWNLOAD_INTERRUPTED", says: "closed the connection before the whole configuration arrived"},
		{name: "connection dropped before the last chunk",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				_, _ = w.Write(half(body))
				w.(http.Flusher).Flush()
				panic(http.ErrAbortHandler)
			},
			issue: "DOWNLOAD_FAILED", finding: "DOWNLOAD_INTERRUPTED", says: "closed the connection before the whole configuration arrived"},
		{name: "server stops sending",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				_, _ = w.Write(half(body))
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			},
			timeout: 400 * time.Millisecond,
			issue:   "DOWNLOAD_FAILED", finding: "DOWNLOAD_INTERRUPTED", says: "stopped sending the configuration before it was complete"},
		{name: "a shorter configuration with a matching length",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) { _, _ = w.Write(half(body)) },
			issue: "DIGEST_MISMATCH", finding: "ARTIFACT_MISMATCH", says: "arrived with"},
		{name: "a longer configuration",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				_, _ = w.Write(append(append([]byte{}, body...), `{"extra":true}`...))
			},
			issue: "DIGEST_MISMATCH", finding: "ARTIFACT_MISMATCH", says: "the signed manifest says"},
		{name: "other bytes of the right length",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				altered := append([]byte{}, body...)
				altered[len(altered)/2] ^= 0x01
				_, _ = w.Write(altered)
			},
			issue: "DIGEST_MISMATCH", finding: "ARTIFACT_MISMATCH", says: "SHA-256 of the configuration does not match the signed manifest"},
		{name: "a download that never ends",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				chunk := make([]byte, 64<<10)
				for i := 0; i < 1024; i++ {
					if _, err := w.Write(chunk); err != nil {
						return
					}
				}
			},
			issue: "DOWNLOAD_FAILED", finding: "DOWNLOAD_TOO_LARGE", says: "more than the 1024 KiB a configuration may have"},
		{name: "a refusal",
			serve: func(w http.ResponseWriter, r *http.Request, body []byte) {
				http.Error(w, "denied", http.StatusForbidden)
			},
			issue: "DOWNLOAD_FAILED", finding: "FORBIDDEN", says: "The server refused the request"},
	}
}

// downloadServer is a server whose artifact endpoint fails as its fault says
// until heal is called, and counts the requests it gets.
type downloadServer struct {
	*httptest.Server
	mu       sync.Mutex
	fault    *downloadFault
	requests atomic.Int32
}

func newDownloadServer(t *testing.T, body []byte, fault *downloadFault) *downloadServer {
	t.Helper()
	s := &downloadServer{fault: fault}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		s.mu.Lock()
		current := s.fault
		s.mu.Unlock()
		if current == nil {
			_, _ = w.Write(body)
			return
		}
		current.serve(w, r, body)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *downloadServer) heal() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fault = nil
}

// countedClient is a client to the server that counts the response bytes the
// agent reads, to show that it never reads more than a configuration may have.
func (s *downloadServer) countedClient(timeout time.Duration, read *atomic.Int64) *Client {
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &Client{Base: s.URL, HTTP: &http.Client{Timeout: timeout, Transport: countingTransport{base: s.Client().Transport, read: read}}}
}

type countingTransport struct {
	base http.RoundTripper
	read *atomic.Int64
}

func (t countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	res, err := t.base.RoundTrip(r)
	if err == nil {
		res.Body = &countingBody{ReadCloser: res.Body, read: t.read}
	}
	return res, err
}

type countingBody struct {
	io.ReadCloser
	read *atomic.Int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.read.Add(int64(n))
	return n, err
}

// A download that is cut off, comes up short or long, arrives altered, never
// ends or is refused activates nothing: the managed file, the last known good
// and Vector are untouched, no partial file is written, the failure says what
// happened and what comes next, and the retry is one attempt per check-in.
func TestInterruptedOrAlteredDownloadActivatesNothing(t *testing.T) {
	for _, fault := range downloadFaults() {
		t.Run(fault.name, func(t *testing.T) {
			d := newApplyDevice(t)
			server := newDownloadServer(t, newConfig, &fault)
			var read atomic.Int64
			d.e.Client = server.countedClient(fault.timeout, &read)
			ctx := context.Background()

			if err := d.e.Reconcile(ctx, d.m); err == nil {
				t.Fatal("a failed download was reported as success")
			}
			issue := d.e.State.Error
			if d.e.State.ApplyState != "failed" || issue == nil || issue.Code != fault.issue || issue.Stage != "download" {
				t.Fatalf("state %s, issue %+v", d.e.State.ApplyState, issue)
			}
			found := diagnostic(issue, fault.finding)
			if found == nil || !strings.Contains(found.Message, fault.says) || !strings.Contains(found.Hint, "Nothing was applied") {
				t.Fatalf("the diagnostic doesn't say what happened: %+v", issue.Diagnostics)
			}
			if read.Load() > MaxArtifact+1 {
				t.Fatalf("the agent read %d bytes of a download", read.Load())
			}
			d.requireIntact(t)
			if d.driver.starts != 0 || !d.driver.Alive() {
				t.Fatal("Vector was touched by a download that failed")
			}
			if managed, _ := os.ReadFile(d.managed); Digest(managed) != Digest(oldConfig) {
				t.Fatal("the managed file changed")
			}
			if cached, _ := filepath.Glob(filepath.Join(d.e.Dir, "template-*.json")); len(cached) != 0 {
				t.Fatalf("a download that failed left a cached file: %v", cached)
			}
			for _, name := range []string{"journal.json", "pre-attempt.json"} {
				if _, err := os.Stat(filepath.Join(d.e.Dir, name)); !os.IsNotExist(err) {
					t.Fatalf("%s exists before anything was committed", name)
				}
			}
			if d.e.State.FailedGeneration != nil {
				t.Fatal("a download failure held the version back from the next attempt")
			}

			// The retry is one attempt at the next check-in.
			before := server.requests.Load()
			if err := d.e.Reconcile(ctx, d.m); err == nil {
				t.Fatal("the second attempt was reported as success")
			}
			if made := server.requests.Load() - before; made != 1 {
				t.Fatalf("one check-in made %d download attempts", made)
			}

			// Once the network works, the next check-in applies the version.
			server.heal()
			d.e.Client = server.countedClient(0, &read)
			if err := d.e.Reconcile(ctx, d.m); err != nil {
				t.Fatalf("the next check-in didn't recover: %v", err)
			}
			d.requireConverged(t)
		})
	}
}

// A cached copy of the configuration that was cut short, by a crash or a full
// disk, is never trusted: it is downloaded again and replaced whole.
func TestTruncatedCachedConfigurationIsDownloadedAgain(t *testing.T) {
	d := newApplyDevice(t)
	server := newDownloadServer(t, newConfig, nil)
	d.e.Client = &Client{HTTP: server.Client(), Base: server.URL}
	cache := filepath.Join(d.e.Dir, "template-"+d.m.Desired.SHA256+".json")
	if err := os.WriteFile(cache, newConfig[:len(newConfig)/2], 0600); err != nil {
		t.Fatal(err)
	}
	if err := d.e.Reconcile(context.Background(), d.m); err != nil {
		t.Fatal(err)
	}
	if server.requests.Load() != 1 {
		t.Fatalf("the truncated cache was used: %d downloads", server.requests.Load())
	}
	if got, err := os.ReadFile(cache); err != nil || Digest(got) != d.m.Desired.SHA256 {
		t.Fatalf("the cache wasn't replaced whole: %v", err)
	}
	d.requireConverged(t)
}

// What a killed agent leaves behind is removed at the next start, once it is
// old enough that no write or validation of another process can own it, and
// nothing else is touched.
func TestStartupRemovesStaleLeftoversOnly(t *testing.T) {
	d := newApplyDevice(t)
	stale := time.Now().Add(-2 * atomicTempStale)
	managedDir := filepath.Dir(d.managed)
	names := map[string]string{
		filepath.Join(d.e.Dir, atomicTempPrefix+"111"):                     "stale temporary file, state directory",
		filepath.Join(managedDir, atomicTempPrefix+"222"):                  "stale temporary file, managed directory",
		filepath.Join(managedDir, ".vectory-stage-abc123.json"):            "stale staged candidate",
		filepath.Join(d.e.Dir, "host-runtime-stage-0123456789abcdef.json"): "stale validation copy of runtime settings",
	}
	for path := range names {
		if err := os.WriteFile(path, []byte(`{"partial`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, stale, stale); err != nil {
			t.Fatal(err)
		}
	}
	recent := filepath.Join(managedDir, ".vectory-stage-def456.json")
	unrelated := filepath.Join(d.e.Dir, "operator-notes.txt")
	for _, path := range []string{recent, unrelated} {
		if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(unrelated, stale, stale); err != nil {
		t.Fatal(err)
	}
	if err := d.e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	for path, what := range names {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s was kept", what)
		}
	}
	for _, path := range []string{recent, unrelated, d.managed, filepath.Join(d.e.Dir, "good-"+Digest(oldConfig)+".json")} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("%s was removed", filepath.Base(path))
		}
	}
}

// Failed check-ins are retried at a bounded pace: the wait doubles from ten
// seconds to five minutes and stays there, and a healthy agent keeps its policy.
func TestCheckInRetryIsBounded(t *testing.T) {
	want := []int{10, 20, 40, 80, 160, 300, 300, 300, 300, 300}
	for i, seconds := range want {
		if got := checkInSeconds(Policy{HeartbeatSeconds: 60}, i+1); got != seconds {
			t.Fatalf("after %d failures: %d s, want %d", i+1, got, seconds)
		}
	}
	for failures := 1; failures < 100000; failures *= 7 {
		if got := checkInSeconds(Policy{HeartbeatSeconds: 3600}, failures); got < 10 || got > 300 {
			t.Fatalf("after %d failures: %d s", failures, got)
		}
	}
	for policy, seconds := range map[int]int{0: 60, 9: 60, 10: 10, 45: 45, 3600: 3600, 3601: 60} {
		if got := checkInSeconds(Policy{HeartbeatSeconds: policy}, 0); got != seconds {
			t.Fatalf("policy %d: %d s, want %d", policy, got, seconds)
		}
	}
}
