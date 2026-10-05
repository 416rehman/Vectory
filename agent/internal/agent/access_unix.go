//go:build !windows

package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// accountIDs are the credentials a service account runs with. uid -1 is an
// account that doesn't exist yet: it will own none of the files checked.
type accountIDs struct {
	uid    int
	gid    int
	groups map[int]bool
}

func lookupAccountIDs(account string) (accountIDs, bool) {
	ids := accountIDs{uid: -1, gid: -1, groups: map[int]bool{}}
	u, err := user.Lookup(account)
	if err != nil {
		return ids, false
	}
	if ids.uid, err = strconv.Atoi(u.Uid); err != nil {
		return accountIDs{uid: -1, gid: -1, groups: map[int]bool{}}, false
	}
	ids.gid, _ = strconv.Atoi(u.Gid)
	ids.groups[ids.gid] = true
	if list, err := u.GroupIds(); err == nil {
		for _, g := range list {
			if n, err := strconv.Atoi(g); err == nil {
				ids.groups[n] = true
			}
		}
	}
	return ids, true
}

// permits applies the classic owner/group/other permission bits.
func (a accountIDs) permits(info os.FileInfo, need os.FileMode) bool {
	if a.uid == 0 {
		return true
	}
	mode := info.Mode().Perm()
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return true
	}
	bits := mode & 7
	switch {
	case a.uid >= 0 && int(stat.Uid) == a.uid:
		bits = mode >> 6 & 7
	case a.groups[int(stat.Gid)]:
		bits = mode >> 3 & 7
	}
	return bits&need == need
}

// accessBlocker names the first path component that keeps the account from
// running path (and reading it, when read is set), judged by permission bits,
// and whether that component is the file itself.
func accessBlocker(ids accountIDs, path string, read bool) (string, bool) {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	var chain []string
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		chain = append([]string{p}, chain...)
		if filepath.Dir(p) == p {
			break
		}
	}
	for i, p := range chain {
		info, err := os.Stat(p)
		if err != nil {
			return "", false
		}
		describe := fmt.Sprintf("mode %04o%s", info.Mode().Perm(), ownerSuffix(info))
		if i < len(chain)-1 {
			if !ids.permits(info, 1) {
				return p + " is private (" + describe + ")", false
			}
			continue
		}
		need := os.FileMode(1)
		what := "executable"
		if read {
			need, what = 5, "readable and executable"
		}
		if !ids.permits(info, need) {
			return p + " isn't " + what + " for it (" + describe + ")", true
		}
	}
	return "", false
}

// runsAs reports whether account can start path with args. Only root can
// switch accounts; the answer includes ACLs and anything else the kernel
// enforces.
func runsAs(ctx context.Context, ids accountIDs, path string, args ...string) bool {
	if os.Geteuid() != 0 || ids.uid < 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = cleanEnvironment()
	cmd.Dir = "/"
	cmd.WaitDelay = time.Second
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	groups := make([]uint32, 0, len(ids.groups))
	for g := range ids.groups {
		groups = append(groups, uint32(g))
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(ids.uid), Gid: uint32(ids.gid), Groups: groups}}
	return cmd.Run() == nil
}

// accountAccessProblem explains why the service account can't run the
// executable at path (and read it, when read is set), or returns "".
// Permission bits decide quickly; when they say no for an existing account,
// the program is started as that account, so ACLs that grant access are
// honored. (Starting it proves nothing about reading the file itself.)
func accountAccessProblem(ctx context.Context, account, path string, read bool, args ...string) string {
	ids, _ := lookupAccountIDs(account)
	blocker, onFile := accessBlocker(ids, path, read)
	if blocker == "" || !(read && onFile) && runsAs(ctx, ids, path, args...) {
		return ""
	}
	return blocker
}

// A staged installer candidate must actually start as an existing service
// account before it replaces the installed binary. This also catches noexec
// mounts, interpreter failures and access rules beyond Unix mode bits.
func stagedAgentAccessProblem(ctx context.Context, account, path string) string {
	ids, ok := lookupAccountIDs(account)
	if !ok {
		return "service account cannot be resolved"
	}
	blocker, _ := accessBlocker(ids, path, false)
	if runsAs(ctx, ids, path, "version") {
		return ""
	}
	if blocker != "" {
		return blocker
	}
	return "it could not execute `vectory version` as that account"
}
