//go:build linux || darwin

package agent

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// The Unix counterpart of TestSettingsMaintenancePreservesCurrentWindowsAccess:
// what local maintenance replaces keeps the access the host gave it.

const accessAttribute = "user.vectory.access-test"

// unixAccess is what decides who can read a file: its owner, its group, its
// mode and its extended attributes (ACLs and labels live there).
type unixAccess struct {
	uid, gid uint32
	mode     os.FileMode
	attrs    map[string][]byte
}

func accessOf(t *testing.T, path string) (unixAccess, uint64) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	attrs, err := settingsXattrs(path)
	if err != nil {
		t.Fatal(err)
	}
	return unixAccess{uid: stat.Uid, gid: stat.Gid, mode: info.Mode().Perm(), attrs: attrs}, uint64(stat.Ino)
}

// giveAccess sets the mode and hands the file to another owner and group where
// the account may (root: any; others: a group they belong to), and adds an
// extended attribute where the file system has them. It reports what it did.
func giveAccess(t *testing.T, path string, mode os.FileMode) (handedOver, attribute bool) {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	current := info.Sys().(*syscall.Stat_t)
	if os.Geteuid() == 0 {
		handedOver = os.Chown(path, 41001, 41002) == nil
	} else if groups, err := os.Getgroups(); err == nil {
		for _, group := range groups {
			if uint32(group) != current.Gid && os.Chown(path, -1, group) == nil {
				handedOver = true
				break
			}
		}
	}
	err = unix.Setxattr(path, accessAttribute, []byte("kept"), 0)
	return handedOver, err == nil
}

func TestMaintenanceKeepsOwnerGroupModeAndAttributesOfWhatItReplaces(t *testing.T) {
	for _, mode := range []os.FileMode{0600, 0640} {
		t.Run(fmt.Sprintf("mode %04o", mode), func(t *testing.T) {
			f := maintenanceFixture(t)
			settingsPath, statePath := filepath.Join(f.dir, "settings.json"), filepath.Join(f.dir, "state.json")
			paths := []string{settingsPath, statePath}
			handedOver, attribute := false, false
			for _, path := range paths {
				h, a := giveAccess(t, path, mode)
				handedOver, attribute = h, a
			}
			if !handedOver {
				t.Log("this account belongs to no second group: owner and group are checked as they are")
			}
			if !attribute {
				t.Log("this file system has no extended attributes: mode, owner and group are checked")
			}
			before, inodes := map[string]unixAccess{}, map[string]uint64{}
			for _, path := range paths {
				before[path], inodes[path] = accessOf(t, path)
				if before[path].mode != mode {
					t.Fatalf("the fixture could not set mode %04o on %s", mode, filepath.Base(path))
				}
			}
			secret := filepath.Join(privateTempDir(t), "binding")
			if err := AtomicWrite(secret, []byte("synthetic-secret")); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			operations := []struct {
				name string
				run  func() error
			}{
				{"allowances, which reset the retry state too", func() error {
					return Install(ctx, f.dir, "", "", false, &CapabilityPolicy{AllowedNetworkHosts: []string{"logs.example.invalid:443"}})
				}},
				{"the metrics endpoint", func() error { return ConfigureMetrics(f.dir, "http://127.0.0.1:9601/metrics") }},
				{"secret bindings", func() error { return ConfigureSecretFiles(f.dir, map[string]string{"TOKEN": secret}) }},
				{"full mode", func() error { return ConfigureFullVector(f.dir, true) }},
				{"re-adoption of the Vector binary", func() error {
					_, err := reAdopt(ctx, f.dir, "", f.approved, successfulChecks())
					return err
				}},
			}
			replaced := map[string]bool{}
			for _, operation := range operations {
				if err := operation.run(); err != nil {
					t.Fatalf("%s: %v", operation.name, err)
				}
				for _, path := range paths {
					now, inode := accessOf(t, path)
					if !reflect.DeepEqual(now, before[path]) {
						t.Fatalf("%s changed the access of %s:\nbefore %+v\nafter  %+v", operation.name, filepath.Base(path), before[path], now)
					}
					if inode != inodes[path] {
						replaced[path], inodes[path] = true, inode
					}
				}
			}
			for _, path := range paths {
				if !replaced[path] {
					t.Fatalf("%s was never replaced, so nothing was preserved", filepath.Base(path))
				}
			}
			if attribute {
				if got, _ := accessOf(t, settingsPath); string(got.attrs[accessAttribute]) != "kept" {
					t.Fatal("the extended attribute did not survive")
				}
			}
		})
	}
}

// What the agent writes at run time is private to the writing account,
// whatever it replaces and whatever the umask says: it never inherits a wider
// mode, and it never loosens a directory.
func TestAtomicWriteNeverLoosensAccess(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	dir := privateTempDir(t)
	path := filepath.Join(dir, "managed.json")

	if err := AtomicWrite(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if got, _ := accessOf(t, path); got.mode != 0600 {
		t.Fatalf("a new file under umask 0 has mode %04o", got.mode)
	}
	for _, wider := range []os.FileMode{0666, 0644, 0640, 0777} {
		if err := os.Chmod(path, wider); err != nil {
			t.Fatal(err)
		}
		if err := AtomicWrite(path, []byte("replacement")); err != nil {
			t.Fatal(err)
		}
		if got, _ := accessOf(t, path); got.mode != 0600 {
			t.Fatalf("replacing a %04o file left mode %04o", wider, got.mode)
		}
	}
	// State directories are made private, whatever they were.
	shared := filepath.Join(dir, "state")
	if err := os.Mkdir(shared, 0777); err != nil {
		t.Fatal(err)
	}
	if err := PrivateDir(shared); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(shared); info.Mode().Perm() != 0700 {
		t.Fatalf("a private directory has mode %04o", info.Mode().Perm())
	}
}

// Files the service account owns stay its own when root replaces them (a
// foreground run as root, pause, retry), so the service can still read them.
// Only their owner and group carry over: the replacement stays private. An
// owner the file's directory doesn't share is never kept.
func TestRootReplacementKeepsTheServiceAccountsOwnership(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("only root can hand a file to another account")
	}
	dir := privateTempDir(t)
	state := filepath.Join(dir, "state")
	if err := os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(state, 41001, 41002); err != nil {
		t.Fatal(err)
	}
	owned, planted := filepath.Join(state, "state.json"), filepath.Join(state, "planted.json")
	for path, owner := range map[string][2]int{owned: {41001, 41002}, planted: {41003, 41004}} {
		if err := os.WriteFile(path, []byte("before"), 0666); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, owner[0], owner[1]); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0666); err != nil {
			t.Fatal(err)
		}
		if err := AtomicWrite(path, []byte("after")); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := accessOf(t, owned)
	if got.uid != 41001 || got.gid != 41002 || got.mode != 0600 {
		t.Fatalf("the service account's file after root replaced it: %+v", got)
	}
	got, _ = accessOf(t, planted)
	if got.uid != 0 || got.mode != 0600 {
		t.Fatalf("a file whose owner the directory doesn't share was handed on: %+v", got)
	}
}

// A setup, and the setup that follows it as an upgrade, leave every file of
// the agent's state private to its account and every directory closed: the
// Vector process, which runs as that account's child, is never given a group.
func TestSetupAndUpgradeLeaveOnlyPrivateFiles(t *testing.T) {
	server := newSetupServer(t)
	options, dir, managed := setupFixture(t)
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, fakeVector(t, VectorVersion)
	options.Token = func() (string, error) { return "synthetic-setup-token", nil }
	if err := os.MkdirAll(filepath.Dir(managed), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managed, []byte(`{"sources":{}}`), 0644); err != nil {
		t.Fatal(err)
	}
	oldUmask := syscall.Umask(0)
	defer syscall.Umask(oldUmask)
	for _, pass := range []string{"setup", "upgrade"} {
		if _, err := Setup(context.Background(), options); err != nil {
			t.Fatalf("%s: %v", pass, err)
		}
		options.CASHA256 = ""
		entries := 0
		for _, root := range []string{dir, filepath.Dir(managed)} {
			err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				entries++
				switch {
				case path == managed:
					// The operator's own file keeps the access it had until the
					// agent replaces it; adoption never touches it.
				case entry.IsDir() && info.Mode().Perm() != 0700:
					return fmt.Errorf("%s: directory mode %04o after %s", path, info.Mode().Perm(), pass)
				case entry.Type().IsRegular() && info.Mode().Perm() != 0600:
					return fmt.Errorf("%s: file mode %04o after %s", path, info.Mode().Perm(), pass)
				}
				return nil
			})
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				t.Fatal(err)
			}
		}
		if entries < 8 {
			t.Fatalf("only %d entries were checked after %s", entries, pass)
		}
	}
	if info, err := os.Stat(managed); err != nil || info.Mode().Perm() != 0644 {
		t.Fatalf("adoption changed the operator's managed file: %v %v", info, err)
	}
}
