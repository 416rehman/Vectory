//go:build windows

package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The Windows tests of the step need programs to run: an executable that is
// running (whose file can be renamed but not replaced), a build that answers
// `version --json`, one that never answers, one that prints too much, one that
// fails, and a service the Service Control Manager can start. Each is a copy of the
// test binary under a name that says what it does. The copy decides from its own name
// and its arguments alone, because the step starts a build with a clean environment.
func init() {
	switch strings.ToLower(filepath.Base(os.Args[0])) {
	case "vectory.exe":
		switch {
		case len(os.Args) == 3 && os.Args[1] == "version" && os.Args[2] == "--json":
			fmt.Printf(`{"version":"0.1.0","vector_version":"0.58.0","go":"go1.26","os":"windows","arch":%q}`+"\n", runtime.GOARCH)
			os.Exit(0)
		case len(os.Args) == 1:
			time.Sleep(time.Hour)
			os.Exit(0)
		}
	case "probe-hangs.exe":
		time.Sleep(time.Hour)
		os.Exit(0)
	case "probe-noisy.exe":
		fmt.Print(strings.Repeat("x", 8192))
		os.Exit(0)
	case "probe-fails.exe":
		os.Exit(3)
	case "step-service.exe":
		// The step's service as the Service Control Manager starts it:
		// step-service.exe update-helper --state-dir <directory>. It is kept away from
		// the host's own directories (the paths are under the directory it is told) and
		// has no host, so that every run of the step says it is unavailable and the
		// service stays up until it is stopped.
		if len(os.Args) == 4 && os.Args[1] == "update-helper" && os.Args[2] == "--state-dir" {
			paths := newUpdatePaths(filepath.Join(os.Args[3], "policy"), filepath.Join(os.Args[3], "step"), true)
			updateLocationsOverride = &paths
			updateHostOverride = noUpdateHost{}
			if err := RunUpdateHelperCommand(context.Background(), os.Args[3]); err != nil {
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
}

// copyTestBinary puts a copy of the test binary at path.
func copyTestBinary(t *testing.T, path string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// startRunning runs the copy of the test binary at path (a vectory.exe) as a program
// that stays running, and ends it when the test does. Its executable is mapped as
// soon as the process exists, so there is nothing to wait for.
func startRunning(t *testing.T, path string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(path)
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting %s: %v", path, err)
	}
	t.Cleanup(func() { stopRunning(cmd) })
	return cmd
}

// stopRunning ends a program startRunning started, and waits until its executable is
// let go of.
func stopRunning(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}
}
