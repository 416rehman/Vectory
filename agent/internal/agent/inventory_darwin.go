//go:build darwin

package agent

import (
	"bytes"
	"context"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// collectStartup reads how one Vector process was started: its arguments and
// environment from the kernel (kern.procargs2, which the account that runs the
// process and root may read), its working directory from lsof, and the launchd
// job that starts it.
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
		// Without permission for the process's own record, ps still shows its
		// arguments, though unquoted.
		if fields := strings.Fields(commandOutput(ctx, 65536, "/bin/ps", "-ww", "-o", "args=", "-p", pid)); len(fields) > 0 {
			startup.Command, startup.Source = fields, "process"
		}
	}
	for _, line := range strings.Split(commandOutput(ctx, 65536, "/usr/sbin/lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"), "\n") {
		if dir, ok := strings.CutPrefix(line, "n"); ok && filepath.IsAbs(dir) {
			startup.WorkDir = dir
			break
		}
	}
	if job, ok := plistJobFor(ctx, commandLine(ctx, "/bin/ps", "-o", "uid=", "-p", pid), startup.Command, execPath); ok {
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

// plistJobFor finds the launchd job whose property list starts this process:
// the one with the process's arguments, or else its executable. Jobs live in
// the system folders and in the LaunchAgents of the account that runs it.
func plistJobFor(ctx context.Context, uid string, command []string, execPath string) (plistJob, bool) {
	directories := []string{"/Library/LaunchDaemons", "/Library/LaunchAgents"}
	if account, err := user.LookupId(strings.TrimSpace(uid)); err == nil && account.HomeDir != "" {
		directories = append(directories, filepath.Join(account.HomeDir, "Library", "LaunchAgents"))
	}
	var byExecutable *plistJob
	for _, directory := range directories {
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
