package agent

import (
	"errors"
	"os/user"
	"regexp"
	"runtime"
)

var (
	linuxAccountName  = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	darwinAccountName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`)
)

// CheckServiceAccountName applies the same rules as service registration.
func CheckServiceAccountName(name string) error {
	valid := linuxAccountName.MatchString(name)
	if runtime.GOOS == "darwin" {
		valid = darwinAccountName.MatchString(name)
	}
	if !valid || name == "root" {
		return errors.New("--service-user must name an unprivileged account (letters, digits, _ and -; not root)")
	}
	return nil
}

// ServiceAccountExists reports whether the named local account exists.
func ServiceAccountExists(name string) bool {
	_, err := user.Lookup(name)
	return err == nil
}
