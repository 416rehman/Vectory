package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// installedState is a minimal installed state directory for local commands.
func installedState(t *testing.T, policy CapabilityPolicy) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), Settings{VectorBinary: "fixed-vector", ManagedConfig: "fixed-config", CapabilityPolicy: policy}); err != nil {
		t.Fatal(err)
	}
	if err := SaveState(dir, State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	return dir
}

// claimAs makes the held lock say it belongs to `vectory <command>`.
func claimAs(t *testing.T, dir, command string) {
	t.Helper()
	f, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	data, _ := json.Marshal(LockOwner{PID: os.Getpid(), Command: command})
	if err := f.Truncate(lockOwnerOffset); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt(append(data, '\n'), lockOwnerOffset); err != nil {
		t.Fatal(err)
	}
}

func TestALockedStateDirectoryNamesItsHolderAndHowToStopIt(t *testing.T) {
	dir := installedState(t, CapabilityPolicy{})
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	// The holder records itself; a second operation is told who it is.
	claimAs(t, dir, "run")
	_, err = Lock(dir)
	var held *LockHeldError
	if !errors.As(err, &held) || held.Owner == nil || held.Owner.PID != os.Getpid() || held.Owner.Command != "run" {
		t.Fatalf("lock refusal: %#v", err)
	}
	pid := strconv.Itoa(os.Getpid())
	if runtime.GOOS != "windows" {
		for _, want := range []string{"The agent is running (vectory run, pid " + pid + ")", "Ctrl-C where it runs", "sudo kill " + pid, "run this command again"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("%q lacks %q", err.Error(), want)
			}
		}
	}
	// Settings maintenance says the same, never only "another operation".
	if err := Retry(dir); err == nil || !strings.Contains(err.Error(), "pid "+pid) {
		t.Fatalf("retry while locked: %v", err)
	}
	unlock()
	// Released: the record is gone, and the next operation proceeds.
	if owner := readLockOwner(dir); owner != nil {
		t.Fatalf("a released lock still names %+v", owner)
	}
	unlock, err = Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	unlock()

	service := (&LockHeldError{StateDir: dir, Owner: &LockOwner{PID: 4242, Command: "run"}, Service: "vectory.service"}).Error()
	other := (&LockHeldError{StateDir: dir, Owner: &LockOwner{PID: 4243, Command: "install"}}).Error()
	unknown := (&LockHeldError{StateDir: dir}).Error()
	if !strings.Contains(service, "The agent service is running (vectory.service, pid 4242)") || !strings.Contains(service, "vectory service-stop") || !strings.Contains(service, "vectory service-start") {
		t.Fatal(service)
	}
	if !strings.Contains(other, "(vectory install, pid 4243). Wait for it to finish") || !strings.Contains(unknown, "service-stop") {
		t.Fatal(other, unknown)
	}
}

func TestRetryAskedForWhileTheAgentRunsIsQueuedAndTaken(t *testing.T) {
	dir := installedState(t, CapabilityPolicy{})
	generation := uint64(7)
	e := &Engine{Dir: dir, State: State{ApplyState: "failed", FailedGeneration: &generation, FailedEffectiveSHA256: strings.Repeat("a", 64)}}
	if err := e.save(); err != nil {
		t.Fatal(err)
	}
	if e.takeQueuedRetry() {
		t.Fatal("took a retry nobody asked for")
	}
	if err := QueueRetry(dir); err != nil {
		t.Fatal(err)
	}
	if !e.takeQueuedRetry() || e.State.FailedGeneration != nil || e.State.FailedEffectiveSHA256 != "" {
		t.Fatalf("queued retry not taken: %+v", e.State)
	}
	saved, _ := LoadState(dir)
	if saved.FailedGeneration != nil {
		t.Fatal("the lifted hold wasn't saved")
	}
	if _, err := os.Lstat(filepath.Join(dir, retryRequestName)); !os.IsNotExist(err) {
		t.Fatal("the request stayed behind")
	}
	// A stopped-agent retry answers a request left behind as well.
	if err := QueueRetry(dir); err != nil {
		t.Fatal(err)
	}
	if err := Retry(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, retryRequestName)); !os.IsNotExist(err) {
		t.Fatal("stopped-agent retry left the request")
	}
	if err := QueueRetry(filepath.Join(t.TempDir(), "none")); err == nil {
		t.Fatal("queued a retry without agent state")
	}
}

func TestAllowAddsAllowancesAndNeverRemovesOne(t *testing.T) {
	dir := installedState(t, CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.test:443"}, AllowedFileRoots: []string{"/var/log/app"}})
	generation := uint64(3)
	state, _ := LoadState(dir)
	state.FailedGeneration = &generation
	if err := SaveState(dir, state); err != nil {
		t.Fatal(err)
	}
	add := &CapabilityPolicy{AllowedNetworkHosts: []string{"127.0.0.1:8239", "logs.example.test:443"}, AllowedListenAddresses: []string{"0.0.0.0:514"}}
	if err := InstallWithOptions(context.Background(), dir, InstallOptions{AddAllowances: add}); err != nil {
		t.Fatal(err)
	}
	got, _ := LoadSettings(dir)
	if strings.Join(got.CapabilityPolicy.AllowedNetworkHosts, ",") != "logs.example.test:443,127.0.0.1:8239" || strings.Join(got.CapabilityPolicy.AllowedFileRoots, ",") != "/var/log/app" || strings.Join(got.CapabilityPolicy.AllowedListenAddresses, ",") != "0.0.0.0:514" {
		t.Fatalf("allowances: %+v", got.CapabilityPolicy)
	}
	// A new allowance lifts the hold on the version this host refused.
	if state, _ := LoadState(dir); state.FailedGeneration != nil {
		t.Fatal("retry suppression kept after a capability change")
	}
	for _, bad := range []InstallOptions{
		{AddAllowances: &CapabilityPolicy{FullVectorConfig: true}},
		{AddAllowances: &CapabilityPolicy{AllowedNetworkHosts: []string{"no-port"}}},
		{AddAllowances: &CapabilityPolicy{AllowedFileRoots: []string{"relative"}}},
		{AddAllowances: &CapabilityPolicy{}, CapabilityPolicy: &CapabilityPolicy{}},
	} {
		if InstallWithOptions(context.Background(), dir, bad) == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	if after, _ := LoadSettings(dir); after.CapabilityPolicy.FullVectorConfig || len(after.CapabilityPolicy.AllowedNetworkHosts) != 2 {
		t.Fatal("a refused addition changed the policy")
	}
	if got := DescribeAllowances(got.CapabilityPolicy); got != "files under /var/log/app; destinations logs.example.test:443, 127.0.0.1:8239; listener 0.0.0.0:514" {
		t.Fatal(got)
	}
	if got := DescribeAllowances(CapabilityPolicy{}); !strings.HasPrefix(got, "nothing yet") {
		t.Fatal(got)
	}
}

func TestTheAgentLogSaysEachOutcomeOnceInPlainWords(t *testing.T) {
	desired := &Desired{VersionID: "b898b48f-0000-4000-8000-000000000001"}
	applied := State{ApplyState: "verified_applied", ReportedGeneration: 2, Desired: desired, ActualSHA256: "aa"}
	key, line := outcomeLine(applied)
	if line != "Applied version b898b48f (generation 2); Vector runs it." {
		t.Fatal(line)
	}
	if again, _ := outcomeLine(applied); again != key {
		t.Fatal("the same outcome must keep its key")
	}
	generation := uint64(3)
	first := State{ApplyState: "failed", HighestGeneration: 3, FailedGeneration: &generation, Desired: desired, Error: &Issue{Code: "ROLLBACK_UNAVAILABLE", Message: "Vector didn't confirm it runs this version; Vector is stopped", Diagnostics: []Diagnostic{{Severity: "error", Code: "PRIVILEGED_PORT", Message: "Vector can't listen on 127.0.0.1:514: ports below 1024 need a privilege the service account lacks."}}}}
	_, line = outcomeLine(first)
	if line != "Version b898b48f (generation 3) couldn't start: Vector can't listen on 127.0.0.1:514: ports below 1024 need a privilege the service account lacks (PRIVILEGED_PORT). Vector is stopped: this was the device's first version, so there is nothing earlier to go back to." {
		t.Fatal(line)
	}
	if strings.Contains(line, "Effective configuration") || strings.Contains(line, "recovery content") {
		t.Fatal("jargon in the log:", line)
	}
	rolled := first
	rolled.ApplyState, rolled.LastGoodSHA256 = "rolled_back", "bb"
	rolled.Error = &Issue{Code: "APPLY_ROLLED_BACK", Message: "Vector didn't confirm it runs this version; last verified configuration restored"}
	if _, line = outcomeLine(rolled); !strings.HasSuffix(line, "(APPLY_ROLLED_BACK). Vector runs the last working configuration again.") {
		t.Fatal(line)
	}
	if startupLine(State{}, false) != "Nothing to run yet: Vector starts when a pipeline is deployed to this device." || startupLine(applied, true) != "Vector runs version b898b48f (generation 2), the last verified configuration." {
		t.Fatal("startup lines")
	}
	if got := preciseDuration(72 * time.Second); got != "1 min 12 s" {
		t.Fatal(got)
	}
	if got := stoppedLine(3200*time.Millisecond, 60, nil); got != "Vector stopped after 3.2 s." {
		t.Fatal(got)
	}
	if got := stoppedLine(61*time.Second, 60, nil); got != "Drain limit reached after 60 s; Vector was terminated before it finished its in-flight events." {
		t.Fatal(got)
	}
}

func TestSetupWaitsOutAShortVectorRunBeforeRefusing(t *testing.T) {
	test := []RunningVector{{PID: 4242, Binary: "/usr/bin/vector"}}
	scans := 0
	r := &setupRun{host: serviceHost{settle: 10 * time.Millisecond, detectVector: func(context.Context) ([]RunningVector, bool) {
		scans++
		if scans == 1 {
			return test, true // the Vectory validator's sample run
		}
		return nil, true
	}}}
	if running, checked := r.runningVector(context.Background()); !checked || len(running) != 0 || scans != 2 {
		t.Fatalf("a finished test run was taken for a workload: %v (scans %d)", running, scans)
	}
	if stepStatus(r.result, "existing") != "info" {
		t.Fatalf("the wait wasn't said: %+v", r.result.Steps)
	}
	lasting := &setupRun{host: serviceHost{settle: 10 * time.Millisecond, detectVector: func(context.Context) ([]RunningVector, bool) { return test, true }}}
	if running, _ := lasting.runningVector(context.Background()); len(running) != 1 || running[0].PID != 4242 {
		t.Fatal("a Vector that keeps running was missed", running)
	}
	// A replacement process with another PID is not the same workload.
	scans = 0
	replaced := &setupRun{host: serviceHost{settle: 10 * time.Millisecond, detectVector: func(context.Context) ([]RunningVector, bool) {
		scans++
		return []RunningVector{{PID: 4242 + scans}}, true
	}}}
	if running, _ := replaced.runningVector(context.Background()); len(running) != 0 {
		t.Fatal(running)
	}
	keep := &setupRun{options: SetupOptions{KeepExistingVector: true}, host: serviceHost{settle: time.Hour, detectVector: func(context.Context) ([]RunningVector, bool) { return test, true }}}
	if running, _ := keep.runningVector(context.Background()); len(running) != 1 {
		t.Fatal("--keep-existing-vector must not wait")
	}
}

func TestStatusSaysRevokedAndNamesTheAgentProcess(t *testing.T) {
	now := time.Now()
	heartbeat := now.Add(-10 * time.Minute)
	view := &StatusView{StateDir: "/var/lib/vectory-agent", DeviceID: "5e7a9c2d-0000-4000-8000-000000000001", CertExpiry: now.Add(20 * time.Hour),
		Settings:   Settings{Name: "r16-host", Server: "https://vectory.example.test:8443"},
		State:      State{LastHeartbeat: &heartbeat, CheckInFailure: &CheckInFailure{Since: now.Add(-5 * time.Minute), Code: "CREDENTIAL_REJECTED", Message: "The server doesn't accept this device's credential (HTTP 401)."}},
		Foreground: true, Owner: &LockOwner{PID: 4242, Command: "run"}, BinaryOK: true}
	text := RenderStatus(view, now)
	if !strings.Contains(text, "the server no longer accepts this agent (revoked) since") || strings.Contains(text, "not answering") {
		t.Fatal(text)
	}
	if !strings.Contains(text, "Service    none · vectory run is running (pid 4242), not as a service") || strings.Contains(text, "foreground") {
		t.Fatal(text)
	}
	view.CertExpiry = now.Add(-time.Hour)
	if text := RenderStatus(view, now); !strings.Contains(text, "its credential expired") {
		t.Fatal(text)
	}
	view.State.CheckInFailure.Code = "CONNECTION_REFUSED"
	if text := RenderStatus(view, now); !strings.Contains(text, "not answering since") {
		t.Fatal(text)
	}
	if command := RunCommandFor(filepath.Join(t.TempDir(), "custom")); !strings.Contains(command, " run --state-dir ") || !filepath.IsAbs(strings.Fields(strings.TrimPrefix(command, "sudo "))[0]) {
		t.Fatalf("run command must name this agent's absolute path: %q", command)
	}
}

func TestServiceControlWithoutSystemdIsAPlainSentence(t *testing.T) {
	if runtime.GOOS != "linux" || SystemdAvailable() {
		t.Skip("needs a Linux host without systemd")
	}
	err := ServiceControl("stop")
	if err == nil || strings.Contains(err.Error(), "journalctl") || strings.Contains(err.Error(), "bus") || !strings.HasPrefix(err.Error(), "There is no Vectory service to stop: ") || !strings.Contains(err.Error(), "Ctrl-C") {
		t.Fatal(err)
	}
}

// The running build and the state directory go only to servers that list
// them: the device page's upgrade check and host commands use them.
func TestHeartbeatReportsTheBuildAndStateDirectoryOnlyWhereAccepted(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "custom state")
	build := &AgentBuild{Version: Version, SHA256: strings.Repeat("97", 32)}
	e := &Engine{Dir: dir, Driver: &fakeDriver{}, State: State{Agent: build}}
	var h Heartbeat
	e.addHeartbeatFeatures(&h, nil, "", "")
	if encoded, _ := json.Marshal(h); strings.Contains(string(encoded), "agent_sha256") || strings.Contains(string(encoded), "state_dir") {
		t.Fatalf("an older server would receive new fields: %s", encoded)
	}
	e.State.ServerFeatures = []string{featureAgentSHA256, featureStateDir}
	h = Heartbeat{}
	e.addHeartbeatFeatures(&h, nil, "", "")
	if h.AgentSHA256 != build.SHA256 || h.StateDir != dir {
		t.Fatalf("%+v", h)
	}
}

func TestSetupBesideARunningAgentStartsNothing(t *testing.T) {
	_, dir := enrolledInstallation(t)
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	claimAs(t, dir, "run")
	options, _, _ := setupFixture(t)
	options.StateDir = dir
	options.Token = func() (string, error) { t.Fatal("asked for a token"); return "", nil }
	result, err := Setup(context.Background(), options)
	if runtime.GOOS == "windows" {
		return
	}
	if err != nil || !result.OK || !strings.HasPrefix(result.Next, "Nothing to start.") {
		t.Fatalf("%v %q %+v", err, result.Next, result.Steps)
	}
	last := result.Steps[len(result.Steps)-1]
	if last.ID != "service" || !strings.Contains(last.Detail, "the agent is already running (vectory run, pid "+strconv.Itoa(os.Getpid())+")") {
		t.Fatalf("%+v", last)
	}
}
