package main

import (
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

// Commands the agent prints act on the state directory the operator named,
// not on the platform's default one.
func TestPrintedCommandsNameTheStateDirectoryTheOperatorUsed(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	named := " --state-dir " + agent.ShellQuote(dir)
	code, stdout, stderr := invoke("pause", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "until you run: sudo vectory resume"+named+"\n") {
		t.Fatalf("pause: %d %q %q", code, stdout, stderr)
	}
	code, stdout, stderr = invoke("retry", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "`vectory status"+named+"` shows what it runs.") {
		t.Fatalf("retry: %d %q %q", code, stdout, stderr)
	}
	code, stdout, stderr = invoke("uninstall", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "vectory uninstall --purge"+named+"\n") {
		t.Fatalf("uninstall: %d %q %q", code, stdout, stderr)
	}
	// An enrolled, running agent whose Vector binary is not the adopted one.
	dir = statusDir(t, nil, "", 0)
	named = " --state-dir " + agent.ShellQuote(dir)
	code, stdout, stderr = invoke("status", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "`vectory re-adopt --expected-sha256 SHA256"+named+"`") {
		t.Fatalf("status: %d %q %q", code, stdout, stderr)
	}
	if code, stdout, _ = invoke("status", "--state-dir", dir, "--json"); code != 0 || !strings.Contains(stdout, "re-adopt --expected-sha256 SHA256 --state-dir") {
		t.Fatalf("status --json: %d %q", code, stdout)
	}
	if err := agent.SetPause(dir, true); err != nil {
		t.Fatal(err)
	}
	if code, stdout, _ = invoke("status", "--state-dir", dir); code != 0 || !strings.Contains(stdout, "`vectory re-adopt") {
		t.Fatalf("a changed binary comes before a pause: %d %q", code, stdout)
	}
}
