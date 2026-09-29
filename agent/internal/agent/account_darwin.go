//go:build darwin

package agent

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// CreateServiceAccount creates a hidden role account (UID/GID below 500) with
// no home directory and no login shell, as macOS system daemons use.
func CreateServiceAccount(ctx context.Context, name string) error {
	if err := CheckServiceAccountName(name); err != nil {
		return err
	}
	if ServiceAccountExists(name) {
		return nil
	}
	id, err := freeRoleID(ctx)
	if err != nil {
		return err
	}
	value := strconv.Itoa(id)
	steps := [][]string{
		{"-create", "/Groups/" + name},
		{"-create", "/Groups/" + name, "PrimaryGroupID", value},
		{"-create", "/Groups/" + name, "RealName", "Vectory agent"},
		{"-create", "/Groups/" + name, "Password", "*"},
		{"-create", "/Users/" + name},
		{"-create", "/Users/" + name, "UniqueID", value},
		{"-create", "/Users/" + name, "PrimaryGroupID", value},
		{"-create", "/Users/" + name, "UserShell", "/usr/bin/false"},
		{"-create", "/Users/" + name, "NFSHomeDirectory", "/var/empty"},
		{"-create", "/Users/" + name, "RealName", "Vectory agent"},
		{"-create", "/Users/" + name, "Password", "*"},
		{"-create", "/Users/" + name, "IsHidden", "1"},
	}
	for _, step := range steps {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(ctx, "/usr/bin/dscl", append([]string{"."}, step...)...)
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

// freeRoleID returns an ID in the role-account range unused by users and groups.
func freeRoleID(ctx context.Context) (int, error) {
	used := map[int]bool{}
	for _, list := range [][]string{{".", "-list", "/Users", "UniqueID"}, {".", "-list", "/Groups", "PrimaryGroupID"}} {
		out := commandOutput(ctx, 1<<20, "/usr/bin/dscl", list...)
		if out == "" {
			return 0, errors.New("couldn't list local accounts with dscl")
		}
		for _, line := range strings.Split(out, "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if n, err := strconv.Atoi(fields[len(fields)-1]); err == nil {
					used[n] = true
				}
			}
		}
	}
	for id := 450; id >= 200; id-- {
		if !used[id] {
			return id, nil
		}
	}
	return 0, errors.New("no free role-account ID between 200 and 450")
}
