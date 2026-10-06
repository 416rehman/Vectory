package main

import (
	"strings"
	"testing"
)

func TestTrustServerRequiresExplicitAddressAndExactlyOneCAChoice(t *testing.T) {
	for _, args := range [][]string{
		{"trust-server"},
		{"trust-server", "--server", "https://example.invalid"},
		{"trust-server", "--server", "https://example.invalid", "--ca-sha256="},
		{"trust-server", "--server", "https://example.invalid", "--ca-sha256", "abc", "--ca-file="},
	} {
		code, _, stderr := invoke(args...)
		if code != exitUsage || !strings.Contains(stderr, "exactly one") {
			t.Fatalf("%v: exit %d, error %q", args, code, stderr)
		}
	}
	code, help, stderr := invoke("help", "trust-server")
	if code != exitOK || stderr != "" || !strings.Contains(help, "--ca-file=") || !strings.Contains(help, "exact server address saved when this host enrolled") {
		t.Fatalf("trust-server help: exit %d, help %q, error %q", code, help, stderr)
	}
}

func TestInstallerPreflightRequiresCandidateAndStaysHiddenFromSetupHelp(t *testing.T) {
	code, _, stderr := invoke("setup", "--installer-preflight=")
	if code != exitUsage || !strings.Contains(stderr, "absolute staged candidate path") {
		t.Fatalf("empty preflight flag: exit %d, error %q", code, stderr)
	}
	_, help, _ := invoke("help", "setup")
	if strings.Contains(help, "installer-preflight") {
		t.Fatal("installer-only flag was exposed in user-facing setup help")
	}
}
