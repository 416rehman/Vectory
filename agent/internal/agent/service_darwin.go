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
	"regexp"
	"strconv"
	"time"
)

const serviceDefinition = "/Library/LaunchDaemons/io.vectory.agent.plist"

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func ServiceInstall(dir, account string) error {
	if os.Geteuid() != 0 {
		return errors.New("launchd registration requires root")
	}
	if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`).MatchString(account) || account == "root" {
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
	plist := `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>io.vectory.agent</string><key>UserName</key><string>` + xmlText(account) + `</string><key>ProgramArguments</key><array><string>` + xmlText(exe) + `</string><string>run</string><string>--state-dir</string><string>` + xmlText(dir) + `</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>AbandonProcessGroup</key><false/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`
	if old, err := os.ReadFile(serviceDefinition); err == nil && string(old) != plist {
		return errors.New("existing launchd definition differs; inspect before replacing")
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
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "/bin/launchctl", args...).Run(); err != nil {
		return errors.New("launchctl operation failed; inspect local service manager diagnostics")
	}
	return nil
}
func ServiceControl(action string) error {
	switch action {
	case "start":
		return launchctl("bootstrap", "system", serviceDefinition)
	case "stop":
		return launchctl("bootout", "system/io.vectory.agent")
	case "uninstall":
		if err := os.Remove(serviceDefinition); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return errors.New("invalid service operation")
}
