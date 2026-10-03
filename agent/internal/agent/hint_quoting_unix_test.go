//go:build !windows

package agent

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The quoted word reaches a real shell as one argument and runs nothing else.
func TestAQuotedFixRunsNothingButItsOwnCommand(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	for _, entry := range []string{
		"/srv/a;touch " + marker,
		"/srv/a&&touch " + marker,
		"/srv/a|touch " + marker,
		"/srv/a>" + marker,
		"/srv/a\ntouch " + marker,
		"/srv/$(touch " + marker + ")",
		"/srv/`touch " + marker + "`",
	} {
		out, err := exec.Command("sh", "-c", "printf '%s' "+ShellQuote(entry)).Output()
		if err != nil || string(out) != entry {
			t.Errorf("%q came back as %q (%v)", entry, out, err)
		}
		if _, err := os.Stat(marker); err == nil {
			t.Fatalf("%q ran a command", entry)
		}
	}
}
