package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

// A command that fails because the disk is full says which disk and how to
// fix it, in text and in JSON.
func TestCommandFailureNamesTheFixForAFullDisk(t *testing.T) {
	full := fmt.Errorf("save the pause marker: %w", &agent.DiskFullError{Dir: "/var/lib/vectory-agent"})

	var stdout, stderr bytes.Buffer
	c := newCLI(&command{name: "pause"}, &stdout, &stderr)
	if code := c.fail(full); code != exitFailed {
		t.Fatalf("exit %d", code)
	}
	if got := stderr.String(); !strings.Contains(got, "the disk that holds /var/lib/vectory-agent is full") || !strings.Contains(got, "Free some space on that disk, then run the command again.") {
		t.Fatalf("stderr: %q", got)
	}

	stdout.Reset()
	asJSON := true
	c = newCLI(&command{name: "pause"}, &stdout, &stderr)
	c.json = &asJSON
	c.fail(full)
	var document map[string]string
	if err := json.Unmarshal(stdout.Bytes(), &document); err != nil || document["code"] != "DISK_FULL" || !strings.Contains(document["fix"], "Free some space") || !strings.Contains(document["error"], "full") {
		t.Fatalf("json: %s (%v)", stdout.String(), err)
	}
}
