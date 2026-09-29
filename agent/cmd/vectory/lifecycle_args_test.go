package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func TestLifecycleCommandsRejectTrailingOperandsBeforeLocalChanges(t *testing.T) {
	dir := t.TempDir()
	if got := run([]string{"pause", "--state-dir", dir, "unexpected"}); got != 2 {
		t.Fatalf("pause with a trailing operand returned %d, want usage error", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "paused")); !os.IsNotExist(err) {
		t.Fatalf("pause changed state despite trailing operand: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte("installed"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := run([]string{"uninstall", "--state-dir", dir, "--purge", "unexpected"}); got != 2 {
		t.Fatalf("purge with a trailing operand returned %d, want usage error", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err != nil {
		t.Fatalf("purge changed state despite trailing operand: %v", err)
	}
	if got := run([]string{"service-install", "--state-dir", dir, "unexpected"}); got != 2 {
		t.Fatalf("service-install with a trailing operand returned %d, want usage error", got)
	}
}

func TestFixedServiceTargetDoesNotAcceptStateDirectory(t *testing.T) {
	code, _, stderr := invoke("service-stop", "--state-dir", t.TempDir())
	if code != exitUsage || !strings.Contains(stderr, "--state-dir cannot select another service") {
		t.Fatalf("explicit state directory accepted: exit=%d stderr=%q", code, stderr)
	}
	defaultTarget := flag.NewFlagSet("service-stop", flag.ContinueOnError)
	defaultTarget.String("state-dir", "default", "state directory")
	if err := defaultTarget.Parse(nil); err != nil || flagSupplied(defaultTarget, "state-dir") {
		t.Fatal("default state directory should not look like an explicit service target")
	}
}

func TestUninstallPreservesStateUnlessExplicitlyPurged(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "state")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(dir, "settings.json")
	installed := agent.Settings{VectorBinary: filepath.Join(parent, "vector"), VectorBinarySHA256: agent.Digest([]byte("fixture vector")), ManagedConfig: filepath.Join(parent, "managed.json"), Adopted: true, ValidationSeconds: 30, StartupSeconds: 20}
	if err := agent.WriteJSON(settings, installed); err != nil {
		t.Fatal(err)
	}
	managed := filepath.Join(parent, "managed.json")
	if err := os.WriteFile(managed, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := run([]string{"uninstall", "--state-dir", dir}); got != 0 {
		t.Fatalf("ordinary uninstall returned %d", got)
	}
	if _, err := os.Stat(settings); err != nil {
		t.Fatalf("ordinary uninstall removed state: %v", err)
	}
	if got := run([]string{"uninstall", "--state-dir", dir, "--purge"}); got != 0 {
		t.Fatalf("purge returned %d", got)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("purge retained state directory: %v", err)
	}
	if _, err := os.Stat(managed); err != nil {
		t.Fatalf("purge removed external managed file: %v", err)
	}
}

func TestPurgeRequiresExplicitStateDirectory(t *testing.T) {
	if got := run([]string{"uninstall", "--purge"}); got != 2 {
		t.Fatalf("purge without --state-dir returned %d, want usage error", got)
	}
}
