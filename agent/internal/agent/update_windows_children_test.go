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
	"unsafe"

	"golang.org/x/sys/windows"
)

// stagedBuildName is the name the step gives a build it stages and probes: a dot and
// no extension, as on every system (the contract names it, and Windows runs the file
// it is given whatever it is called).
const stagedBuildName = ".vectory-update-7"

// The Windows tests of the step need programs to run: an executable that is
// running (whose file can be renamed but not replaced), a build that answers
// `version --json`, one that never answers, one that prints too much, one that
// fails, and a service the Service Control Manager can start. Each is a copy of the
// test binary under a name that says what it does. The copy decides from its own name
// and its arguments alone, because the step starts a build with a clean environment.
//
// TestMain calls this before anything else, and not an init function: the Service
// Control Manager calls back into the program on a thread of its own, and the runtime
// lets such a call run only after the program's initialization has ended, which it
// never would if the service ran from an init function.
func runAsChildProgram() {
	switch strings.ToLower(filepath.Base(os.Args[0])) {
	case "vectory.exe", stagedBuildName:
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
	case "probe-lingers.exe":
		time.Sleep(time.Hour)
		os.Exit(0)
	case "probe-spawns.exe", "probe-leaves.exe", "probe-fans-out.exe":
		runAsProbeThatStartsPrograms(strings.ToLower(filepath.Base(os.Args[0])))
	case "probe-reports-its-job.exe":
		// What the job this program is in says about itself, asked as the first thing it
		// does: a build that ran before it was put in its job would find none, or another.
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		report := ""
		if err := windows.QueryInformationJobObject(0, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
			report = err.Error()
		}
		fmt.Printf(`{"version":"0.1.0","vector_version":"0.58.0","go":"go1.26","os":"windows","arch":%q,"job_error":%q,"job_flags":%d,"job_active":%d}`+"\n",
			runtime.GOARCH, report, info.BasicLimitInformation.LimitFlags, info.BasicLimitInformation.ActiveProcessLimit)
		os.Exit(0)
	case "step-service.exe":
		// The step's service as the Service Control Manager starts it:
		// step-service.exe update-helper --state-dir <directory>. It is kept away from
		// the host's own directories (the paths are under the directory it is told) and
		// has no host (the gate is closed in it), so that every run of the step says it is
		// unavailable and the service stays up until it is stopped.
		if len(os.Args) == 4 && os.Args[1] == "update-helper" && os.Args[2] == "--state-dir" {
			paths := newUpdatePaths(filepath.Join(os.Args[3], "policy"), filepath.Join(os.Args[3], "step"), true)
			updateLocationsOverride = &paths
			updateGateOverride = func(string) bool { return false }
			if err := RunUpdateHelperCommand(context.Background(), os.Args[3]); err != nil {
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
}

// childrenFile is the file beside a program that starts others, where it writes the
// process id of each one it started, a line each; fannedOutFile appears when the
// program that starts more than a job allows has tried them all.
const (
	childrenFile  = "children.pid"
	fannedOutFile = "fanned-out"
)

// runAsProbeThatStartsPrograms is a build that starts programs of its own, which stay
// running (probe-lingers.exe, a copy of this binary that sits beside it). What each does
// afterwards is what its name says: probe-spawns.exe stays running, so that the probe's
// time runs out with its child alive; probe-leaves.exe prints what a good build prints
// and ends, leaving its child behind; probe-fans-out.exe starts more programs than a
// probe's job allows, and stays running.
func runAsProbeThatStartsPrograms(name string) {
	here := filepath.Dir(os.Args[0])
	start := func() {
		cmd := exec.Command(filepath.Join(here, "probe-lingers.exe"))
		if err := cmd.Start(); err != nil {
			return
		}
		if f, err := os.OpenFile(filepath.Join(here, childrenFile), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			fmt.Fprintln(f, cmd.Process.Pid)
			f.Close()
		}
	}
	switch name {
	case "probe-fans-out.exe":
		for i := 0; i < probeActiveProcesses+4; i++ {
			start()
		}
		_ = os.WriteFile(filepath.Join(here, fannedOutFile), nil, 0o644)
		time.Sleep(time.Hour)
	case "probe-leaves.exe":
		start()
		fmt.Printf(`{"version":"0.1.0","vector_version":"0.58.0","go":"go1.26","os":"windows","arch":%q}`+"\n", runtime.GOARCH)
	default:
		start()
		time.Sleep(time.Hour)
	}
	os.Exit(0)
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
