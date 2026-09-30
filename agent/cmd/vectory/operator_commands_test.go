package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

// syntheticToken has the shape the server issues: 64 hexadecimal characters.
var syntheticToken = strings.Repeat("ab", 32)

func TestAJunkTokenIsRefusedBeforeAnythingIsSent(t *testing.T) {
	dir, _, _ := enrollmentCLIState(t)
	for token, want := range map[string]string{
		"abcd":                      "tokens are 64 characters, and this one has 4",
		strings.Repeat("xy", 32):    "tokens use only the characters 0-9 and a-f",
		strings.Repeat("AB", 32):    "tokens use only the characters 0-9 and a-f",
		" " + syntheticToken + "\n": "",
	} {
		err := agent.CheckEnrollmentToken(token)
		if want == "" {
			if err != nil {
				t.Fatalf("%q refused: %v", token, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "Copy token on Add device") {
			t.Fatalf("%q: %v", token, err)
		}
	}
	// Nothing is attempted: no connection error, no pending request.
	code, _, stderr := invoke("enroll", "--state-dir", dir, "--server", "https://127.0.0.1:9", "--id", "edge", "--token", "abcd", "--ca-file=")
	if code != 1 || !strings.Contains(stderr, "this one has 4") || strings.Contains(stderr, "127.0.0.1:9") {
		t.Fatal(code, stderr)
	}
	if pending, _ := agent.ReadPendingEnrollment(dir); pending != nil {
		t.Fatal("a junk token created an enrollment request", pending)
	}
}

func installedDir(t *testing.T, policy agent.CapabilityPolicy) string {
	t.Helper()
	dir := t.TempDir()
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), agent.Settings{VectorBinary: "fixed-vector", ManagedConfig: "fixed-config", CapabilityPolicy: policy}); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(dir, agent.State{ApplyState: "unmanaged", Policy: agent.Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	return dir
}

// holdAsRun takes the agent lock as `vectory run` would, recording this
// process as the holder (16 is where the lock file keeps the record).
func holdAsRun(t *testing.T, dir string) func() {
	t.Helper()
	unlock, err := agent.Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	record, _ := json.Marshal(agent.LockOwner{PID: os.Getpid(), Command: "run"})
	if err = f.Truncate(16); err == nil {
		_, err = f.WriteAt(append(record, '\n'), 16)
	}
	if err != nil {
		t.Fatal(err)
	}
	return unlock
}

func TestAllowAddsWhatTheHostApprovesAndSaysWhatItAllowsNow(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.test:443"}})
	// The agent's log exists once it ran; the change is noted there.
	if err := os.WriteFile(filepath.Join(dir, "vector.log"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := invoke("allow", "--state-dir", dir, "--network", "127.0.0.1:8239", "--listener", "0.0.0.0:514")
	if code != 0 || stderr != "" {
		t.Fatal(code, stderr)
	}
	for _, want := range []string{
		"Allowed destination 127.0.0.1:8239; listener 0.0.0.0:514.",
		"This host allows destinations logs.example.test:443, 127.0.0.1:8239; listener 0.0.0.0:514.",
		"Start the agent again; a version this host refused is tried again.",
	} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("allow output lacks %q:\n%s", want, stdout)
		}
	}
	settings, _ := agent.LoadSettings(dir)
	if strings.Join(settings.CapabilityPolicy.AllowedNetworkHosts, ",") != "logs.example.test:443,127.0.0.1:8239" {
		t.Fatal(settings.CapabilityPolicy)
	}
	logged, _ := os.ReadFile(filepath.Join(dir, "vector.log"))
	if !strings.Contains(string(logged), "Host operator allowed destination 127.0.0.1:8239; listener 0.0.0.0:514 (vectory allow)") {
		t.Fatalf("no local note: %q", logged)
	}
	if code, stdout, _ = invoke("allow", "--state-dir", dir, "--network", "127.0.0.1:8239"); code != 0 || !strings.Contains(stdout, "Already allowed; nothing changed.") {
		t.Fatal(code, stdout)
	}
	if code, _, stderr = invoke("allow", "--state-dir", dir); code != 2 || !strings.Contains(stderr, "name at least one") {
		t.Fatal(code, stderr)
	}
	if code, _, stderr = invoke("allow", "--state-dir", dir, "--network", "no-port"); code != 1 || !strings.Contains(stderr, "host:port") {
		t.Fatal(code, stderr)
	}
	// A complete policy file says what it leaves allowed.
	policy := filepath.Join(t.TempDir(), "allowances.json")
	if err := agent.WriteJSON(policy, agent.CapabilityPolicy{AllowedFileRoots: []string{"/var/log/app"}}); err != nil {
		t.Fatal(err)
	}
	if code, stdout, _ = invoke("install", "--state-dir", dir, "--capability-policy", policy); code != 0 || !strings.Contains(stdout, "This host allows files under /var/log/app.") {
		t.Fatal(code, stdout)
	}
}

func TestCommandsThatNeedTheAgentStoppedNameItAndRetryIsQueued(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	unlock := holdAsRun(t, dir)
	defer unlock()
	pid := strconv.Itoa(os.Getpid())
	code, _, stderr := invoke("configure-metrics", "--state-dir", dir, "--metrics-url", "http://127.0.0.1:9598/metrics")
	if code != 1 || !strings.Contains(stderr, "vectory run, pid "+pid) || !strings.Contains(stderr, "Ctrl-C") || strings.Contains(stderr, "another agent operation is running") {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	// With nothing failed, retry says so and promises no attempt.
	code, stdout, stderr := invoke("retry", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "Nothing to retry: no version has failed on this host.") || strings.Contains(stdout, "Retry queued") {
		t.Fatalf("exit %d: %s %s", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(dir, "retry-requested")); !os.IsNotExist(err) {
		t.Fatal("queued a retry with nothing failed", err)
	}
	// retry doesn't need the agent stopped: the running agent takes it.
	generation := uint64(3)
	if err := agent.SaveState(dir, agent.State{ApplyState: "failed", FailedGeneration: &generation, Policy: agent.Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr = invoke("retry", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "Retry queued. The running agent (pid "+pid+")") {
		t.Fatalf("exit %d: %s %s", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(dir, "retry-requested")); err != nil {
		t.Fatal("no queued request", err)
	}
	if _, stdout, _ := invoke("help", "retry"); !strings.Contains(stdout, "While the agent runs, the request is queued") {
		t.Fatal(stdout)
	}
}

func TestSetupSaysConnectedOnlyAfterACheckIn(t *testing.T) {
	step := func(id, status string) agent.SetupStep { return agent.SetupStep{ID: id, Status: status} }
	for _, c := range []struct {
		want   string
		result agent.SetupResult
	}{
		// Its own check-in, or a service that checked in.
		{"Connected", agent.SetupResult{Steps: []agent.SetupStep{step("enroll", "ok"), step("checkin", "ok")}}},
		{"Connected", agent.SetupResult{Steps: []agent.SetupStep{step("enroll", "ok"), step("service", "ok")}}},
		// An upgrade that leaves an existing workload to start checked nothing.
		{"Device", agent.SetupResult{Steps: []agent.SetupStep{step("enroll", "ok"), step("service", "info")}}},
		// Nothing keeps the agent running.
		{"Device", agent.SetupResult{NeedsAttention: true, Steps: []agent.SetupStep{step("checkin", "ok"), step("service", "warn")}}},
		// An older build still runs beside the upgraded one.
		{"Device", agent.SetupResult{Steps: []agent.SetupStep{step("enroll", "ok"), step("service", "warn")}}},
	} {
		if got := closingLabel(c.result); got != c.want {
			t.Fatalf("%+v: %q, want %q", c.result, got, c.want)
		}
	}
}

func TestLogsForAStateDirectoryWithoutAnAgentSaySo(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nonexistent")
	code, _, stderr := invoke("logs", "--state-dir", missing)
	if code != 1 || !strings.Contains(stderr, "No agent is installed at "+missing) || strings.Contains(stderr, "no Vector log yet") {
		t.Fatal(code, stderr)
	}
}

func TestHelpExamplesNeverSkipCertificateChecks(t *testing.T) {
	for _, args := range [][]string{{"help"}, {"help", "setup"}, {"help", "enroll"}} {
		_, stdout, _ := invoke(args...)
		for _, word := range strings.Fields(stdout) {
			if word == "-k" || word == "--insecure" || strings.HasPrefix(word, "-fsSLk") {
				t.Fatalf("%v teaches %s:\n%s", args, word, stdout)
			}
		}
		// Placeholders can't be pasted as a real pin.
		if strings.Contains(stdout, "1F3C...9AB0") {
			t.Fatalf("%v shows a pasteable fake pin", args)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	if _, stdout, _ := invoke("help", "setup"); !strings.Contains(stdout, "--cacert vectory-ca.pem") || !strings.Contains(stdout, "<64-hex-fingerprint>") {
		t.Fatal(stdout)
	}
}
