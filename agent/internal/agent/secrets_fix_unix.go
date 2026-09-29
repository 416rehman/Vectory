//go:build !windows

package agent

import (
	"os/user"
	"strings"
)

// privateFileFix is the exact command that makes a file private to this
// agent account, for local error messages only.
func privateFileFix(path string) string {
	account := "<agent account>"
	if u, err := user.Current(); err == nil && u.Username != "" {
		account = u.Username
	}
	quoted := "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
	return "run: sudo chown " + account + " " + quoted + " && sudo chmod 600 " + quoted + " (one link only, no symlinks in the path)"
}
