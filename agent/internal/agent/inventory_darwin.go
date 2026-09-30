//go:build darwin

package agent

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// collectStartup reads how one Vector process was started: its arguments and
// environment from the kernel (kern.procargs2, which the account that runs the
// process and root may read), its working directory from lsof, and the launchd
// job that starts it. Where the kernel's record can't be read, ps still shows
// the arguments, though without their quoting.
func collectStartup(ctx context.Context, running RunningVector) VectorStartup {
	startup := VectorStartup{PID: running.PID, Service: running.Service}
	pid := strconv.Itoa(running.PID)
	execPath := ""
	if data, err := unix.SysctlRaw("kern.procargs2", running.PID); err == nil {
		if path, args, environment, err := parseProcArgs2(data); err == nil && len(args) > 0 {
			execPath, startup.Command, startup.Source = path, args, "process"
			startup.Environment, startup.EnvironmentKnown = selectedEnvironment(environment, false), true
		}
	}
	if len(startup.Command) == 0 {
		if fields := strings.Fields(commandOutput(ctx, 65536, "/bin/ps", "-ww", "-o", "args=", "-p", pid)); len(fields) > 0 {
			startup.Command, startup.Source = fields, "process"
			// ps shows the environment of the account's own processes, and of every
			// process to root. For any other it shows none, which says nothing.
			if uid, err := strconv.Atoi(commandLine(ctx, "/bin/ps", "-o", "uid=", "-p", pid)); err == nil && (os.Geteuid() == 0 || uid == os.Geteuid()) {
				startup.Environment, startup.EnvironmentKnown = environmentFromPS(commandOutput(ctx, 1<<20, "/bin/ps", "eww", "-o", "command=", "-p", pid), fields)
			}
		}
	}
	for _, line := range strings.Split(commandOutput(ctx, 65536, "/usr/sbin/lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"), "\n") {
		if dir, ok := strings.CutPrefix(line, "n"); ok && filepath.IsAbs(dir) {
			startup.WorkDir = dir
			break
		}
	}
	if job, ok := plistJobFor(ctx, startup.Command, execPath); ok {
		startup.Service, startup.ServiceCommand = job.Label, job.Command()
		if startup.WorkDir == "" {
			startup.WorkDir = job.WorkingDirectory
		}
		if !startup.EnvironmentKnown {
			var entries []string
			for name, value := range job.EnvironmentVariables {
				entries = append(entries, name+"="+value)
			}
			startup.Environment, startup.EnvironmentKnown = selectedEnvironment(entries, false), true
		}
	}
	if len(startup.Command) == 0 && len(startup.ServiceCommand) > 0 {
		startup.Command, startup.Source = startup.ServiceCommand, "service"
	}
	return startup
}

// launchdDirectories are the folders launchd jobs are defined in: the system's,
// and the LaunchAgents of every account setup may read (all of them as root,
// its own otherwise).
func launchdDirectories() []string {
	directories := []string{"/Library/LaunchDaemons", "/Library/LaunchAgents"}
	users, _ := filepath.Glob("/Users/*/Library/LaunchAgents")
	return append(directories, users...)
}

// plistJobFor finds the launchd job whose property list starts this process:
// the one with the process's arguments, or else its executable.
func plistJobFor(ctx context.Context, command []string, execPath string) (plistJob, bool) {
	var byExecutable *plistJob
	for _, directory := range launchdDirectories() {
		paths, _ := filepath.Glob(filepath.Join(directory, "*.plist"))
		for _, path := range paths {
			job, ok := readPlistJob(ctx, path)
			if !ok || len(job.Command()) == 0 {
				continue
			}
			switch {
			case len(command) > 0 && slices.Equal(job.Command(), command):
				return job, true
			case byExecutable == nil && execPath != "" && job.Command()[0] == execPath:
				found := job
				byExecutable = &found
			}
		}
	}
	if byExecutable != nil {
		return *byExecutable, true
	}
	return plistJob{}, false
}

// readPlistJob reads a property list that mentions Vector, converting a
// binary one with plutil.
func readPlistJob(ctx context.Context, path string) (plistJob, bool) {
	data, err := readLimited(path, 256<<10)
	if err != nil || !bytes.Contains(bytes.ToLower(data), []byte("vector")) {
		return plistJob{}, false
	}
	if bytes.HasPrefix(data, []byte("bplist")) {
		converted := commandOutput(ctx, 256<<10, "/usr/bin/plutil", "-convert", "xml1", "-o", "-", path)
		if converted == "" {
			return plistJob{}, false
		}
		data = []byte(converted)
	}
	job, err := parsePlist(data)
	return job, err == nil
}
