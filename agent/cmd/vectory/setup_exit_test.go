package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

// Setup that enrolled and checked in, but left nothing to keep the agent
// running, ends with exit 3 so scripts and the installer notice; the
// operator's own --service none is a success.
func TestSetupExitCodes(t *testing.T) {
	cases := []struct {
		name        string
		result      agent.SetupResult
		err         error
		interrupted bool
		want        int
	}{
		{"kept running by a service", agent.SetupResult{OK: true, Service: "systemd"}, nil, false, exitOK},
		{"--service none", agent.SetupResult{OK: true, Service: "none"}, nil, false, exitOK},
		{"no service manager here", agent.SetupResult{OK: true, Service: "none", NeedsAttention: true}, nil, false, exitAttention},
		{"failed", agent.SetupResult{NeedsAttention: true}, errors.New("refused"), false, exitFailed},
		{"interrupted", agent.SetupResult{}, errors.New("interrupted"), true, exitInterrupted},
	}
	for _, c := range cases {
		if got := setupExitCode(c.result, c.err, c.interrupted); got != c.want {
			t.Errorf("%s: exit %d, want %d", c.name, got, c.want)
		}
	}
	if exitAttention != 3 {
		t.Fatal("exit 3 is documented for setup that needs attention")
	}
}

// Adopting a running Vector as it is and leaving it running beside the agent
// are opposite choices: asking for both is a usage error, refused before
// anything is checked.
func TestSetupRefusesToAdoptAndKeepAtOnce(t *testing.T) {
	code, stdout, stderr := invoke("setup", "--adopt-existing", "--keep-existing-vector", "--server", "https://127.0.0.1:9", "--dry-run")
	if code != exitUsage || !strings.Contains(stderr, "choose one of --adopt-existing or --keep-existing-vector") || strings.Contains(stdout, "Vectory agent setup") {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	_, help, _ := invoke("help", "setup")
	for _, want := range []string{"--adopt-existing", "--keep-existing-vector", "adoption-inventory"} {
		if !strings.Contains(help, want) {
			t.Fatalf("setup help doesn't mention %q:\n%s", want, help)
		}
	}
}
