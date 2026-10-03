package agent

import (
	"runtime"
	"testing"
)

// asAdmin is a command that needs root as a person types it on this system: with
// sudo on Linux and macOS, as it stands in an elevated PowerShell on Windows. The
// tests that compare what the agent prints with the text they expect build that
// text with it, so one test is right on every system the agent runs on.
func asAdmin(command string) string {
	if runtime.GOOS == "windows" {
		return command
	}
	return "sudo " + command
}

// A command for an administrator says sudo only where a person uses it, and names
// the state directory, quoted for the shell of the system, when it isn't the
// default one.
func TestACommandForAnAdministratorIsWrittenForTheSystemItRunsOn(t *testing.T) {
	for _, tc := range []struct{ dir, unix, windows string }{
		{"", "sudo vectory update resume", "vectory update resume"},
		{DefaultPaths().StateDir, "sudo vectory update resume", "vectory update resume"},
		{"/srv/agent", "sudo vectory update resume --state-dir /srv/agent", "vectory update resume --state-dir /srv/agent"},
		{"/srv/agent state", "sudo vectory update resume --state-dir '/srv/agent state'", "vectory update resume --state-dir '/srv/agent state'"},
		{"/srv/o'brien", `sudo vectory update resume --state-dir '/srv/o'"'"'brien'`, "vectory update resume --state-dir '/srv/o''brien'"},
	} {
		want := tc.unix
		if runtime.GOOS == "windows" {
			want = tc.windows
		}
		if got := AdminCommandFor(tc.dir, "vectory update resume"); got != want {
			t.Errorf("%q: %q, want %q", tc.dir, got, want)
		}
		if got := asAdmin(CommandFor(tc.dir, "vectory update resume")); got != want {
			t.Errorf("%q: the helper of the tests says %q, want %q", tc.dir, got, want)
		}
	}
}
