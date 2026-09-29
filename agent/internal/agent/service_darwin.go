//go:build darwin

package agent

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const serviceDefinition = "/Library/LaunchDaemons/io.vectory.agent.plist"

// ServiceName is how launchd knows the agent.
const ServiceName = "io.vectory.agent"

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// ServiceInstall registers the running executable.
func ServiceInstall(dir, account string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return ServiceInstallFor(exe, dir, account)
}

// ServiceInstallFor registers exe as the agent's launch daemon for dir.
func ServiceInstallFor(exe, dir, account string) error {
	if os.Geteuid() != 0 {
		return errors.New("registering a launchd daemon requires root; run with sudo (the daemon itself runs as the unprivileged account)")
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
	plist := `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>io.vectory.agent</string><key>UserName</key><string>` + xmlText(account) + `</string><key>ProgramArguments</key><array><string>` + xmlText(exe) + `</string><string>run</string><string>--state-dir</string><string>` + xmlText(dir) + `</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>330</integer><key>AbandonProcessGroup</key><false/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`
	if old, err := os.ReadFile(serviceDefinition); err == nil && string(old) != plist {
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
	if err = AtomicWrite(serviceDefinition, []byte(plist)); err != nil {
		return err
	}
	return os.Chmod(serviceDefinition, 0644)
}

func launchctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/launchctl", args...)
	out := &limitedWriter{max: 2048}
	cmd.Stderr = out
	if err := cmd.Run(); err != nil {
		message := "launchctl " + strings.Join(args, " ") + " failed"
		if detail := strings.TrimSpace(out.b.String()); detail != "" {
			message += ": " + safeText(detail, 200)
		}
		return errors.New(message)
	}
	return nil
}

func ServiceControl(action string) error {
	switch action {
	case "start":
		if ServiceStatus(context.Background()).Running() {
			return nil
		}
		return launchctl("bootstrap", "system", serviceDefinition)
	case "stop":
		return launchctl("bootout", "system/"+ServiceName)
	case "uninstall":
		if ServiceStatus(context.Background()).Installed {
			_ = launchctl("bootout", "system/"+ServiceName)
		}
		if err := os.Remove(serviceDefinition); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return errors.New("invalid service operation")
}

// ServiceStatus asks launchd about the agent daemon without changing it.
func ServiceStatus(ctx context.Context) ServiceInfo {
	info := ServiceInfo{Manager: "launchd", Name: ServiceName}
	if _, err := os.Stat(serviceDefinition); err != nil {
		return info
	}
	info.Installed = true
	info.State = "stopped"
	out := commandOutput(ctx, 65536, "/bin/launchctl", "print", "system/"+ServiceName)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if value, ok := strings.CutPrefix(line, "state = "); ok {
			info.State = value
		} else if value, ok := strings.CutPrefix(line, "pid = "); ok {
			info.PID, _ = strconv.Atoi(value)
		}
	}
	info.Enabled = out != ""
	return info
}
