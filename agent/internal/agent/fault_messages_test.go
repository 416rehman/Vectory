package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What an operator reads when the disk is full, in the places the agent
// speaks: its log, setup's output and the local status.
func TestFullDiskIsSaidWithItsFixWhereverTheAgentSpeaks(t *testing.T) {
	full := fmt.Errorf("save state: %w", &DiskFullError{Dir: "/var/lib/vectory-agent", cause: errDiskFull})

	log := describeCheckInFailure(full, nil, time.Now())
	if !strings.Contains(log, "the disk that holds /var/lib/vectory-agent is full") || !strings.Contains(log, "Free some space on that disk, then the agent tries again at its next check-in.") {
		t.Fatalf("the agent's log: %q", log)
	}

	run := &setupRun{}
	_, err := run.failErr("install", "Install", full, "Choose an empty --state-dir.")
	var refusal *SetupError
	if !errors.As(err, &refusal) || refusal.Step.Status != "fail" || strings.Contains(refusal.Step.Fix, "--state-dir") || !strings.Contains(refusal.Step.Fix, "Free some space on that disk, then run the command again; setup resumes where it stopped.") {
		t.Fatalf("setup's step: %+v", refusal)
	}

	e := &Engine{Dir: t.TempDir(), Settings: Settings{ManagedConfig: filepath.Join(t.TempDir(), "managed.json")}}
	e.State = State{ApplyState: "failed", LastGoodSHA256: Digest(oldConfig), Error: &Issue{Code: "WRITE_FAILED", Stage: "staging", Message: "Cannot securely stage configuration: the disk is full", Diagnostics: e.storageDiagnostic(&DiskFullError{Dir: filepath.Dir(e.Settings.ManagedConfig), cause: errDiskFull})}}
	if _, line := outcomeLine(e.State); !strings.Contains(line, "couldn't be applied yet") || !strings.Contains(line, "The disk that holds the managed configuration is full") || !strings.Contains(line, "Vector runs the last working configuration.") {
		t.Fatalf("the outcome line: %q", line)
	}
	if next := applyNextAction(e.State); !strings.Contains(next, "Free some space") || !strings.Contains(next, "by itself") {
		t.Fatalf("the next step: %q", next)
	}
}

// A device that is enrolling when the disk fills up fails on the write, with
// the fix, and keeps no partial identity; with space back, the same call works.
func TestEnrollmentKeyOnAFullDiskLeavesNothingPartial(t *testing.T) {
	dir := privateTempDir(t)
	disk := fillDisk(t, 1, "partial")
	_, _, err := EnsureKey(dir)
	var full *DiskFullError
	if !errors.As(err, &full) {
		t.Fatalf("the key write on a full disk isn't reported as such: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "private-key.pem")); !os.IsNotExist(err) {
		t.Fatal("a partial private key was left")
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
	disk.free()
	if _, csr, err := EnsureKey(dir); err != nil || csr == "" {
		t.Fatalf("enrollment can't continue once there is room: %v", err)
	}
}
