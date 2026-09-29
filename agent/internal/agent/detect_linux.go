//go:build linux

package agent

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func platformDetails(ctx context.Context) (string, string) {
	distribution := readOSRelease("/etc/os-release")
	if distribution == "" {
		distribution = readOSRelease("/usr/lib/os-release")
	}
	manager := ""
	if SystemdAvailable() {
		manager = "systemd"
		if fields := strings.Fields(commandLine(ctx, "systemctl", "--version")); len(fields) >= 2 && fields[0] == "systemd" {
			manager = "systemd " + fields[1]
		}
	}
	return distribution, manager
}

// SystemdAvailable reports whether systemd is the running service manager.
func SystemdAvailable() bool {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return false
	}
	_, err := exec.LookPath("systemctl")
	return err == nil
}

// DetectRunningVector lists running Vector processes that no Vectory agent
// supervises. The second result is false when processes couldn't be listed.
func DetectRunningVector(ctx context.Context) ([]RunningVector, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, false
	}
	var found []RunningVector
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		proc := filepath.Join("/proc", entry.Name())
		comm, err := os.ReadFile(filepath.Join(proc, "comm"))
		if err != nil || strings.TrimSpace(string(comm)) != "vector" || supervisedByAgent(proc) {
			continue
		}
		if cmdline, err := os.ReadFile(filepath.Join(proc, "cmdline")); err == nil {
			if args := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00"); len(args) > 0 && !runsPipeline(args[1:]) {
				continue
			}
		}
		running := RunningVector{PID: pid}
		if exe, err := os.Readlink(filepath.Join(proc, "exe")); err == nil {
			running.Binary = strings.TrimSuffix(exe, " (deleted)")
		}
		running.Service = systemdUnit(proc)
		found = append(found, running)
	}
	return found, true
}

// A Vector child of `vectory __vector-host` is already managed by an agent.
func supervisedByAgent(proc string) bool {
	stat, err := os.ReadFile(filepath.Join(proc, "stat"))
	if err != nil {
		return false
	}
	end := bytes.LastIndexByte(stat, ')')
	if end < 0 {
		return false
	}
	fields := strings.Fields(string(stat[end+1:]))
	if len(fields) < 2 {
		return false
	}
	cmdline, err := os.ReadFile(filepath.Join("/proc", fields[1], "cmdline"))
	return err == nil && bytes.Contains(cmdline, []byte("__vector-host"))
}

func systemdUnit(proc string) string {
	cgroup, err := os.ReadFile(filepath.Join(proc, "cgroup"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(cgroup), "\n") {
		_, path, _ := strings.Cut(line, "::")
		if path == "" {
			if parts := strings.SplitN(line, ":", 3); len(parts) == 3 {
				path = parts[2]
			}
		}
		for _, segment := range strings.Split(path, "/") {
			if strings.HasSuffix(segment, ".service") && !strings.HasPrefix(segment, "user@") {
				return segment
			}
		}
	}
	return ""
}
