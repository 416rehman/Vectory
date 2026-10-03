package agent

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// A command the agent prints for an operator to run acts on the agent the
// operator copies it for: on a host with another state directory, it names it.
func TestCommandForNamesAStateDirectoryThatIsNotTheDefault(t *testing.T) {
	def := DefaultPaths().StateDir
	if got := CommandFor(def, "sudo vectory resume"); got != "sudo vectory resume" {
		t.Fatalf("the default directory needs no flag: %q", got)
	}
	if got := CommandFor(def+"/", "sudo vectory resume"); got != "sudo vectory resume" {
		t.Fatalf("the default directory spelled with a slash: %q", got)
	}
	if got := CommandFor("", "sudo vectory resume"); got != "sudo vectory resume" {
		t.Fatalf("an unknown directory leaves the command as written: %q", got)
	}
	cases := map[string]string{
		"/srv/vectory/agent": "/srv/vectory/agent",
		"/srv/my agent":      "'/srv/my agent'",
		"/srv/a;b":           "'/srv/a;b'",
		"/srv/a&b":           "'/srv/a&b'",
		"/srv/(old)":         "'/srv/(old)'",
		"/srv/$HOME":         "'/srv/$HOME'",
		"/srv/a`b`":          "'/srv/a`b`'",
		"/srv/o'brien":       `'/srv/o'"'"'brien'`,
	}
	if runtime.GOOS == "windows" {
		cases["/srv/o'brien"] = "'/srv/o''brien'"
	}
	for dir, quoted := range cases {
		want := "vectory allow --network 127.0.0.1:8688 --state-dir " + quoted
		if got := CommandFor(dir, "vectory allow --network 127.0.0.1:8688"); got != want {
			t.Errorf("%q: got %q, want %q", dir, got, want)
		}
	}
}

func TestStatusNextStepsNameANonDefaultStateDirectory(t *testing.T) {
	dir := "/srv/vectory agent"
	flag := " --state-dir '/srv/vectory agent'"
	now := time.Now()
	last := now.Add(-5 * time.Second)
	enrolled := func(change func(*StatusView)) string {
		v := &StatusView{StateDir: dir, DeviceID: "d", BinaryOK: true, Foreground: true, Settings: Settings{Name: "edge"}, State: State{LastHeartbeat: &last, Policy: Policy{HeartbeatSeconds: 60}}}
		change(v)
		return v.nextStep(now)
	}
	for name, test := range map[string]struct {
		change func(*StatusView)
		want   string
	}{
		"binary changed": {func(v *StatusView) { v.BinaryOK = false }, "`vectory re-adopt --expected-sha256 SHA256" + flag + "`"},
		"paused":         {func(v *StatusView) { v.LocalPaused = true }, "Resume it with: sudo vectory resume" + flag},
		"first check-in": {func(v *StatusView) { v.State.LastHeartbeat = nil }, "`sudo vectory doctor" + flag + "`"},
		"silent":         {func(v *StatusView) { v.State.LastHeartbeat = &[]time.Time{now.Add(-time.Hour)}[0] }, "`sudo vectory doctor" + flag + "`"},
		"not running":    {func(v *StatusView) { v.Foreground = false }, "register a service with vectory setup" + flag},
		"binary finding": {func(v *StatusView) {
			v.State.Error = &Issue{Code: "VALIDATION_FAILED", Diagnostics: []Diagnostic{{Severity: "error", Code: "VECTOR_BINARY_UNAVAILABLE", Message: "m"}}}
		}, "vectory re-adopt --expected-sha256 SHA256" + flag + ". Then choose Retry in the dashboard or run vectory retry" + flag},
		"validation failed": {func(v *StatusView) {
			v.State.Error = &Issue{Code: "VALIDATION_FAILED"}
		}, "`vectory logs" + flag + "`"},
		"sink failing": {func(v *StatusView) { v.Delivery = &DeliveryProblem{ComponentID: "out", Errors: 3} }, "`vectory logs" + flag + "`"},
	} {
		if got := enrolled(test.change); !strings.Contains(got, test.want) {
			t.Errorf("%s: %q lacks %q", name, got, test.want)
		}
	}
	v := &StatusView{StateDir: dir, Pending: &PendingEnrollment{Delivery: "no"}}
	if got := v.nextStep(now); !strings.Contains(got, "(vectory doctor"+flag+")") {
		t.Errorf("an enrollment that never left: %q", got)
	}
}

// What a refused version tells the operator to run names the agent's state
// directory, in the issue the agent reports and in the text `vectory status`
// prints from it, and the report doesn't hide the path.
func TestRefusalFixNamesTheStateDirectoryAndSurvivesRedaction(t *testing.T) {
	e, _, _ := fixture(t, newConfig)
	data := []byte(`{"sources":{"in":{"type":"demo_logs"}},"sinks":{"out":{"type":"http","inputs":["in"],"uri":"http://127.0.0.1:8688/","encoding":{"codec":"json"}}}}`)
	err := e.Settings.CapabilityPolicy.Check(data)
	diagnostics := e.policyDiagnostics(err, data)
	if len(diagnostics) != 1 {
		t.Fatalf("%v: %+v", err, diagnostics)
	}
	want := "vectory allow --network 127.0.0.1:8688 --state-dir " + ShellQuote(e.Dir)
	if !strings.Contains(diagnostics[0].Hint, want) || strings.Contains(diagnostics[0].Hint, redactedToken) {
		t.Fatalf("hint %q lacks %q", diagnostics[0].Hint, want)
	}
	v := &StatusView{StateDir: e.Dir, Settings: Settings{Name: "edge"}, State: State{ApplyState: "failed", Error: &Issue{Code: "CAPABILITY_DENIED", Diagnostics: diagnostics}}}
	if out := RenderStatus(v, time.Now()); !strings.Contains(out, "Fix: Allow it on the host, with the agent stopped: "+want) {
		t.Fatalf("status:\n%s", out)
	}
	if line := problemText(v.State.Error); !strings.Contains(line, want) {
		t.Fatalf("the agent log line: %q", line)
	}
	// The same refusal from a policy that doesn't know the directory.
	var refusal *PolicyRefusal
	if !asPolicyRefusal(err, &refusal) || strings.Contains(refusal.Diagnostic().Hint, "--state-dir") {
		t.Fatal("a refusal without a directory printed one")
	}
}

func asPolicyRefusal(err error, target **PolicyRefusal) bool {
	refusal, ok := err.(*PolicyRefusal)
	*target = refusal
	return ok
}
