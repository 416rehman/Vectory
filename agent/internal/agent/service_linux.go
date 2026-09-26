//go:build linux

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const serviceDefinition = "/etc/systemd/system/vectory.service"

func unitArg(s string) string {
	return strconv.Quote(strings.ReplaceAll(strings.ReplaceAll(s, "%", "%%"), "$", "$$"))
}
func ServiceInstall(dir, account string) error {
	if os.Geteuid() != 0 {
		return errors.New("systemd registration requires root; steady-state uses the named unprivileged account")
	}
	if !regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`).MatchString(account) || account == "root" {
		return errors.New("--service-user must name an existing unprivileged account")
	}
	u, err := user.Lookup(account)
	if err != nil {
		return err
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
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if _, err = exec.LookPath("systemctl"); err != nil {
		return errors.New("systemd is unavailable; use run under your existing supervisor")
	}
	unit := "[Unit]\nDescription=Vectory outbound configuration agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=" + account + "\nGroup=" + u.Gid + "\nExecStart=" + unitArg(exe) + " run --state-dir " + unitArg(dir) + "\nRestart=on-failure\nRestartSec=5s\nKillMode=control-group\nTimeoutStopSec=20s\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n"
	if old, err := os.ReadFile(serviceDefinition); err == nil && string(old) != unit {
		return errors.New("existing systemd definition differs; inspect and remove it explicitly before replacement")
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
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return errors.New("systemctl operation failed; inspect local service manager diagnostics")
	}
	return nil
}
func ServiceControl(action string) error {
	switch action {
	case "start":
		return systemctl("enable", "--now", "vectory.service")
	case "stop":
		return systemctl("stop", "vectory.service")
	case "uninstall":
		if err := systemctl("disable", "--now", "vectory.service"); err != nil {
			return err
		}
		if err := os.Remove(serviceDefinition); err != nil && !os.IsNotExist(err) {
			return err
		}
		return systemctl("daemon-reload")
	}
	return errors.New("invalid service operation")
}
