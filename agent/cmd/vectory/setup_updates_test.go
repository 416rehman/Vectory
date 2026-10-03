package main

import (
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

// Update flags that can't work on any host are a usage error, like an unknown
// flag: nothing is looked at and nothing changes.
func TestSetupUpdateFlagsThatCantWorkAreUsageErrors(t *testing.T) {
	good := strings.Repeat("ab", 32)
	for name, tc := range map[string]struct {
		args []string
		want string
	}{
		"a major track": {[]string{"--updates", "auto", "--update-key-sha256", good, "--update-track", "major"},
			"vectory setup: This release offers patch and minor tracks. Upgrade to a new major version by hand."},
		"no key":           {[]string{"--updates", "auto"}, "vectory setup: --updates auto needs --update-key-sha256"},
		"another level":    {[]string{"--updates", "sometimes", "--update-key-sha256", good}, `vectory setup: --updates takes auto, ask or off, and "sometimes" isn't one.`},
		"off with a track": {[]string{"--updates", "off", "--update-track", "patch"}, "vectory setup: --updates off turns updates off. It doesn't take --update-track."},
		"a bad window":     {[]string{"--updates", "ask", "--update-key-sha256", good, "--update-window", "Mon-Mon 02:00-04:00"}, `vectory setup: "Mon-Mon 02:00-04:00" isn't an update window`},
		// Without --updates the flags amend what a host agreed to, and what they say
		// is still checked first.
		"a major track alone":       {[]string{"--update-track", "major"}, "vectory setup: This release offers patch and minor tracks. Upgrade to a new major version by hand."},
		"a short fingerprint alone": {[]string{"--update-key-sha256", "3f9a1c0277de9b41"}, "vectory setup: --update-key-sha256 needs the 64-character SHA-256 fingerprint of a release key"},
		"a bad window alone":        {[]string{"--update-window", "Mon-Mon 02:00-04:00"}, `vectory setup: "Mon-Mon 02:00-04:00" isn't an update window`},
	} {
		t.Run(name, func(t *testing.T) {
			args := append([]string{"setup", "--server", "https://vectory.example.test:8443", "--dry-run"}, tc.args...)
			code, stdout, stderr := invoke(args...)
			if code != 2 || stdout != "" || !strings.Contains(stderr, tc.want) {
				t.Fatalf("%d %q %q, want exit 2 and %q", code, stdout, stderr, tc.want)
			}
		})
	}
}

// Flags without --updates change what the host agreed to, so a host that agreed to
// nothing is a usage error too: nothing is looked at beyond the policy, and
// nothing changes. This test reads the host's own policy, so it stands aside where
// the host has agreed to updates.
func TestSetupUpdateFlagsWithoutALevelNeedAHostThatAgreed(t *testing.T) {
	if policy, err := agent.ReadUpdatePolicy(); err != nil || policy.Consent != agent.UpdateConsentOff {
		t.Skip("this host has an update policy of its own")
	}
	good := strings.Repeat("ab", 32)
	for name, args := range map[string][]string{
		"a key alone":   {"--update-key-sha256", good},
		"a track alone": {"--update-track", "minor"},
		"a window":      {"--update-window", "Mon-Fri 02:00-04:00"},
		"all of them":   {"--update-key-sha256", good, "--update-track", "minor", "--update-window", "daily 01:00-03:00 UTC"},
	} {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := invoke(append([]string{"setup", "--server", "https://vectory.example.test:8443", "--dry-run"}, args...)...)
			want := "vectory setup: This host hasn't agreed to agent updates, so there is nothing to change. Add --updates auto or --updates ask, with --update-key-sha256.\n"
			if code != 2 || stdout != "" || stderr != want {
				t.Fatalf("%d %q %q, want exit 2 and %q", code, stdout, stderr, want)
			}
		})
	}
}

func TestSetupHelpNamesTheUpdateFlags(t *testing.T) {
	_, help, _ := invoke("help", "setup")
	// The help wraps its paragraphs, so a sentence is looked for as words.
	words := strings.Join(strings.Fields(help), " ")
	for _, want := range []string{
		"--updates LEVEL", "--update-key-sha256 HEX", "--update-track TRACK", "--update-window SPEC", "(default patch)",
		"Pinning a key trusts its holder with root on this host.",
		"Without any update flag setup leaves that choice as it is",
		"change only what they name (a new key re-pins the host) and keep the rest: the level, the other parts and a pause.",
		"On a host that agreed to nothing they are refused, with no other effect.",
		"without --updates it re-pins a host that already agreed",
		"without --updates it changes only the track of a host that already agreed",
		"without --updates it replaces only the windows of a host that already agreed",
	} {
		if !strings.Contains(words, want) {
			t.Errorf("setup help lacks %q", want)
		}
	}
}
