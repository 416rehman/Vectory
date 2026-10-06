package agent

import (
	"strings"
	"testing"
)

// A fix the agent prints is a command an operator copies and runs as root, and
// the entry in it comes from a published pipeline: whatever the pipeline put
// in a path, an address or a host is one argument of the command, never a
// second command.
func TestAFixNeverLetsAPipelineValueEndTheCommand(t *testing.T) {
	for _, entry := range []string{
		"/var/log/app;reboot",
		"/var/log/app && poweroff",
		"/srv/a|b",
		"/srv/a>/etc/cron.d/x",
		"/srv/a<b",
		"/srv/*",
		"/srv/#x",
		"/srv/a\nreboot",
		"/srv/$(id)",
		"/srv/it's",
		"127.0.0.1:80;reboot",
	} {
		for _, allowance := range []string{"allowed_file_roots", "allowed_network_hosts", "allowed_listen_addresses"} {
			refusal := &PolicyRefusal{Code: "FILE_PATH_DENIED", Allowance: allowance, Resource: entry, Suggested: entry, StateDir: "/var/lib/vectory-agent"}
			hint := refusal.Diagnostic().Hint
			quoted := ShellQuote(entry)
			if !strings.Contains(hint, quoted) {
				t.Errorf("%s %q: the hint %q doesn't carry %s", allowance, entry, hint, quoted)
			}
			if !strings.HasPrefix(quoted, "'") || !strings.HasSuffix(quoted, "'") {
				t.Errorf("%q isn't one quoted word: %s", entry, quoted)
			}
		}
	}
}

func TestShellQuoteLeavesOnlyOrdinaryWordsBare(t *testing.T) {
	for in, want := range map[string]string{
		"/var/log/app":   "/var/log/app",
		"127.0.0.1:8688": "127.0.0.1:8688",
		"a-b_c.d+e":      "a-b_c.d+e",
	} {
		if got := ShellQuote(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	for _, in := range []string{"/a;b", "/a&b", "/a|b", "/a>b", "/a<b", "/a*b", "/a?b", "/a[b", "/a#b", "/a~b", "/a!b", "/a(b", "/a b", "/a\tb", "/a\nb", "/a'b", `/a"b`, "/a$b", "/a`b", `/a\b`, "/a=b", "/a,b", "/a%b", "/a@b", "/a{b", "/a^b"} {
		if got := ShellQuote(in); !strings.HasPrefix(got, "'") {
			t.Errorf("%q was left bare: %s", in, got)
		}
	}
}
