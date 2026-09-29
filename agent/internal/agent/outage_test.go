package agent

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A device that checked in 40 s ago has the right address: an outage must
// say the server is unreachable, not suggest another port.
func TestOutageWordingForAServerThatAnsweredBefore(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX errno")
	}
	target, _ := url.Parse("https://127.0.0.1:8213")
	refused := classifyTransport(target, nil, false, &errorWithErrno{syscall.ECONNREFUSED})
	if refused.Code != "CONNECTION_REFUSED" || !strings.Contains(refused.Fix, "port") {
		t.Fatalf("first-contact wording changed: %+v", refused)
	}
	now := time.Now()
	last := now.Add(-40 * time.Second)
	text := describeCheckInFailure(refused, &last, now)
	if !strings.HasPrefix(text, "Can't reach the server (connection refused). It answered 40 s ago, so the address is right.") {
		t.Fatalf("outage wording: %q", text)
	}
	if strings.Contains(text, "8443") || !strings.Contains(text, "Vector keeps running") {
		t.Fatalf("outage wording: %q", text)
	}
	if describeCheckInFailure(refused, nil, now) != refused.Error() {
		t.Fatal("a device that never answered keeps the address hint")
	}
	certificate := &ConnectionError{Code: "TLS_UNKNOWN_AUTHORITY", Message: "untrusted"}
	if describeCheckInFailure(certificate, &last, now) != certificate.Error() {
		t.Fatal("a certificate problem is not an outage")
	}
}

func TestStatusShowsAnOngoingOutage(t *testing.T) {
	now := time.Now()
	last := now.Add(-50 * time.Second)
	v := &StatusView{DeviceID: "5e7a9c2d-0000", Foreground: true, BinaryOK: true, Settings: Settings{Name: "edge", Server: "https://vectory.example:8443"},
		State: State{LastHeartbeat: &last, Policy: Policy{HeartbeatSeconds: 60}, CheckInFailure: &CheckInFailure{Since: now.Add(-10 * time.Second), Message: "Can't reach the server (connection refused)."}}}
	v.Next = v.nextStep(now)
	out := RenderStatus(v, now)
	since := v.State.CheckInFailure.Since.Local().Format("2006-01-02 15:04:05")
	if !strings.Contains(out, "not answering since "+since+" ") || !strings.Contains(out, "Next       Can't reach the server (connection refused).") {
		t.Fatalf("status hides the outage or its date:\n%s", out)
	}
	recovered := now.Add(-2 * time.Second)
	v.State.LastHeartbeat = &recovered
	if strings.Contains(v.nextStep(now), "Can't reach") || strings.Contains(RenderStatus(v, now), "not answering") {
		t.Fatal("a recovered outage is still shown")
	}
}

// Stopping the agent during a check-in cancels the request: that is a clean
// stop, and status must not show an outage afterwards.
func TestCheckInInterruptedByStoppingIsNotAnOutage(t *testing.T) {
	now := time.Date(2026, 9, 29, 15, 4, 5, 0, time.UTC)
	e := &Engine{Dir: t.TempDir(), Now: func() time.Time { return now }}
	target, _ := url.Parse("https://127.0.0.1:8443")
	canceled := classifyTransport(target, nil, true, context.Canceled)
	stopped, stop := context.WithCancel(context.Background())
	stop()
	e.recordCheckInFailure(stopped, canceled, canceled.Error())
	e.recordCheckInFailure(context.Background(), canceled, canceled.Error())
	if e.State.CheckInFailure != nil {
		t.Fatalf("a cancelled check-in was recorded: %+v", e.State.CheckInFailure)
	}
	refused := &ConnectionError{Code: "CONNECTION_REFUSED", Message: "Nothing is accepting connections on 127.0.0.1:8443."}
	e.recordCheckInFailure(context.Background(), refused, refused.Message)
	now = now.Add(time.Minute)
	e.recordCheckInFailure(context.Background(), refused, "later")
	if f := e.State.CheckInFailure; f == nil || !f.Since.Equal(now.Add(-time.Minute)) || f.Message != "later" {
		t.Fatalf("outage = %+v", f)
	}
	if state, err := LoadState(e.Dir); err != nil || state.CheckInFailure == nil {
		t.Fatalf("outage not saved: %v", err)
	}
	e.State.CheckInFailure = nil
	e.recordCheckInFailure(context.Background(), errors.New("manifest signature rejected"), "x")
	if e.State.CheckInFailure != nil {
		t.Fatal("only network failures are outages")
	}
}

// The build a process records is the one it runs, read before anything slow.
func TestRunningAgentBuildIsThisProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	want, err := FileDigest(exe)
	build := runningAgentBuild()
	if err != nil || build == nil || build.SHA256 != want || build.Version != Version {
		t.Fatalf("build %+v, want %s (%v)", build, want, err)
	}
}

// One prompt follow-up heartbeat reports an apply's outcome; progress states
// and unchanged outcomes keep the normal interval.
func TestFollowUpHeartbeatOnlyForANewOutcome(t *testing.T) {
	for _, tc := range []struct {
		before, after appliedOutcome
		want          bool
	}{
		{appliedOutcome{"desired", 1}, appliedOutcome{"verified_applied", 2}, true},
		{appliedOutcome{"verified_applied", 1}, appliedOutcome{"failed", 1}, true},
		{appliedOutcome{"verified_applied", 2}, appliedOutcome{"verified_applied", 2}, false},
		{appliedOutcome{"verified_applied", 1}, appliedOutcome{"verified_applied", 2}, true},
		{appliedOutcome{"unmanaged", 0}, appliedOutcome{"validated", 0}, false},
	} {
		if got := followUp(tc.before, tc.after); got != tc.want {
			t.Errorf("%+v -> %+v: %v", tc.before, tc.after, got)
		}
	}
}

type errorWithErrno struct{ errno syscall.Errno }

func (e *errorWithErrno) Error() string { return e.errno.Error() }
func (e *errorWithErrno) Unwrap() error { return e.errno }
