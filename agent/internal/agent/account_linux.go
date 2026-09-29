//go:build linux

package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// CreateServiceAccount creates a system account and group with no home
// directory and no login shell, using the distribution's own tools.
func CreateServiceAccount(ctx context.Context, name string) error {
	if err := CheckServiceAccountName(name); err != nil {
		return err
	}
	if ServiceAccountExists(name) {
		return nil
	}
	shell := "/bin/false"
	for _, candidate := range []string{"/usr/sbin/nologin", "/sbin/nologin"} {
		if _, err := os.Stat(candidate); err == nil {
			shell = candidate
			break
		}
	}
	var steps [][]string
	if _, err := exec.LookPath("useradd"); err == nil {
		steps = [][]string{{"useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", shell, "--comment", "Vectory agent", name}}
	} else if _, err := exec.LookPath("adduser"); err == nil {
		// BusyBox (Alpine): the group must exist before the user.
		steps = [][]string{{"addgroup", "-S", name}, {"adduser", "-S", "-D", "-H", "-h", "/nonexistent", "-s", shell, "-G", name, "-g", "Vectory agent", name}}
	} else {
		return errors.New("neither useradd nor adduser is available; create the account yourself and pass --service-user")
	}
	for _, step := range steps {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(ctx, step[0], step[1:]...)
		out := &limitedWriter{max: 512}
		cmd.Stdout, cmd.Stderr = out, out
		err := cmd.Run()
		cancel()
		if err != nil {
			return errors.New("couldn't create account " + name + ": " + safeText(strings.TrimSpace(out.b.String()), 200))
		}
	}
	if !ServiceAccountExists(name) {
		return errors.New("account " + name + " was not found after creating it")
	}
	return nil
}
