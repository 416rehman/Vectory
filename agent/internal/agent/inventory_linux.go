//go:build linux

package agent

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// systemctlShow asks systemd for what it knows about a unit: where it's
// defined, how it starts Vector and the environment it sets. It is a variable
// so a test doesn't need systemd; nothing else replaces it.
var systemctlShow = func(ctx context.Context, unit string) string {
	return commandOutput(ctx, 256<<10, "systemctl", "show", "--no-pager", "-p", "FragmentPath", "-p", "ExecStart", "-p", "Environment", "-p", "EnvironmentFiles", "-p", "WorkingDirectory", unit)
}

// collectStartup reads how one Vector process was started: its command line,
// working directory and environment from the process table, and, when a
// systemd unit runs it, the unit's own definition.
func collectStartup(ctx context.Context, running RunningVector) VectorStartup {
	startup := VectorStartup{PID: running.PID, Service: running.Service}
	proc := filepath.Join(procRoot, strconv.Itoa(running.PID))
	if data, err := readLimited(filepath.Join(proc, "cmdline"), 1<<20); err == nil && len(data) > 0 {
		startup.Command, startup.Source = splitNUL(data), "process"
	}
	if dir, err := os.Readlink(filepath.Join(proc, "cwd")); err == nil && !strings.HasSuffix(dir, " (deleted)") {
		startup.WorkDir = dir
	}
	if data, err := readLimited(filepath.Join(proc, "environ"), 4<<20); err == nil {
		startup.Environment, startup.EnvironmentKnown = selectedEnvironment(splitNUL(data), false), true
	}
	// A process in a mount namespace of its own (a container) names paths that
	// only exist inside it; its root is reachable through the process table.
	if mine, err := os.Readlink(filepath.Join(procRoot, "self", "ns", "mnt")); err == nil {
		if theirs, err := os.Readlink(filepath.Join(proc, "ns", "mnt")); err == nil && theirs != mine {
			startup.Root = filepath.Join(proc, "root")
		}
	}
	if running.Service != "" {
		unit := parseSystemdShow(systemctlShow(ctx, running.Service))
		startup.ServiceCommand = unit.ExecStart
		if startup.WorkDir == "" {
			startup.WorkDir = unit.WorkingDirectory
		}
		if !startup.EnvironmentKnown {
			startup.Environment, startup.EnvironmentKnown = unitEnvironment(unit)
		}
	}
	if len(startup.Command) == 0 && len(startup.ServiceCommand) > 0 {
		startup.Command, startup.Source = startup.ServiceCommand, "service"
	}
	return startup
}

// unitEnvironment is what a unit sets for its process: its Environment= lines
// and the files it reads. The second result is false when a file the unit
// requires couldn't be read, since it may set what selects configuration.
func unitEnvironment(unit systemdUnitInfo) (map[string]string, bool) {
	entries := append([]string(nil), unit.Environment...)
	known := true
	for _, file := range unit.EnvironmentFiles {
		data, err := readLimited(file.Path, 1<<20)
		switch {
		case err == nil:
			entries = append(entries, parseEnvironmentFile(string(data))...)
		case !file.Optional || !os.IsNotExist(err):
			known = false
		}
	}
	return selectedEnvironment(entries, false), known
}
