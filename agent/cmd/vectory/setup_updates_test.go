package main

import (
	"strings"
	"testing"
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
		"a key alone":      {[]string{"--update-key-sha256", good}, "vectory setup: --update-key-sha256 go with --updates auto or --updates ask."},
		"off with a track": {[]string{"--updates", "off", "--update-track", "patch"}, "vectory setup: --updates off turns updates off. It doesn't take --update-track."},
		"a bad window":     {[]string{"--updates", "ask", "--update-key-sha256", good, "--update-window", "Mon-Mon 02:00-04:00"}, `vectory setup: "Mon-Mon 02:00-04:00" isn't an update window`},
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

func TestSetupHelpNamesTheUpdateFlags(t *testing.T) {
	_, help, _ := invoke("help", "setup")
	for _, want := range []string{"--updates LEVEL", "--update-key-sha256 HEX", "--update-track TRACK", "--update-window SPEC", "(default patch)", "Pinning a key trusts its holder with root on this host."} {
		if !strings.Contains(help, want) {
			t.Errorf("setup help lacks %q", want)
		}
	}
}
