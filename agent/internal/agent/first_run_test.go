package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

var noSystemdHere = serviceHost{systemd: func() bool { return false }, why: func() string { return "systemd isn't running" }}

// --service auto says why it found no service manager; --service none is the
// operator's choice and needs no reason.
func TestChooseServiceSaysWhyAutoFindsNone(t *testing.T) {
	linux, darwin := PlatformInfo{OS: "linux"}, PlatformInfo{OS: "darwin"}
	withSystemd := serviceHost{systemd: func() bool { return true }, why: func() string { t.Fatal("asked why with systemd"); return "" }}
	cases := []struct {
		name, requested string
		platform        PlatformInfo
		host            serviceHost
		want            serviceChoice
	}{
		{"systemd host", "auto", linux, withSystemd, serviceChoice{kind: "systemd"}},
		{"systemd-less host", "", linux, noSystemdHere, serviceChoice{kind: "none", reason: "systemd isn't running"}},
		{"macOS", "auto", darwin, noSystemdHere, serviceChoice{kind: "launchd"}},
		{"explicit none", "none", linux, withSystemd, serviceChoice{kind: "none", explicit: true}},
	}
	for _, c := range cases {
		got, err := chooseService(c.requested, c.platform, c.host)
		if err != nil || got != c.want {
			t.Errorf("%s: %+v %v, want %+v", c.name, got, err, c.want)
		}
	}
	if _, err := chooseService("systemd", linux, noSystemdHere); err == nil {
		t.Fatal("an unavailable --service systemd was accepted")
	}
	if _, err := chooseService("openrc", linux, withSystemd); err == nil {
		t.Fatal("an unknown --service was accepted")
	}
}

// The reason names the usual hosts without systemd: containers, WSL and
// OpenRC distributions such as Alpine.
func TestNoSystemdReasonNamesTheHost(t *testing.T) {
	cases := map[string]struct {
		files map[string]string
		want  string
	}{
		"alpine":       {map[string]string{"run/openrc/softlevel": ""}, "this host uses OpenRC, not systemd"},
		"docker":       {map[string]string{".dockerenv": ""}, "systemd isn't running in this container"},
		"podman":       {map[string]string{"run/.containerenv": ""}, "systemd isn't running in this container"},
		"wsl":          {map[string]string{"proc/version": "Linux version 5.15.153.1-microsoft-standard-WSL2"}, "systemd isn't running in this WSL distribution"},
		"no systemctl": {map[string]string{"run/systemd/system/.keep": ""}, "systemctl isn't installed"},
		"plain":        {map[string]string{"proc/version": "Linux version 6.8.0"}, "systemd isn't running"},
	}
	for name, c := range cases {
		root := t.TempDir()
		for path, body := range c.files {
			full := filepath.Join(root, filepath.FromSlash(path))
			if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(body), 0644); err != nil {
				t.Fatal(err)
			}
		}
		if got := noSystemdReason(root); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

// renderSteps prints setup's steps the way the CLI does, with the values that
// differ between runs replaced by placeholders.
func renderSteps(steps []SetupStep, replace map[string]string) string {
	marks := map[string]string{"ok": "[ok]", "info": "[i] ", "warn": "[!!]", "fail": "[!!]", "plan": "[..]"}
	var b strings.Builder
	for _, step := range steps {
		if step.ID == "existing" {
			continue // depends on whatever Vector runs on the test machine
		}
		detail := step.Detail
		if step.ID == "platform" {
			detail = "<platform>"
		}
		fmt.Fprintf(&b, "%s %-12s %s\n", marks[step.Status], step.Label, detail)
		if step.Fix != "" {
			fmt.Fprintf(&b, "%s%s\n", strings.Repeat(" ", 18), step.Fix)
		}
	}
	out := b.String()
	for value, placeholder := range replace {
		out = strings.ReplaceAll(out, value, placeholder)
	}
	return regexp.MustCompile(`CA pinned \S+ \([^)]*\)`).ReplaceAllString(out, "CA pinned <pin>")
}

// The dry run on a host without systemd shows the same Service row the real
// run prints, plans for the directory the installer was given (never its
// temporary copy) and says --create-user can't be honoured.
func TestSetupDryRunPlanWithoutAServiceManager(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("--service auto finds launchd or the Windows service manager elsewhere")
	}
	server := newSetupServer(t)
	options, dir, managed := setupFixture(t)
	agentPath := filepath.Join(t.TempDir(), "opt", "bin", "vectory")
	vector := fakeVector(t, VectorVersion)
	options.Server, options.CASHA256, options.VectorBinary, options.DryRun = server.url, server.pin, vector, true
	options.Service, options.CreateUser, options.AgentPath = "auto", true, agentPath
	options.Token = func() (string, error) { t.Fatal("dry run asked for the token"); return "", nil }
	result, err := setupWith(context.Background(), options, nativeService, noSystemdHere)
	if err != nil || !result.OK || !result.NeedsAttention || result.Service != "none" {
		t.Fatalf("%+v %v", result, err)
	}
	got := renderSteps(result.Steps, map[string]string{server.url: "<server>", agentPath: "<agent>", vector: "<vector>", dir: "<state>", managed: "<managed>"})
	want := `[ok] Platform     <platform>
[ok] Server       <server> · CA pinned <pin>
[ok] Vector       0.58.0 at <vector>
[ok] Paths        state <state> · workload <managed> (empty until you deploy)
[ok] Mode         restricted: reviewed components; this host approves files, destinations and listeners
[i]  Account      Won't be created: --create-user makes the service's account, and no service is registered here.
                  Without a service, the agent runs as whoever starts it.
[..] Agent        Would run <agent> 0.1.0, where the installer puts it.
[..] Install      Would create <state> and adopt Vector at <vector>.
[..] Enroll       Would enroll as setup-edge (asks for the token).
[!!] Service      No supported service manager here (systemd isn't running), so the agent would stop after its first check-in.
                  Keep it running with your own supervisor (<agent> run --state-dir <state>) and pass --service none, or use a host with systemd.
`
	if got != want {
		t.Fatalf("dry-run plan:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, os.TempDir()+string(filepath.Separator)+"tmp.") {
		t.Fatal("the plan names a temporary copy of the agent")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("dry run created the state directory")
	}
}

// On a host without systemd the default command still enrolls and checks
// in, but says the agent stopped, with the exact command that keeps it
// running, and ends with exit 3 (NeedsAttention). The enrollment and the
// complete follow-up check-in tell the server nothing keeps it running.
func TestSetupWithoutAServiceManagerSaysTheAgentStopped(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("--service auto finds launchd or the Windows service manager elsewhere")
	}
	server := newSetupServer(t)
	server.features = []string{featureHostRuntime, featureServiceManager, featureVectorRunning, featureLogSummary}
	options, dir, _ := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	options.Service, options.CreateUser = "auto", true
	options.Token = func() (string, error) { return "synthetic-setup-token", nil }
	result, err := setupWith(context.Background(), options, nativeService, noSystemdHere)
	if err != nil || !result.OK || !result.NeedsAttention || result.Service != "none" {
		t.Fatalf("%+v %v", result, err)
	}
	executable, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	run := quoteArg(executable) + " run --state-dir " + quoteArg(dir)
	last := result.Steps[len(result.Steps)-1]
	if last.ID != "service" || last.Status != "warn" || last.Detail != "No supported service manager here (systemd isn't running), so the agent stopped after its first check-in." || last.Fix != "Keep it running with your own supervisor: "+run {
		t.Fatalf("service row: %+v", last)
	}
	if stepStatus(result, "checkin") != "ok" || stepStatus(result, "account") != "info" || result.Next != "Start the agent and keep it running: "+run {
		t.Fatalf("steps: %+v next %q", result.Steps, result.Next)
	}
	if server.enrollment["service_manager"] != "none" {
		t.Fatalf("enrollment: %v", server.enrollment["service_manager"])
	}
	// The first check-in learns the server's fields; one complete check-in
	// follows, as a running agent would send it.
	beats := server.sent()
	if len(beats) != 2 {
		t.Fatalf("%d check-ins", len(beats))
	}
	if _, ok := beats[0]["host_runtime"]; ok {
		t.Fatal("the first check-in sent fields the server hadn't listed")
	}
	full := beats[1]
	if full["service_manager"] != "none" || full["vector_running"] != false || full["host_runtime"] == nil || full["vector_log_summary"] == nil {
		t.Fatalf("complete check-in: %v", full)
	}
}

// A heartbeat carries what keeps the agent running and whether Vector runs
// only to servers that list those fields.
func TestHeartbeatReportsSupervisionOnlyWhereAccepted(t *testing.T) {
	e := &Engine{Driver: &fakeDriver{alive: true}, ServiceManager: "systemd"}
	var h Heartbeat
	e.addHeartbeatFeatures(&h, nil, "", "")
	encoded, _ := json.Marshal(h)
	if strings.Contains(string(encoded), "service_manager") || strings.Contains(string(encoded), "vector_running") {
		t.Fatalf("an older server would receive new fields: %s", encoded)
	}
	e.State.ServerFeatures = []string{featureServiceManager, featureVectorRunning}
	h = Heartbeat{}
	e.addHeartbeatFeatures(&h, nil, "", "")
	if h.ServiceManager != "systemd" || h.VectorRunning == nil || !*h.VectorRunning {
		t.Fatalf("%+v", h)
	}
	e.Driver.(*fakeDriver).alive = false
	e.addHeartbeatFeatures(&h, nil, "", "")
	if *h.VectorRunning {
		t.Fatal("a stopped Vector reported as running")
	}
	if !learnedFeatures(nil, []string{"host_runtime"}) || learnedFeatures([]string{"host_runtime"}, []string{"host_runtime"}) {
		t.Fatal("learnedFeatures")
	}
}

// firstVersionFixture is a device that never verified a configuration: no
// last-good content, and the managed file holds previous (or nothing).
func firstVersionFixture(t *testing.T, previous []byte) (*Engine, Manifest, *fakeDriver) {
	t.Helper()
	e, m, d := fixture(t, newConfig)
	if err := os.Remove(e.goodPath()); err != nil {
		t.Fatal(err)
	}
	if previous == nil {
		if err := os.Remove(e.Settings.ManagedConfig); err != nil {
			t.Fatal(err)
		}
	} else if err := AtomicWrite(e.Settings.ManagedConfig, previous); err != nil {
		t.Fatal(err)
	}
	e.State.LastGoodSHA256, e.State.ReportedGeneration, e.State.ApplyState = "", 0, "unmanaged"
	d.alive = false
	return e, m, d
}

// A first version that stops Vector leaves nothing claiming to run: the
// failed version is withdrawn from the managed path, the actual digest is
// empty, nothing is left to recover, and the next step is plain.
func TestFirstVersionThatFailsToStartLeavesNothingRunning(t *testing.T) {
	e, m, d := firstVersionFixture(t, nil)
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("the failed activation was not reported")
	}
	requireAttempt(t, e, m, "failed", "ROLLBACK_UNAVAILABLE")
	if d.Alive() || e.State.ActualSHA256 != "" || e.actual() != "" {
		t.Fatalf("something still claims to run: alive %v actual %q file %q", d.Alive(), e.State.ActualSHA256, e.actual())
	}
	if _, err := os.Stat(filepath.Join(e.Dir, "journal.json")); !os.IsNotExist(err) {
		t.Fatal("a resolved first-version failure left a recovery journal")
	}
	if next := applyNextAction(e.State); next != firstVersionFailed || strings.Contains(next, "host-operator") {
		t.Fatalf("next step: %q", next)
	}
	// vectory status says the same, never the emergency procedure.
	now := time.Now()
	e.State.LastHeartbeat = &now
	v := &StatusView{StateDir: e.Dir, Settings: e.Settings, State: e.State, DeviceID: "device", BinaryOK: true, Foreground: true}
	if next := v.nextStep(now); next != firstVersionFailed {
		t.Fatalf("status next: %q", next)
	}
	status := RenderStatus(v, now)
	if strings.Contains(status, "Recovery needs host-operator intervention") || strings.Contains(status, "Do not delete identity") {
		t.Fatalf("status:\n%s", status)
	}
	// Restarting the agent starts nothing: the device waits for a corrected
	// version or Retry.
	if err := e.StartExisting(context.Background()); err != nil || d.Alive() || d.starts != 1 {
		t.Fatalf("restart: %v alive %v starts %d", err, d.Alive(), d.starts)
	}
}

// A file that was in the managed path before the attempt goes back there;
// it never ran verified, so nothing else is claimed about it.
func TestFirstVersionFailureRestoresWhatTheAttemptReplaced(t *testing.T) {
	e, m, d := firstVersionFixture(t, oldConfig)
	d.failNext = true
	if err := e.Reconcile(context.Background(), m); err == nil {
		t.Fatal("the failed activation was not reported")
	}
	if e.actual() != Digest(oldConfig) || e.State.ActualSHA256 != Digest(oldConfig) || d.Alive() {
		t.Fatalf("actual %q alive %v", e.actual(), d.Alive())
	}
}

// "Vector keeps running the last working configuration" only where one ran.
func TestNextActionOnlyClaimsARunningConfigurationThatExists(t *testing.T) {
	for _, code := range []string{"VALIDATION_FAILED", "CAPABILITY_DENIED"} {
		state := State{Error: &Issue{Code: code}, LastGoodSHA256: "a"}
		if !strings.HasSuffix(applyNextAction(state), "Vector keeps running the last working configuration.") {
			t.Fatalf("%s with a last-good configuration: %q", code, applyNextAction(state))
		}
		state.LastGoodSHA256 = ""
		if next := applyNextAction(state); strings.Contains(next, "keeps running") || !strings.Contains(next, "Vector isn't running yet") {
			t.Fatalf("%s on a new device: %q", code, next)
		}
	}
	if next := applyNextAction(State{Error: &Issue{Code: "ROLLBACK_FAILED"}, LastGoodSHA256: "a"}); !strings.Contains(next, "host-operator intervention") {
		t.Fatalf("a failed restore of verified content still needs the host operator: %q", next)
	}
}

func vectorLogLine(at time.Time, level, message, errorType, errorText string) string {
	record := map[string]any{"timestamp": at.UTC().Format(time.RFC3339Nano), "level": level, "message": message, "target": "vector::internal_events::http_client",
		"span": map[string]any{"component_id": "out", "component_kind": "sink", "component_type": "http", "name": "sink"}}
	if errorType != "" {
		record["error_type"], record["stage"] = errorType, "processing"
	}
	if errorText != "" {
		record["error"] = errorText
	}
	line, _ := json.Marshal(record)
	return string(line)
}

// vectory status reads a failing sink from the local Vector log: a row under
// Vector and a Next line naming the destination, instead of "Nothing to do".
func TestStatusReadsDeliveryFailuresFromTheLocalVectorLog(t *testing.T) {
	dir := t.TempDir()
	managed := filepath.Join(dir, "managed.json")
	if err := os.WriteFile(managed, []byte(`{"sinks":{"out":{"type":"http","inputs":["in"],"uri":"http://127.0.0.1:8239/ingest"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	refused := "error trying to connect: tcp connect error: Connection refused (os error 111)"
	lines := []string{
		vectorLogLine(now.Add(-3*time.Minute), "WARN", "HTTP error.", "request_failed", refused), // too old
	}
	for i := 0; i < 7; i++ {
		at := now.Add(-time.Duration(50-i*7) * time.Second)
		lines = append(lines,
			vectorLogLine(at, "WARN", "HTTP error.", "request_failed", refused),
			vectorLogLine(at, "WARN", "Retrying after error.", "", "Failed to make HTTP(S) request: "+refused))
	}
	lines = append(lines,
		vectorLogLine(now.Add(-5*time.Second), "WARN", "Internal log [HTTP error.] is being suppressed to avoid flooding.", "", ""),
		vectorLogLine(now.Add(-2*time.Second), "WARN", "Internal log [HTTP error.] has been suppressed 20 times.", "", ""),
		`not a JSON line`)
	if err := os.WriteFile(filepath.Join(dir, vectorLogName), []byte(strings.Join(lines, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	problem := recentDeliveryProblem(dir, managed, now)
	if problem == nil || problem.Errors != 27 {
		t.Fatalf("%+v", problem)
	}
	if got := problem.Summary(); got != "sink out: 27 errors in the last minute: Connection refused (127.0.0.1:8239) · see vectory logs" {
		t.Fatalf("summary: %q", got)
	}
	heartbeat := now.Add(-10 * time.Second)
	v := &StatusView{StateDir: dir, Settings: Settings{Name: "edge", ManagedConfig: managed}, State: State{Desired: &Desired{VersionID: "v"}, LastHeartbeat: &heartbeat, ApplyState: "verified_applied"}, DeviceID: "device", BinaryOK: true, Foreground: true, Delivery: problem}
	if next := v.nextStep(now); next != "Check that 127.0.0.1:8239 is reachable from this host." {
		t.Fatalf("next: %q", next)
	}
	if status := RenderStatus(v, now); !strings.Contains(status, "           sink out: 27 errors in the last minute") || strings.Contains(status, "Nothing to do") {
		t.Fatalf("status:\n%s", status)
	}
	if StatusJSON(v)["delivery"] == nil {
		t.Fatal("status --json lacks the delivery problem")
	}
	// A quiet log is nothing to report.
	if recentDeliveryProblem(dir, managed, now.Add(5*time.Minute)) != nil {
		t.Fatal("old failures reported as current")
	}
	if sinkDestination([]byte(`{"sinks":{"es":{"endpoints":["https://user:secret@es.example.test/_bulk"]}}}`), "es") != "es.example.test:443" {
		t.Fatal("destination must be host:port only")
	}
}

// Restricted mode runs Vectory's own monitoring path without a host
// allowance: one loopback prometheus_exporter fed only by internal_metrics.
// Anything else that listens still needs its allowance.
func TestRestrictedModeAllowsOnlyTheMonitoringExporterWithoutAnAllowance(t *testing.T) {
	p := CapabilityPolicy{}
	base := `"demo":{"type":"demo_logs","format":"json"}`
	pipeline := func(sources, sinks string) string {
		return `{"sources":{` + base + sources + `},"sinks":{"out":{"type":"console","inputs":["demo"],"target":"stderr","encoding":{"codec":"json"}}` + sinks + `}}`
	}
	exporter := func(id, address, inputs string) string {
		return `,"` + id + `":{"type":"prometheus_exporter","inputs":` + inputs + `,"address":"` + address + `"}`
	}
	accepted := map[string]string{
		"the Add monitoring shape": pipeline(`,"vectory_internal_metrics":{"type":"internal_metrics"}`, exporter("vectory_metrics_exporter", "127.0.0.1:9598", `["vectory_internal_metrics"]`)),
		"IPv6 loopback":            pipeline(`,"m":{"type":"internal_metrics"}`, exporter("prom", "[::1]:9600", `["m"]`)),
		"two metric sources":       pipeline(`,"m":{"type":"internal_metrics"},"n":{"type":"internal_metrics","namespace":"edge"}`, exporter("prom", "127.0.0.1:9598", `["m","n"]`)),
	}
	for name, config := range accepted {
		if err := p.Check([]byte(config)); err != nil {
			t.Errorf("%s refused: %v", name, err)
		}
	}
	refused := map[string]struct{ config, code, resource string }{
		"every interface":     {pipeline(`,"m":{"type":"internal_metrics"}`, exporter("prom", "0.0.0.0:9598", `["m"]`)), "LISTENER_DENIED", "0.0.0.0:9598"},
		"a host name":         {pipeline(`,"m":{"type":"internal_metrics"}`, exporter("prom", "localhost:9598", `["m"]`)), "LISTENER_DENIED", "localhost:9598"},
		"events, not metrics": {pipeline(``, exporter("prom", "127.0.0.1:9598", `["demo"]`)), "LISTENER_DENIED", "127.0.0.1:9598"},
		"mixed inputs":        {pipeline(`,"m":{"type":"internal_metrics"}`, exporter("prom", "127.0.0.1:9598", `["m","demo"]`)), "LISTENER_DENIED", "127.0.0.1:9598"},
		"a wildcard input":    {pipeline(`,"m":{"type":"internal_metrics"}`, exporter("prom", "127.0.0.1:9598", `["m*"]`)), "LISTENER_DENIED", "127.0.0.1:9598"},
		"a second listener": {pipeline(`,"m":{"type":"internal_metrics"}`, exporter("prom_a", "127.0.0.1:9598", `["m"]`)+exporter("prom_b", "127.0.0.1:9599", `["m"]`)),
			"LISTENER_DENIED", "127.0.0.1:9599"},
		"another listener": {pipeline(`,"m":{"type":"internal_metrics"},"web":{"type":"http_server","address":"127.0.0.1:8080"}`, exporter("prom", "127.0.0.1:9598", `["m"]`)),
			"LISTENER_DENIED", "127.0.0.1:8080"},
	}
	for name, c := range refused {
		var refusal *PolicyRefusal
		if err := p.Check([]byte(c.config)); !errors.As(err, &refusal) || refusal.Code != c.code || refusal.Resource != c.resource {
			t.Errorf("%s: %v (%+v)", name, err, refusal)
		}
	}
	// The exemption covers the listener only: its other settings are checked.
	withKey := pipeline(`,"m":{"type":"internal_metrics"}`, `,"prom":{"type":"prometheus_exporter","inputs":["m"],"address":"127.0.0.1:9598","tls":{"enabled":true,"key_file":"/etc/secret/key.pem"}}`)
	var refusal *PolicyRefusal
	if err := p.Check([]byte(withKey)); !errors.As(err, &refusal) || refusal.Code != "FILE_ACCESS_DENIED" {
		t.Fatalf("TLS files outside the host's roots: %v", err)
	}
}
