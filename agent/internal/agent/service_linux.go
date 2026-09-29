//go:build linux

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const serviceDefinition = "/etc/systemd/system/vectory.service"

// ServiceName is how the service manager knows the agent.
const ServiceName = "vectory.service"

func unitArg(s string) string {
	return strconv.Quote(strings.ReplaceAll(strings.ReplaceAll(s, "%", "%%"), "$", "$$"))
}

// ServiceInstall registers the running executable.
func ServiceInstall(dir, account string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return ServiceInstallFor(exe, dir, account)
}

// systemdUnit is the generated definition; packaging/systemd/vectory.service
// is the same unit for OS packages. Exit status 78 (not installed or not
// enrolled) stops restart loops. ProtectSystem=full and ProtectHome=read-only
// keep /usr, /boot, /etc and home directories read-only except the state and
// managed configuration directories, while Vector's own data and output
// directories elsewhere stay writable.
func systemdUnitFile(exe, dir, managedDir, account, group string) string {
	return "[Unit]\nDescription=Vectory outbound configuration agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=" + account + "\nGroup=" + group + "\nExecStart=" + unitArg(exe) + " run --state-dir " + unitArg(dir) + "\nRestart=on-failure\nRestartSec=5s\nRestartPreventExitStatus=78\nKillMode=control-group\nTimeoutStopSec=20s\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\nProtectHome=read-only\nReadWritePaths=" + unitArg("-"+dir) + " " + unitArg("-"+managedDir) + "\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n"
}

// ServiceInstallFor registers exe as the agent service for dir, owned by account.
func ServiceInstallFor(exe, dir, account string) error {
	if os.Geteuid() != 0 {
		return errors.New("registering a systemd service requires root; run with sudo (the service itself runs as the unprivileged account)")
	}
	if err := CheckServiceAccountName(account); err != nil {
		return err
	}
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return err
	}
	defer releaseLifecycle()
	if err := checkNoPendingPurge(dir); err != nil {
		return err
	}
	u, err := user.Lookup(account)
	if err != nil {
		return errors.New("account " + account + " doesn't exist; create it (vectory setup --create-user does) or pass --service-user")
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return err
	}
	s, err := LoadSettings(dir)
	if err != nil {
		return err
	}
	if err = CheckManagedDirectory(s.ManagedConfig, dir); err != nil {
		return err
	}
	if _, err = exec.LookPath("systemctl"); err != nil {
		return errors.New("systemd isn't available here; run `vectory run` under your existing supervisor")
	}
	unit := systemdUnitFile(exe, dir, filepath.Dir(s.ManagedConfig), account, u.Gid)
	if old, err := os.ReadFile(serviceDefinition); err == nil && string(old) != unit {
		return errors.New(serviceDefinition + " already exists with different settings; review it, then remove it with `vectory service-uninstall` before registering again")
	}
	for _, root := range []string{dir} {
		if err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := SafePath(path); err != nil {
				return err
			}
			return os.Chown(path, uid, gid)
		}); err != nil {
			return err
		}
	}
	if err = os.Chown(filepath.Dir(s.ManagedConfig), uid, gid); err != nil {
		return err
	}
	if err = os.Chown(s.ManagedConfig, uid, gid); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err = AtomicWrite(serviceDefinition, []byte(unit)); err != nil {
		return err
	}
	if err = os.Chmod(serviceDefinition, 0644); err != nil {
		return err
	}
	return systemctl("daemon-reload")
}

func systemctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	out := &limitedWriter{max: 2048}
	cmd.Stdout = nil
	cmd.Stderr = out
	if err := cmd.Run(); err != nil {
		detail := lastLine(out.b.String())
		message := "systemctl " + strings.Join(args, " ") + " failed"
		if detail != "" {
			message += ": " + safeText(detail, 200)
		}
		return errors.New(message + ". See: journalctl -u " + ServiceName + " -n 50")
	}
	return nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func ServiceControl(action string) error {
	switch action {
	case "start":
		return systemctl("enable", "--now", ServiceName)
	case "stop":
		return systemctl("stop", ServiceName)
	case "uninstall":
		if err := systemctl("disable", "--now", ServiceName); err != nil {
			return err
		}
		if err := os.Remove(serviceDefinition); err != nil && !os.IsNotExist(err) {
			return err
		}
		return systemctl("daemon-reload")
	}
	return errors.New("invalid service operation")
}

// ServiceStatus asks systemd about the agent service without changing it.
func ServiceStatus(ctx context.Context) ServiceInfo {
	info := ServiceInfo{Manager: "systemd", Name: ServiceName}
	if !SystemdAvailable() {
		info.Manager = ""
		return info
	}
	out := commandOutput(ctx, 8192, "systemctl", "show", ServiceName, "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState,ExecStart")
	values := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			values[key] = value
		}
	}
	info.Installed = values["LoadState"] == "loaded"
	if !info.Installed {
		return info
	}
	info.State = values["SubState"]
	if values["ActiveState"] == "failed" {
		info.State = "failed"
	}
	info.PID, _ = strconv.Atoi(values["MainPID"])
	info.Enabled = values["UnitFileState"] == "enabled"
	if _, rest, ok := strings.Cut(values["ExecStart"], "--state-dir "); ok {
		if fields := strings.Fields(rest); len(fields) > 0 {
			info.StateDir = strings.Trim(fields[0], `"`)
		}
	}
	return info
}
