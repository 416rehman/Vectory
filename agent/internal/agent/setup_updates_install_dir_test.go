package agent

import (
	"path/filepath"
	"strings"
	"testing"
)

// What setup says to do about an install directory that others can write: install in
// a directory only root can write, such as where the agent usually goes. When the
// usual place is the one that was refused (Homebrew on an Intel Mac takes
// /usr/local/bin), pointing at it again would send a person round in a circle.
func TestTheFixForAnInstallDirectoryOthersCanWriteDoesNotPointBackAtTheDirectoryThatWasRefused(t *testing.T) {
	usual := DefaultPaths().Binary
	elsewhere := filepath.Join(filepath.Dir(filepath.Dir(usual)), "opt-vectory", "vectory")

	got := installDirectoryFix(elsewhere)
	if !strings.Contains(got, "such as "+usual) || strings.Contains(got, "--install-dir") {
		t.Errorf("an agent installed elsewhere: %q", got)
	}

	got = installDirectoryFix(usual)
	if strings.Contains(got, "such as") || strings.Contains(got, usual) || !strings.Contains(got, "another directory only "+updateRootWord()+" can write") ||
		!strings.Contains(got, "--install-dir") || !strings.HasSuffix(got, "Or leave out --updates.") {
		t.Errorf("an agent in the usual place: %q", got)
	}
}
