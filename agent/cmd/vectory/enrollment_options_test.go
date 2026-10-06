package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func enrollmentCLIState(t *testing.T) (string, []byte, []byte) {
	t.Helper()
	dir := t.TempDir()
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), agent.Settings{Server: "https://127.0.0.1:9", Name: "synthetic", CAFile: filepath.Join(dir, "missing-private-ca.pem")}); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(dir, agent.State{ApplyState: "unmanaged", Policy: agent.Policy{HeartbeatSeconds: 60}}); err != nil {
		t.Fatal(err)
	}
	settings, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	state, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	return dir, settings, state
}

func TestEnrollmentCLIRefusalsDoNotSaveSettingsOrAllocateIdentity(t *testing.T) {
	for _, test := range []struct {
		name, command string
		extra         []string
		want          int
	}{
		{"empty-token", "enroll", []string{"--token", "   "}, 1},
		{"oversize-token", "enroll", []string{"--token", strings.Repeat("x", 4097)}, 1},
		{"missing-ca", "enroll", []string{"--token", "synthetic"}, 1},
		{"recovery-without-identity", "recover-enrollment", []string{"--token", "synthetic"}, 1},
		{"positional", "enroll", []string{"unexpected", "--token", "synthetic"}, 2},
		{"recovery-positional", "recover-enrollment", []string{"--token", "synthetic", "unexpected"}, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir, settings, state := enrollmentCLIState(t)
			args := append([]string{test.command, "--state-dir", dir, "--server", "https://127.0.0.1:9", "--id", "synthetic"}, test.extra...)
			code, diagnostic := bindingCommand(t, args)
			if code != test.want || strings.TrimSpace(diagnostic) == "" {
				t.Fatal("invalid enrollment did not refuse clearly", code, diagnostic)
			}
			current, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
			currentState, _ := os.ReadFile(filepath.Join(dir, "state.json"))
			if !bytes.Equal(settings, current) || !bytes.Equal(state, currentState) {
				t.Fatal("local refusal changed settings or state")
			}
			for _, name := range []string{"private-key.pem", "enrollment.json", "pending-recovery"} {
				if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
					t.Fatal("local refusal allocated enrollment preparation")
				}
			}
		})
	}
}

func TestEnrollmentCLIExplicitSystemTrustIsDifferentFromOmission(t *testing.T) {
	dir, before, _ := enrollmentCLIState(t)
	args := []string{"enroll", "--state-dir", dir, "--server", "https://127.0.0.1:9", "--id", "synthetic", "--token", syntheticToken}
	code, diagnostic := bindingCommand(t, args)
	if code != 1 || !strings.Contains(diagnostic, "cannot read trusted CA file") {
		t.Fatal("omitted CA did not retain the saved private trust path", code, diagnostic)
	}
	unchanged, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if !bytes.Equal(before, unchanged) {
		t.Fatal("omitted CA local refusal changed settings")
	}
	code, diagnostic = bindingCommand(t, append(args, "--ca-file="))
	if code != 1 || !strings.Contains(diagnostic, "Nothing is accepting connections on 127.0.0.1:9") || !strings.Contains(diagnostic, "Nothing was sent to the server") || strings.Contains(diagnostic, "cannot read trusted CA file") {
		t.Fatal("explicit portable empty flag did not select system trust", code, diagnostic)
	}
	saved, _ := agent.LoadSettings(dir)
	if saved.CAFile != "" {
		t.Fatal("explicit system trust kept additional roots")
	}
	// A refused connection provably sent nothing: the request is kept, but
	// marked as unsent so the server, name or token can still be corrected.
	pending, err := agent.ReadPendingEnrollment(dir)
	if err != nil || pending == nil || pending.Delivery != "no" || pending.LastFailure != "CONNECTION_REFUSED" {
		t.Fatal("unsent request was not recorded as correctable", pending, err)
	}
	code, diagnostic = bindingCommand(t, []string{"enroll", "--state-dir", dir, "--server", "https://127.0.0.1:10", "--id", "corrected", "--token", strings.Repeat("cd", 32), "--ca-file="})
	if code != 1 || !strings.Contains(diagnostic, "127.0.0.1:10") {
		t.Fatal("unsent request prevented correcting the server and name", code, diagnostic)
	}
	if pending, _ = agent.ReadPendingEnrollment(dir); pending == nil || pending.Name != "corrected" || pending.Server != "https://127.0.0.1:10" {
		t.Fatal("corrected intent was not recorded", pending)
	}
}

func TestEnrollmentCLIAlreadyEnrolledCannotRewriteCA(t *testing.T) {
	dir, settings, _ := enrollmentCLIState(t)
	if err := agent.WriteJSON(filepath.Join(dir, "identity.json"), agent.IdentityBundle{Credentials: agent.Credentials{DeviceID: "synthetic-existing"}, PrivateKeyPEM: "synthetic-not-a-key"}); err != nil {
		t.Fatal(err)
	}
	for _, extra := range [][]string{nil, {"--ca-file="}, {"--ca-file", "another-ca.pem"}} {
		args := append([]string{"enroll", "--state-dir", dir, "--server", "https://127.0.0.1:9", "--id", "synthetic", "--token", syntheticToken}, extra...)
		code, diagnostic := bindingCommand(t, args)
		if code != 1 || !strings.Contains(diagnostic, "already enrolled") {
			t.Fatal("ordinary enrolled operation was not refused", code, diagnostic)
		}
		current, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
		if !bytes.Equal(settings, current) {
			t.Fatal("refused ordinary enrollment rewrote trust")
		}
	}
}
