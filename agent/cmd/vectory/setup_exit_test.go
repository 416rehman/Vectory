package main

import (
	"errors"
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
