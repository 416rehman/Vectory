package agent

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// validationDriver runs the real validation, in a child process, and stands in
// for the running Vector, so a test can see that validation never touches it.
type validationDriver struct {
	*VectorDriver
	alive       bool
	activations int
}

func (d *validationDriver) Alive() bool { return d.alive }
func (d *validationDriver) Stop() error { d.alive = false; return nil }
func (d *validationDriver) Activate(context.Context, string) error {
	d.activations++
	d.alive = true
	return nil
}

// validationDevice is a device whose Vector validates with the stand-in
// executable, and whose validation time limit is one second.
func validationDevice(t *testing.T, config fakeVectorConfig) (*applyDevice, *validationDriver) {
	t.Helper()
	binary := standInVector(t, config)
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	d := newApplyDevice(t)
	d.e.Settings.VectorBinary, d.e.Settings.VectorBinarySHA256, d.e.Settings.ValidationSeconds = binary, digest, 1
	driver := &validationDriver{VectorDriver: &VectorDriver{Settings: d.e.Settings}, alive: true}
	d.e.Driver = driver
	server := newDownloadServer(t, newConfig, nil)
	d.e.Client = &Client{HTTP: server.Client(), Base: server.URL}
	return d, driver
}

func waitUntilGone(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); processAlive(pid); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d is still running", pid)
		}
	}
}

// A validation that outlasts its time limit rejects the version as unverified:
// the child is killed, the diagnostic names the timeout and what to do, Vector
// keeps running the old configuration untouched, nothing is left half done,
// and the version isn't tried again until someone asks.
func TestValidationTimeoutRejectsTheVersionAndKeepsTheOldConfiguration(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "validation.pid")
	calls := filepath.Join(t.TempDir(), "validations.log")
	d, driver := validationDevice(t, fakeVectorConfig{Validate: "hang", PIDFile: pidFile, Calls: calls})
	ctx := context.Background()

	started := time.Now()
	if err := d.e.Reconcile(ctx, d.m); err == nil {
		t.Fatal("a validation that timed out was treated as valid")
	}
	if took := time.Since(started); took < time.Second || took > 15*time.Second {
		t.Fatalf("validation was cut off after %s, not at its one-second limit", took)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("the stand-in never started: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	waitUntilGone(t, pid)

	issue := d.e.State.Error
	if d.e.State.ApplyState != "failed" || issue == nil || issue.Code != "VALIDATION_FAILED" || issue.Stage != "validation" {
		t.Fatalf("state %s, issue %+v", d.e.State.ApplyState, issue)
	}
	found := diagnostic(issue, "VECTOR_TIMEOUT")
	if found == nil || !strings.Contains(found.Message, "did not finish validating this version within 1 s") || !strings.Contains(found.Hint, "kept running the previous configuration") || !strings.Contains(found.Hint, "Retry application") {
		t.Fatalf("the diagnostic doesn't name the timeout and the fix: %+v", issue.Diagnostics)
	}
	if strings.Contains(issue.Message, "rejected") {
		t.Fatalf("a timeout is not Vector rejecting the version: %q", issue.Message)
	}
	if d.e.State.FailedGeneration == nil || *d.e.State.FailedGeneration != d.m.Generation {
		t.Fatal("a version that could not be verified isn't held back")
	}
	if driver.activations != 0 || !driver.Alive() {
		t.Fatal("Vector was touched by a validation that timed out")
	}
	d.requireIntact(t)
	if managed, _ := os.ReadFile(d.managed); Digest(managed) != Digest(oldConfig) {
		t.Fatal("the managed configuration changed")
	}
	for _, name := range []string{"journal.json", "pre-attempt.json"} {
		if _, err := os.Stat(filepath.Join(d.e.Dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s exists although nothing was committed", name)
		}
	}

	// Held back: another check-in doesn't start another validation.
	if err := d.e.Reconcile(ctx, d.m); err != nil {
		t.Fatalf("the held-back version isn't quietly skipped: %v", err)
	}
	if log, _ := os.ReadFile(calls); strings.Count(string(log), "validate") != 1 {
		t.Fatalf("validation ran again without a retry request:\n%s", log)
	}

	// Choosing Retry application with a healthy Vector applies it.
	standInVector(t, fakeVectorConfig{Validate: "ok", Calls: calls})
	if err := QueueRetry(d.e.Dir); err != nil {
		t.Fatal(err)
	}
	if !d.e.takeQueuedRetry() {
		t.Fatal("the retry request found nothing held back")
	}
	if err := d.e.Reconcile(ctx, d.m); err != nil {
		t.Fatalf("the retried version didn't apply: %v", err)
	}
	d.requireConverged(t)
}

// A validation that takes long but finishes inside its limit is not a timeout.
func TestSlowValidationWithinItsLimitStillPasses(t *testing.T) {
	d, driver := validationDevice(t, fakeVectorConfig{Validate: "slow", Seconds: 0.3})
	if err := d.e.Reconcile(context.Background(), d.m); err != nil {
		t.Fatalf("a slow validation was rejected: %v", err)
	}
	if driver.activations != 1 {
		t.Fatalf("activations: %d", driver.activations)
	}
	d.requireConverged(t)
}

// adoptPrivateStandIn gives the device its own copy of the stand-in as the
// adopted Vector, so a test can change the binary without touching the one
// every other test shares.
func adoptPrivateStandIn(t *testing.T, d *applyDevice, driver *validationDriver, config fakeVectorConfig) string {
	t.Helper()
	shared := standInVector(t, config)
	data, err := os.ReadFile(shared)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), filepath.Base(shared))
	if err = os.WriteFile(binary, data, 0755); err != nil {
		t.Fatal(err)
	}
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	d.e.Settings.VectorBinary, d.e.Settings.VectorBinarySHA256 = binary, digest
	driver.VectorDriver.Settings = d.e.Settings
	return binary
}

// A package upgrade replaces the adopted Vector. The agent runs nothing it did
// not approve, so the apply fails before Vector starts, and the finding names
// the binary and how to approve the new one, not the pipeline.
func TestChangedVectorBinaryFailsAnApplyWithoutRunningIt(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "validations.log")
	d, driver := validationDevice(t, fakeVectorConfig{Validate: "ok", Calls: calls})
	binary := adoptPrivateStandIn(t, d, driver, fakeVectorConfig{Validate: "ok", Calls: calls})
	f, err := os.OpenFile(binary, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.WriteString("\n"); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}

	if err = d.e.Reconcile(context.Background(), d.m); err == nil {
		t.Fatal("a version was applied although the adopted Vector binary changed")
	}
	issue := d.e.State.Error
	if d.e.State.ApplyState != "failed" || issue == nil || issue.Code != "VALIDATION_FAILED" || issue.Stage != "validation" {
		t.Fatalf("state %s, issue %+v", d.e.State.ApplyState, issue)
	}
	found := diagnostic(issue, "VECTOR_BINARY_UNAVAILABLE")
	if found == nil || !strings.Contains(found.Message, "binary this agent approved") || !strings.Contains(found.Hint, "vectory re-adopt") {
		t.Fatalf("the finding doesn't name the binary and the fix: %+v", issue.Diagnostics)
	}
	if strings.Contains(issue.Message, "rejected") || strings.Contains(found.Message+found.Hint, binary) {
		t.Fatalf("Vector didn't reject anything, and the finding must not carry the binary's path: %q %+v", issue.Message, found)
	}
	if _, statErr := os.Stat(calls); !os.IsNotExist(statErr) {
		t.Fatal("Vector was started although its binary changed")
	}
	if driver.activations != 0 {
		t.Fatal("a version was activated")
	}
	if next := applyNextAction(d.e.State); !strings.Contains(next, "vectory re-adopt") || strings.Contains(next, "vectory logs") {
		t.Fatalf("the next step is for a pipeline problem: %q", next)
	}
	if line := problemText(issue); !strings.Contains(line, "VECTOR_BINARY_UNAVAILABLE") || !strings.Contains(line, "re-adopt") {
		t.Fatalf("the agent log doesn't name the cause: %q", line)
	}
	d.requireIntact(t)

	// Approving the new binary and retrying applies the version.
	if err = os.WriteFile(binary, mustRead(t, standInVector(t, fakeVectorConfig{Validate: "ok", Calls: calls})), 0755); err != nil {
		t.Fatal(err)
	}
	digest, err := FileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	d.e.Settings.VectorBinarySHA256 = digest
	driver.VectorDriver.Settings = d.e.Settings
	if err = QueueRetry(d.e.Dir); err != nil {
		t.Fatal(err)
	}
	if !d.e.takeQueuedRetry() {
		t.Fatal("the retry request found nothing held back")
	}
	if err = d.e.Reconcile(context.Background(), d.m); err != nil {
		t.Fatalf("the version didn't apply once the binary was approved: %v", err)
	}
	d.requireConverged(t)
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// When Vector rejects a version, the diagnostic doesn't call it a timeout.
func TestValidationRejectionIsNotATimeout(t *testing.T) {
	d, _ := validationDevice(t, fakeVectorConfig{Validate: "reject"})
	if err := d.e.Reconcile(context.Background(), d.m); err == nil {
		t.Fatal("a rejected version was applied")
	}
	if diagnostic(d.e.State.Error, "VECTOR_TIMEOUT") != nil || d.e.State.Error.Message != "Vector rejected this version on the device" {
		t.Fatalf("%+v", d.e.State.Error)
	}
}
