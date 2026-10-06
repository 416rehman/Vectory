package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The staging directory is the agent's own and private. A directory that was
// left with loose permissions is made private before anything is staged in it;
// a symbolic link, or a file, where the directory should be is refused: the
// check says it couldn't run, and nothing is written through the link.
func TestTheStagingDirectoryIsPrivateAndNeverALink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses Unix permission bits and links")
	}
	t.Run("loose permissions are tightened", func(t *testing.T) {
		d := newCheckDevice(t)
		d.poll()
		staging := filepath.Join(d.state, validationStagingName)
		if err := os.Mkdir(staging, 0755); err != nil {
			t.Fatal(err)
		}
		d.ask(newConfig, checkID, false)
		d.poll()
		checks := d.driver.checks()
		if len(checks) != 1 || checks[0].DirMode != 0700 || checks[0].FileMode != 0600 {
			t.Fatalf("checks %+v", checks)
		}
	})
	t.Run("a link in its place is refused", func(t *testing.T) {
		d := newCheckDevice(t)
		d.poll()
		elsewhere := filepath.Join(d.root, "elsewhere")
		if err := os.Mkdir(elsewhere, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(elsewhere, filepath.Join(d.state, validationStagingName)); err != nil {
			t.Skip(err)
		}
		res := d.checked(newConfig, false)
		diagnostics := diagnosticsOf(t, res)
		if res["valid"] != false || len(diagnostics) != 1 || diagnostics[0]["code"] != "CHECK_UNAVAILABLE" {
			t.Fatalf("result %v", res)
		}
		if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
			t.Fatalf("something was written through the link: %v", entries)
		}
		if len(d.driver.checks()) != 0 {
			t.Fatal("a candidate was checked through a link")
		}
	})
	t.Run("a file in its place is refused", func(t *testing.T) {
		d := newCheckDevice(t)
		d.poll()
		if err := os.WriteFile(filepath.Join(d.state, validationStagingName), []byte("not a directory"), 0600); err != nil {
			t.Fatal(err)
		}
		res := d.checked(newConfig, false)
		if diagnostics := diagnosticsOf(t, res); res["valid"] != false || len(diagnostics) != 1 || diagnostics[0]["code"] != "CHECK_UNAVAILABLE" {
			t.Fatalf("result %v", res)
		}
	})
	t.Run("the answered ids are never written through a link", func(t *testing.T) {
		d := newCheckDevice(t)
		d.poll()
		elsewhere := filepath.Join(d.root, "elsewhere.json")
		if err := os.Symlink(elsewhere, filepath.Join(d.state, validationAnsweredName)); err != nil {
			t.Skip(err)
		}
		d.ask(newConfig, checkID, false)
		d.poll()
		d.forget()
		d.poll()
		d.poll()
		if _, err := os.Stat(elsewhere); !os.IsNotExist(err) {
			t.Fatalf("the memory of answered checks was written through a link: %v", err)
		}
		if res := result(d.plane.last()); res != nil {
			t.Fatal("the result is still sent")
		}
	})
}
