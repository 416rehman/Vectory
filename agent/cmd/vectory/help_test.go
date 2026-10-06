package main

import (
	"bytes"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func invoke(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runWith(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestHelpAndVersionWorkBeforeTheCompatibilityForm(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}, {"-help"}, {"help"}} {
		code, stdout, stderr := invoke(args...)
		if code != 0 || stderr != "" || !strings.Contains(stdout, "Get started") || !strings.Contains(stdout, "setup") || strings.Contains(stdout, "Usage of enroll") {
			t.Fatalf("%v: code %d stdout %q stderr %q", args, code, stdout, stderr)
		}
	}
	for _, args := range [][]string{{"--version"}, {"-version"}, {"-v"}, {"version"}} {
		code, stdout, stderr := invoke(args...)
		if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "vectory "+agent.Version+" ") {
			t.Fatalf("%v: code %d stdout %q stderr %q", args, code, stdout, stderr)
		}
	}
	if code, _, stderr := invoke(); code != 2 || !strings.Contains(stderr, "Usage:") {
		t.Fatal("no arguments should print usage to stderr with exit 2", code)
	}
	for _, topic := range []string{"help", "version"} {
		if code, stdout, stderr := invoke("help", topic); code != 0 || stderr != "" || !strings.HasPrefix(stdout, "Usage:  vectory "+topic) {
			t.Fatalf("help %s: code %d stdout %q stderr %q", topic, code, stdout, stderr)
		}
	}
	// Examples teach download, check, run: never piping a script into a shell.
	for _, topic := range []string{"", "setup"} {
		args := []string{"help"}
		if topic != "" {
			args = append(args, topic)
		}
		_, stdout, _ := invoke(args...)
		if strings.Contains(stdout, "| sudo sh") || strings.Contains(stdout, "Invoke-Expression") {
			t.Fatalf("%v runs an unverified download:\n%s", args, stdout)
		}
		if runtime.GOOS == "windows" {
			if !strings.Contains(stdout, "Get-FileHash -LiteralPath") || !strings.Contains(stdout, `-File .\vectory-install.ps1`) {
				t.Fatalf("%v lacks Windows checksum/setup instructions:\n%s", args, stdout)
			}
		} else {
			// Unix staging is private and download trust is explicit.
			if !strings.Contains(stdout, `cd "$(mktemp -d)"`) || !strings.Contains(stdout, "--proto '=https' --proto-redir '=https'") {
				t.Fatalf("%v examples don't keep their files private:\n%s", args, stdout)
			}
			checksum := "sha256sum -c -"
			if runtime.GOOS == "darwin" {
				checksum = "shasum -a 256 -c -"
			}
			if !strings.Contains(stdout, checksum) || !strings.Contains(stdout, "sudo sh vectory-install.sh --create-user") {
				t.Fatalf("%v lacks this platform's checksum/setup instructions:\n%s", args, stdout)
			}
		}
	}
}

func TestSetupExamplesUseTheHostPlatform(t *testing.T) {
	for _, platform := range []string{"linux", "darwin", "windows"} {
		text := strings.Join(setupExamples(platform), "\n")
		if platform == "windows" {
			if strings.Contains(text, "sudo") || strings.Contains(text, "mktemp") || !strings.Contains(text, "Get-FileHash") || !strings.Contains(text, "PowerShell as administrator") {
				t.Fatalf("Windows examples need translation:\n%s", text)
			}
		} else if platform == "darwin" {
			if strings.Contains(text, "sha256sum") || !strings.Contains(text, "shasum -a 256 -c -") {
				t.Fatalf("macOS examples require a nonstandard checksum program:\n%s", text)
			}
		}
	}
}

func TestEveryCommandHasHelpWithPurposeAndHidesCompatibilityFlags(t *testing.T) {
	for _, cmd := range commands {
		if cmd.hidden {
			continue
		}
		for _, args := range [][]string{{"help", cmd.name}, {cmd.name, "--help"}, {cmd.name, "-h"}} {
			code, stdout, stderr := invoke(args...)
			if code != 0 || stderr != "" || !strings.HasPrefix(stdout, "vectory "+cmd.name+": ") || !strings.Contains(stdout, "Usage:\n  vectory "+cmd.name) {
				t.Fatalf("%v: code %d stdout %q stderr %q", args, code, stdout, stderr)
			}
			if strings.Contains(stdout, "Usage of ") || strings.Contains(stdout, "--ip") || strings.Contains(stdout, "--token ") || strings.Contains(stdout, "--id ") || strings.Contains(stdout, "--once") {
				t.Fatalf("%s help shows a compatibility or internal flag:\n%s", cmd.name, stdout)
			}
		}
	}
	_, setup, _ := invoke("help", "setup")
	for _, want := range []string{"--ca-sha256 HEX", "--create-user", "--dry-run", "Examples:", "install.sh", "(default auto)"} {
		if !strings.Contains(setup, want) {
			t.Fatalf("setup help lacks %q", want)
		}
	}
	_, serviceStart, _ := invoke("service-start", "--help")
	if strings.Contains(serviceStart, "--state-dir") {
		t.Fatal("service-start advertises --state-dir, which it refuses")
	}
}

func TestUnknownCommandsAndFlagsSuggestAndExitTwo(t *testing.T) {
	code, stdout, stderr := invoke("instal")
	if code != 2 || stdout != "" || !strings.Contains(stderr, `Did you mean "install"?`) {
		t.Fatal("typo not suggested", code, stderr)
	}
	code, _, stderr = invoke("stat")
	if code != 2 || !strings.Contains(stderr, `"status"`) {
		t.Fatal("prefix not suggested", stderr)
	}
	code, _, stderr = invoke("status", "--bogus")
	if code != 2 || !strings.Contains(stderr, "unknown flag --bogus") || !strings.Contains(stderr, "vectory help status") {
		t.Fatal("unknown flag not explained", stderr)
	}
	if code, _, stderr = invoke("help", "nothing"); code != 2 || !strings.Contains(stderr, "unknown command") {
		t.Fatal("help for an unknown command", code, stderr)
	}
	if code, _, stderr = invoke("service-stop", "--state-dir", t.TempDir()); code != 2 || !strings.Contains(stderr, "fixed Vectory service") {
		t.Fatal("service control accepted a state directory", code, stderr)
	}
}

// --state-dir names the agent's state in full: a relative path would mean
// whatever directory the command happens to run in.
func TestStateDirectoryMustBeAnAbsolutePath(t *testing.T) {
	for _, args := range [][]string{{"status", "--state-dir", "relative/state"}, {"logs", "--state-dir=./state"}} {
		code, stdout, stderr := invoke(args...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "--state-dir must be an absolute path") || !strings.Contains(stderr, "isn't") {
			t.Fatal("a relative state directory was accepted", args, code, stdout, stderr)
		}
	}
	for _, args := range [][]string{{"status", "--state-dir="}, {"doctor", "--state-dir", " "}} {
		code, _, stderr := invoke(args...)
		if code != 2 || !strings.Contains(stderr, "--state-dir needs a path") || !strings.Contains(stderr, "leave the flag out") {
			t.Fatal("an empty state directory wasn't explained", args, code, stderr)
		}
	}
	// An absolute path is used as given, even where nothing is installed.
	missing := filepath.Join(t.TempDir(), "missing")
	if code, _, stderr := invoke("status", "--state-dir", missing); code != 1 || !strings.Contains(stderr, "No agent is installed at "+missing) {
		t.Fatal(code, stderr)
	}
}

func TestRunExitsSeventyEightWhenNotReady(t *testing.T) {
	dir := t.TempDir()
	if code, _, stderr := invoke("run", "--state-dir", filepath.Join(dir, "missing")); code != 78 || !strings.Contains(stderr, "No agent is installed") {
		t.Fatal("not installed", code, stderr)
	}
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), agent.Settings{}); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := invoke("run", "--state-dir", dir); code != 78 || !strings.Contains(stderr, "isn't enrolled") {
		t.Fatal("not enrolled", code, stderr)
	}
}

func TestEnrollBeforeInstallExplainsTheOrder(t *testing.T) {
	code, _, stderr := invoke("enroll", "--state-dir", filepath.Join(t.TempDir(), "state"), "--server", "https://127.0.0.1:9", "--name", "edge", "--token-stdin")
	if code != 1 || !strings.Contains(stderr, "install the agent first") {
		t.Fatal(code, stderr)
	}
}

// The general help names every exit code main.go defines, so scripts and
// service managers can rely on what it says.
func TestGeneralHelpListsEveryExitCode(t *testing.T) {
	_, stdout, _ := invoke("help")
	for code, meaning := range map[int]string{
		exitOK:          "0 ok",
		exitFailed:      "1 failed",
		exitUsage:       "2 usage error",
		exitAttention:   "3 setup finished but nothing keeps the agent running",
		exitNotReady:    "78 not installed or not enrolled",
		exitInterrupted: "130 setup interrupted",
	} {
		if !strings.Contains(stdout, meaning) {
			t.Fatalf("general help omits exit code %d (%q):\n%s", code, meaning, stdout)
		}
	}
}
