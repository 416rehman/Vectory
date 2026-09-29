//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// resolveLinks walks an absolute path from the root, replacing each symbolic
// link with its target. Missing components end the walk and are kept as typed.
func resolveLinks(path string, anyOwner bool) (string, bool, error) {
	followed := false
	pending := strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/")
	resolved := "/"
	for hops := 0; len(pending) > 0; {
		part := pending[0]
		pending = pending[1:]
		switch part {
		case "", ".":
			continue
		case "..":
			resolved = filepath.Dir(resolved)
			continue
		}
		candidate := filepath.Join(resolved, part)
		info, err := os.Lstat(candidate)
		if os.IsNotExist(err) {
			return filepath.Join(append([]string{candidate}, pending...)...), followed, nil
		}
		if err != nil {
			return "", followed, err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			resolved = candidate
			continue
		}
		if hops++; hops > 40 {
			return "", followed, errors.New("too many levels of symbolic links")
		}
		if !anyOwner && !trustedLink(info) {
			return "", followed, fmt.Errorf("%s is a symbolic link owned by another account; use the real path instead", candidate)
		}
		target, err := os.Readlink(candidate)
		if err != nil {
			return "", followed, err
		}
		followed = true
		if filepath.IsAbs(target) {
			resolved = "/"
		}
		pending = append(strings.Split(strings.TrimPrefix(filepath.Clean(target), "/"), "/"), pending...)
	}
	return resolved, followed, nil
}

// Only root or this account can have created, or can replace, such a link, and
// both are already trusted with everything the agent writes.
func trustedLink(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && (stat.Uid == 0 || stat.Uid == uint32(os.Geteuid()))
}
