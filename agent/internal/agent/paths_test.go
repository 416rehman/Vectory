package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDefaultPathsKeepStateManagedConfigAndServerApart(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		p := defaultPathsFor(goos, "", "")
		separator := "/"
		if goos == "windows" {
			separator = `\`
		}
		managedDir := p.ManagedConfig[:strings.LastIndex(p.ManagedConfig, separator)]
		if p.StateDir == "" || managedDir == p.StateDir || strings.HasPrefix(managedDir, p.StateDir+separator) || strings.HasPrefix(p.StateDir, managedDir+separator) {
			t.Fatalf("%s: purge of %q could touch the managed workload %q", goos, p.StateDir, p.ManagedConfig)
		}
		if !strings.HasSuffix(p.ManagedConfig, "vector.json") || p.Binary == "" || p.ServiceUser == "" {
			t.Fatalf("%s: incomplete defaults %+v", goos, p)
		}
		for _, legacy := range legacyStateDirs(goos, "") {
			if legacy == p.StateDir {
				t.Fatalf("%s: default reuses a legacy location", goos)
			}
		}
	}
	if defaultPathsFor("linux", "", "").StateDir == "/var/lib/vectory" {
		t.Fatal("agent state would collide with the server's data directory")
	}
	if got := defaultPathsFor("windows", `D:\Data`, `E:\Apps`); got.StateDir != `D:\Data\Vectory\agent` || got.Binary != `E:\Apps\Vectory\vectory.exe` {
		t.Fatalf("Windows defaults ignore ProgramData/ProgramFiles: %+v", got)
	}
}

// ProgramData lets any account make %ProgramData%\Vectory, so a settings.json in it
// proves nothing about an installation: setup adopts no earlier layout there.
func TestWindowsHasNoEarlierDefaultToAdopt(t *testing.T) {
	if got := legacyStateDirs("windows", ""); len(got) != 0 {
		t.Errorf("Windows has earlier defaults: %v", got)
	}
	for _, goos := range []string{"linux", "darwin"} {
		if len(legacyStateDirs(goos, "")) == 0 {
			t.Errorf("%s lost its earlier default", goos)
		}
	}
}

func TestResolveOperatorPathCanonicalizesTrustedLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows keeps refusing reparse points instead of resolving them")
	}
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, "state"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveOperatorPath(filepath.Join(root, "alias", "state", "missing", "child"))
	if err != nil || got.Path != filepath.Join(real, "state", "missing", "child") || !got.Resolved {
		t.Fatalf("link or missing suffix mishandled: %+v %v", got, err)
	}
	if err := SafePath(got.Path); err != nil {
		t.Fatalf("resolved path still fails strict checks: %v", err)
	}
	// Relative targets resolve against the link's directory.
	if err := os.Symlink("real/state", filepath.Join(root, "relative")); err != nil {
		t.Fatal(err)
	}
	if got, err = ResolveOperatorPath(filepath.Join(root, "relative")); err != nil || got.Path != filepath.Join(real, "state") {
		t.Fatalf("relative link: %+v %v", got, err)
	}
	// Relative operator input becomes absolute without claiming a link.
	wd, _ := os.Getwd()
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	if got, err = ResolveOperatorPath("real/state"); err != nil || got.Path != filepath.Join(real, "state") || got.Resolved {
		t.Fatalf("relative input: %+v %v", got, err)
	}
	loop := filepath.Join(root, "loop")
	if err := os.Symlink(loop, loop); err != nil {
		t.Fatal(err)
	}
	if _, err = ResolveOperatorPath(filepath.Join(loop, "x")); err == nil || !strings.Contains(err.Error(), "symbolic links") {
		t.Fatalf("link loop accepted: %v", err)
	}
	if _, err = ResolveOperatorPath(" "); err == nil {
		t.Fatal("empty path accepted")
	}
}
