package agent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The transfer of a build: it arrives whole and as signed, or nothing is left
// under a final name. A server that cuts it off, sends too much or too little,
// sends other bytes, refuses, is busy, stalls or takes too long is answered with
// the agent code of the contract, and the agent tries again at its next check-in,
// three times in all.

func withDownloadLimits(t *testing.T, deadline, stall time.Duration) {
	t.Helper()
	oldDeadline, oldStall := updateDownloadDeadline, updateDownloadStall
	updateDownloadDeadline, updateDownloadStall = deadline, stall
	t.Cleanup(func() { updateDownloadDeadline, updateDownloadStall = oldDeadline, oldStall })
}

// untilFailed runs check-ins until the host has settled a transfer and says what
// it reports, at most ten times.
func (r *offerRig) untilReports(state string) map[string]any {
	r.t.Helper()
	for i := 0; i < 12; i++ {
		r.settle()
		r.poll()
		if beat := r.beat(); beat != nil && beat["state"] == state {
			return beat
		}
	}
	r.t.Fatalf("the host never reported %s: %v", state, r.beat())
	return nil
}

func (r *offerRig) neverLeftAFileUnderAFinalName() {
	r.t.Helper()
	for _, name := range []string{UpdateBuildFile(runtime.GOOS), UpdateBuildPartFile} {
		if _, err := os.Lstat(r.stagedFile(name)); !os.IsNotExist(err) {
			r.t.Fatalf("%s was left behind: %v", name, err)
		}
	}
	if _, err := os.Lstat(r.exchange().Request); !os.IsNotExist(err) {
		r.t.Fatalf("a request was written for a build that never arrived: %v", err)
	}
}

func TestACutOffTransferLeavesNothingAndIsTriedAgainThreeTimes(t *testing.T) {
	rig := newOfferRig(t)
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
		_, _ = w.Write(rig.build[:len(rig.build)/2])
		panic(http.ErrAbortHandler)
	})
	rig.settle()
	if beat := rig.beat(); beat["state"] != "downloading" {
		t.Fatalf("after the first failure the host reports %v", beat)
	}
	if rig.e.update.failures[rig.releaseSHA] != 1 {
		t.Fatalf("%d failures counted", rig.e.update.failures[rig.releaseSHA])
	}
	rig.neverLeftAFileUnderAFinalName()
	if !rig.said1("The download of agent update 0.1.1 failed (1 of 3): The server closed the connection before the whole build arrived. The agent tries again at its next check-in.") {
		t.Fatalf("the log said %q", rig.said)
	}
	beat := rig.untilReports("failed")
	if beat["code"] != "DOWNLOAD_FAILED" || beat["release"] != rig.releaseSHA {
		t.Fatalf("after three failures the host reports %v", beat)
	}
	if rig.requests() != 3 {
		t.Fatalf("the build was asked for %d times", rig.requests())
	}
	rig.neverLeftAFileUnderAFinalName()
	// It stops there, even when the server serves the build properly again.
	rig.answerWith(nil)
	rig.settle()
	rig.settle()
	if rig.requests() != 3 || rig.beat()["state"] != "failed" {
		t.Fatalf("a release that failed three times was tried again: %d requests, %v", rig.requests(), rig.beat())
	}
	if !rig.said1("The download of agent update 0.1.1 failed 3 times, and the agent stops trying it") {
		t.Fatalf("the log said %q", rig.said)
	}
}

func TestATransferWithTooManyOrTooFewBytesOrOtherBytesIsNotTheSignedBuild(t *testing.T) {
	flipped := func(b []byte) []byte {
		out := bytes.Clone(b)
		out[len(out)/3] ^= 0xff
		return out
	}
	for name, serve := range map[string]func(rig *offerRig) func(http.ResponseWriter, *http.Request){
		"an extra byte, announced": func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
			return func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)+1))
				_, _ = w.Write(append(bytes.Clone(rig.build), 'x'))
			}
		},
		"an extra byte, not announced": func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
			return func(w http.ResponseWriter, r *http.Request) {
				// No Content-Length: the response is chunked, and only the count can tell.
				w.(http.Flusher).Flush()
				_, _ = w.Write(append(bytes.Clone(rig.build), 'x'))
			}
		},
		"a byte short, not announced": func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
			return func(w http.ResponseWriter, r *http.Request) {
				w.(http.Flusher).Flush()
				_, _ = w.Write(rig.build[:len(rig.build)-1])
			}
		},
		"a byte short, announced": func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
			return func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)-1))
				_, _ = w.Write(rig.build[:len(rig.build)-1])
			}
		},
		"the right size and other bytes": func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
			return func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
				_, _ = w.Write(flipped(rig.build))
			}
		},
		"nothing": func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
			return func(w http.ResponseWriter, r *http.Request) {}
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			rig.answerWith(serve(rig))
			beat := rig.untilReports("failed")
			if beat["code"] != "ARTIFACT_MISMATCH" || beat["release"] != rig.releaseSHA {
				t.Fatalf("the host reports %v", beat)
			}
			if rig.requests() != 3 {
				t.Fatalf("%d requests", rig.requests())
			}
			rig.neverLeftAFileUnderAFinalName()
			if !rig.said1("The download of agent update 0.1.1 failed (1 of 3): ") {
				t.Fatalf("the log said %q", rig.said)
			}
		})
	}
}

// A build the server stopped offering is dropped, not counted against it, and not
// asked for again until a minute has passed.
func TestAServerThatStoppedOfferingTheBuildIsLeftAloneForAWhile(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			rig := newOfferRig(t)
			rig.answerWith(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", status) })
			rig.settle()
			rig.settle()
			if rig.requests() != 1 || rig.e.update.failures[rig.releaseSHA] != 0 {
				t.Fatalf("%d requests, %d failures", rig.requests(), rig.e.update.failures[rig.releaseSHA])
			}
			if beat := rig.beat(); beat["state"] != "idle" || beat["code"] != nil {
				t.Fatalf("after the server stopped serving the build the host reports %v", beat)
			}
			rig.neverLeftAFileUnderAFinalName()
			if !rig.said1("The server no longer serves agent update 0.1.1.") {
				t.Fatalf("the log said %q", rig.said)
			}
			// Not asked again at the next check-ins...
			rig.poll()
			rig.poll()
			if rig.requests() != 1 {
				t.Fatalf("the build was asked for again after %d requests", rig.requests())
			}
			// ...but when the time is up, and the server serves it again, it is staged.
			rig.answerWith(nil)
			rig.e.update.gone[rig.releaseSHA] = time.Now().Add(-updateGoneWait - time.Second)
			rig.untilReports("staged")
			if rig.requests() != 2 {
				t.Fatalf("%d requests", rig.requests())
			}
		})
	}
}

// A busy server is waited out for as long as it asks, and what it asked for is not
// held against it.
func TestABusyServerIsWaitedOutWithItsRetryAfter(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		header string
		wait   time.Duration
	}{
		"429 with Retry-After": {http.StatusTooManyRequests, "120", 120 * time.Second},
		"503 with Retry-After": {http.StatusServiceUnavailable, "45", 45 * time.Second},
		"503 with none":        {http.StatusServiceUnavailable, "", updateBusyWait},
		"429 with a date":      {http.StatusTooManyRequests, time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat), 90 * time.Second},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
				if tc.header != "" {
					w.Header().Set("Retry-After", tc.header)
				}
				http.Error(w, "busy", tc.status)
			})
			rig.settle()
			rig.settle()
			wait := time.Until(rig.e.update.retryAt)
			if wait > tc.wait+time.Second || wait < tc.wait-10*time.Second {
				t.Fatalf("the agent waits %s, the server asked for %s", wait, tc.wait)
			}
			if rig.e.update.failures[rig.releaseSHA] != 0 {
				t.Fatalf("a busy server was counted as a failure")
			}
			if beat := rig.beat(); beat["state"] != "downloading" || beat["code"] != nil {
				t.Fatalf("the host reports %v", beat)
			}
			// No request until the time is up.
			for i := 0; i < 3; i++ {
				rig.poll()
			}
			if rig.requests() != 1 {
				t.Fatalf("the build was asked for again after %d requests", rig.requests())
			}
			rig.answerWith(nil)
			rig.e.update.retryAt = time.Now().Add(-time.Second)
			rig.untilReports("staged")
			if rig.requests() != 2 {
				t.Fatalf("%d requests", rig.requests())
			}
			if !rig.said1("Downloading agent update 0.1.1 waits: The server is busy (HTTP " + strconv.Itoa(tc.status) + "). The agent asks again in ") {
				t.Fatalf("the log said %q", rig.said)
			}
		})
	}
}

// Any other answer is a failed transfer, and a redirect is never followed.
func TestAnyOtherAnswerIsAFailedTransferAndARedirectIsNeverFollowed(t *testing.T) {
	for name, serve := range map[string]func(w http.ResponseWriter, r *http.Request){
		"an internal error": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "broken", 500) },
		"a bad request":     func(w http.ResponseWriter, r *http.Request) { http.Error(w, "bad", 400) },
		"a redirect": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "http://127.0.0.1:1/elsewhere", http.StatusFound)
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newOfferRig(t)
			rig.answerWith(serve)
			beat := rig.untilReports("failed")
			if beat["code"] != "DOWNLOAD_FAILED" || rig.requests() != 3 {
				t.Fatalf("%v after %d requests", beat, rig.requests())
			}
			rig.neverLeftAFileUnderAFinalName()
		})
	}
}

// A server that goes quiet for longer than the stall limit, or that takes longer
// than the deadline, loses the transfer; the partial build goes with it.
func TestAStalledOrTooSlowTransferIsGivenUp(t *testing.T) {
	trickle := func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
			for i := 0; i < len(rig.build); i += 1000 {
				if _, err := w.Write(rig.build[i : i+1000]); err != nil {
					return
				}
				w.(http.Flusher).Flush()
				select {
				case <-time.After(60 * time.Millisecond):
				case <-r.Context().Done():
					return
				}
			}
		}
	}
	stall := func(rig *offerRig) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
			_, _ = w.Write(rig.build[:5000])
			w.(http.Flusher).Flush()
			select {
			case <-time.After(10 * time.Second):
			case <-r.Context().Done():
			}
		}
	}
	for name, tc := range map[string]struct {
		serve         func(*offerRig) func(http.ResponseWriter, *http.Request)
		deadline, gap time.Duration
		said          string
	}{
		"a stall":    {stall, time.Minute, 700 * time.Millisecond, "The server stopped sending the build for 1 s."},
		"a deadline": {trickle, 1100 * time.Millisecond, time.Minute, "The build didn't arrive in 1 s."},
	} {
		t.Run(name, func(t *testing.T) {
			withDownloadLimits(t, tc.deadline, tc.gap)
			rig := newOfferRig(t)
			rig.answerWith(tc.serve(rig))
			started := time.Now()
			rig.settle()
			if took := time.Since(started); took > 6*time.Second {
				t.Fatalf("the transfer took %s to be given up", took)
			}
			if rig.e.update.failures[rig.releaseSHA] != 1 {
				t.Fatalf("%d failures counted", rig.e.update.failures[rig.releaseSHA])
			}
			rig.neverLeftAFileUnderAFinalName()
			if !rig.said1(tc.said) {
				t.Fatalf("the log said %q", rig.said)
			}
		})
	}
}

// The check-in goes on while a build is on its way: heartbeats are answered, the
// host says it is downloading, and the transfer is somebody else's goroutine.
func TestCheckInsGoOnWhileABuildIsOnItsWay(t *testing.T) {
	rig := newOfferRig(t)
	release := make(chan struct{})
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
		_, _ = w.Write(rig.build[:100])
		w.(http.Flusher).Flush()
		select {
		case <-release:
			_, _ = w.Write(rig.build[100:])
		case <-r.Context().Done():
		}
	})
	started := time.Now()
	rig.poll()
	for i := 0; i < 3; i++ {
		rig.poll()
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("check-ins waited for the transfer")
	}
	if beat := rig.beat(); beat["state"] != "downloading" || beat["release"] != rig.releaseSHA {
		t.Fatalf("the host reports %v", beat)
	}
	if rig.requests() != 1 {
		t.Fatalf("%d transfers at once", rig.requests())
	}
	if rig.e.updateAttention() {
		t.Fatal("asked for a check-in before the transfer ended")
	}
	close(release)
	<-rig.e.update.download.done
	if !rig.e.updateAttention() {
		t.Fatal("a finished transfer isn't worth a check-in")
	}
	if rig.e.updateAttention() {
		t.Fatal("asked twice for one finished transfer")
	}
	rig.poll()
	rig.poll()
	if beat := rig.beat(); beat["state"] != "staged" {
		t.Fatalf("the host reports %v", beat)
	}
}

// A new offer replaces the old: the transfer in progress ends, and what it wrote
// goes, before the new one begins.
func TestAChangedOfferEndsTheTransferInProgress(t *testing.T) {
	rig := newOfferRig(t)
	blocked := make(chan struct{})
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
		_, _ = w.Write(rig.build[:100])
		w.(http.Flusher).Flush()
		select {
		case blocked <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	})
	rig.poll()
	<-blocked
	first := rig.releaseSHA
	// The next release, of another build.
	rig.build = append(bytes.Clone(rig.build), "a newer build"...)
	rig.release(func(m *ReleaseManifest) {
		m.Version, m.Counter = "0.1.2", 8
		m.Artifacts = []ReleaseArtifact{platformArtifact(rig.build, "0.1.2")}
	})
	rig.answerWith(nil)
	rig.settle()
	rig.settle()
	rig.poll()
	if first == rig.releaseSHA {
		t.Fatal("the release didn't change")
	}
	if got := rig.staged(); len(got) != 1 || got[0] != rig.releaseSHA {
		t.Fatalf("what is staged is %v, want only %s", got, rig.releaseSHA)
	}
	if beat := rig.beat(); beat["state"] != "staged" || beat["release"] != rig.releaseSHA {
		t.Fatalf("the host reports %v", beat)
	}
	got, err := os.ReadFile(rig.stagedFile(UpdateBuildFile(runtime.GOOS)))
	if err != nil || !bytes.Equal(got, rig.build) {
		t.Fatalf("the staged build isn't the newer one: %v", err)
	}
}

// The agent stopping ends a transfer, and removes what it wrote.
func TestTheAgentStoppingEndsATransfer(t *testing.T) {
	rig := newOfferRig(t)
	started := make(chan struct{})
	rig.answerWith(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(rig.build)))
		_, _ = w.Write(rig.build[:100])
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	})
	rig.poll()
	<-started
	rig.e.stopUpdateDownload()
	if rig.e.update.download != nil {
		t.Fatal("the transfer is still there")
	}
	rig.neverLeftAFileUnderAFinalName()
}

// A full disk is its own code; any other write that fails is a failed transfer.
func TestAFullDiskIsItsOwnCode(t *testing.T) {
	dir := t.TempDir()
	err := storageFailure(dir, &os.PathError{Op: "write", Path: dir, Err: syscall.ENOSPC})
	var failure *updateDownloadError
	if !errors.As(err, &failure) || failure.Code != "DISK_FULL" || !strings.Contains(failure.Words, "There isn't room for the build") {
		t.Fatalf("%v", err)
	}
	other := storageFailure(dir, errors.New("permission denied"))
	if !errors.As(other, &failure) || failure.Code != "DOWNLOAD_FAILED" {
		t.Fatalf("%v", other)
	}
}

// The transfer has connections of its own, so that it can't keep a heartbeat or a
// wait from getting one, and no limit but its own deadline.
func TestATransferHasItsOwnConnections(t *testing.T) {
	rig := newOfferRig(t)
	shared, ok := rig.e.Client.HTTP.Transport.(*http.Transport)
	if !ok {
		t.Skip("the fixture's client has no transport of its own")
	}
	client, closeIdle := rig.e.Client.downloadClient()
	defer closeIdle()
	own, ok := client.Transport.(*http.Transport)
	if !ok || own == shared {
		t.Fatalf("the transfer shares the check-in transport: %v", client.Transport)
	}
	if client.Timeout != 0 {
		t.Fatalf("the transfer is bounded by %s on top of its deadline", client.Timeout)
	}
	if err := client.CheckRedirect(nil, nil); err == nil {
		t.Fatal("a redirect is allowed")
	}
}

// Over the connection a device really uses, a transfer presents the device's
// certificate and trusts only the CA the host was set up with.
func TestATransferPresentsTheDevicesCertificateAndTrustsOnlyTheServersCA(t *testing.T) {
	ca := makeCA(t)
	build := bytes.Repeat([]byte("a signed build. "), 4000)
	var mu sync.Mutex
	var seen []string
	server := trustedServer(t, ca, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := ""
		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			name = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		mu.Lock()
		seen = append(seen, name)
		mu.Unlock()
		if name != "device-a" {
			http.Error(w, "no device certificate", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(build)))
		_, _ = w.Write(build)
	}))
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := AtomicWrite(caFile, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	deviceKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credentials := Credentials{DeviceID: "device-a", CertificatePEM: ca.issue(t, &deviceKey.PublicKey, "device-a", false, time.Now().Add(time.Hour))}
	path := updateReleasePath + Digest(build)

	trusted, err := NewClient(Settings{Server: server.URL, CAFile: caFile}, &credentials, privatePEM(t, deviceKey))
	if err != nil {
		t.Fatal(err)
	}
	defer trusted.Close()
	dir := t.TempDir()
	info, err := trusted.downloadAgentBuild(context.Background(), path, dir, int64(len(build)), Digest(build))
	if err != nil {
		t.Fatalf("a device with its certificate and the right CA: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, UpdateBuildFile(runtime.GOOS)))
	if err != nil || !bytes.Equal(got, build) || info.Size() != int64(len(build)) {
		t.Fatalf("the build on disk: %v", err)
	}
	mu.Lock()
	if len(seen) != 1 || seen[0] != "device-a" {
		t.Fatalf("the server saw %v", seen)
	}
	mu.Unlock()

	// A host that doesn't trust the server's CA sends nothing: no request, and no
	// file.
	untrusting, err := NewClient(Settings{Server: server.URL}, &credentials, privatePEM(t, deviceKey))
	if err != nil {
		t.Fatal(err)
	}
	defer untrusting.Close()
	other := t.TempDir()
	_, err = untrusting.downloadAgentBuild(context.Background(), path, other, int64(len(build)), Digest(build))
	var failure *updateDownloadError
	if !errors.As(err, &failure) || failure.Code != "DOWNLOAD_FAILED" {
		t.Fatalf("%v", err)
	}
	if entries, _ := os.ReadDir(other); len(entries) != 0 {
		t.Fatalf("a transfer that never connected left %d files", len(entries))
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 {
		t.Fatalf("a client that doesn't trust the server's CA reached it: %v", seen)
	}
}
