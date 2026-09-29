//go:build darwin

package agent

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
)

func platformDetails(ctx context.Context) (string, string) {
	version := commandLine(ctx, "/usr/bin/sw_vers", "-productVersion")
	if version != "" {
		version = "macOS " + safeText(version, 20)
	}
	return version, "launchd"
}

// SystemdAvailable is false on macOS.
func SystemdAvailable() bool { return false }

// DetectRunningVector lists running Vector processes that no Vectory agent
// supervises. The second result is false when processes couldn't be listed.
func DetectRunningVector(ctx context.Context) ([]RunningVector, bool) {
	out := commandOutput(ctx, 1<<20, "/bin/ps", "-axo", "pid=,ppid=,comm=")
	if out == "" {
		return nil, false
	}
	var found []RunningVector
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		command := strings.Join(fields[2:], " ")
		if filepath.Base(command) != "vector" {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		parent := commandOutput(ctx, 65536, "/bin/ps", "-o", "command=", "-p", fields[1])
		if strings.Contains(parent, "__vector-host") {
			continue
		}
		if args := strings.Fields(commandOutput(ctx, 65536, "/bin/ps", "-o", "args=", "-p", fields[0])); len(args) > 0 && !runsPipeline(args[1:]) {
			continue
		}
		running := RunningVector{PID: pid}
		if filepath.IsAbs(command) {
			running.Binary = command
		}
		found = append(found, running)
	}
	return found, true
}
