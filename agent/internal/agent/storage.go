package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func Digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func RandomID() string {
	var b [32]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func FileDigest(path string) (string, error) {
	if err := SafePath(path); err != nil {
		return "", err
	}
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func SafePath(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("path must be absolute")
	}
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		i, e := os.Lstat(p)
		if e == nil {
			if i.Mode()&os.ModeSymlink != 0 {
				return errors.New("symlink paths are forbidden")
			}
			if e = rejectPlatformLink(p); e != nil {
				return e
			}
		} else if !os.IsNotExist(e) {
			return e
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return nil
}
func PrivateDir(path string) error {
	if e := SafePath(path); e != nil {
		return e
	}
	if e := os.MkdirAll(path, 0700); e != nil {
		return e
	}
	return protect(path, true)
}

// Adoption and service registration must never change ownership/permissions on
// shared directories such as /etc or an existing multi-file Vector installation.
func CheckManagedDirectory(config, state string) error {
	parent := filepath.Dir(filepath.Clean(config))
	if parent == filepath.Clean(state) || parent == filepath.VolumeName(parent)+string(filepath.Separator) {
		return errors.New("managed config requires a separate dedicated directory")
	}
	if err := SafePath(parent); err != nil {
		return err
	}
	entries, err := os.ReadDir(parent)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			return errors.New("managed config directory contains unrelated entries; choose a dedicated directory")
		}
		name := entry.Name()
		if name != filepath.Base(config) && !(strings.HasPrefix(name, ".vectory-stage-") && strings.HasSuffix(name, ".json")) {
			return errors.New("managed config directory contains unrelated files; choose a dedicated directory")
		}
		if err = SafePath(filepath.Join(parent, name)); err != nil {
			return err
		}
	}
	return nil
}
func CheckFreshStateDirectory(dir string) error {
	if err := SafePath(dir); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != "agent.lock" && entry.Name() != "adoption-backup.json" {
			return errors.New("state directory contains unrelated files; choose a dedicated Vectory state directory")
		}
	}
	return nil
}
func AtomicWrite(path string, data []byte) error {
	if e := SafePath(path); e != nil {
		return e
	}
	dir := filepath.Dir(path)
	f, e := os.CreateTemp(dir, ".vectory-*")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = protect(tmp, false); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = replaceFile(tmp, path); e != nil {
		return e
	}
	return syncDir(dir)
}
func ReadJSON(path string, v any) error {
	if e := SafePath(path); e != nil {
		return e
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	if len(b) > 2*MaxArtifact {
		return errors.New("state file exceeds limit")
	}
	return json.Unmarshal(b, v)
}
func WriteJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return AtomicWrite(path, append(b, '\n'))
}
func LoadState(dir string) (State, error) {
	s := State{ApplyState: "unmanaged", Policy: Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}
	e := ReadJSON(filepath.Join(dir, "state.json"), &s)
	if os.IsNotExist(e) {
		e = nil
	}
	return s, e
}
func LoadSettings(dir string) (Settings, error) {
	var s Settings
	e := ReadJSON(filepath.Join(dir, "settings.json"), &s)
	return s, e
}
func SaveState(dir string, s State) error { return WriteJSON(filepath.Join(dir, "state.json"), s) }
func LocalPaused(dir string) bool {
	_, e := os.Stat(filepath.Join(dir, "paused"))
	return e == nil || !os.IsNotExist(e)
}
func SetPause(dir string, paused bool) error {
	// Local emergency pause must remain usable while run owns agent.lock, but
	// it must not race a purge removing the directory underneath the write.
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return err
	}
	defer releaseLifecycle()
	if err := checkNoPendingPurge(dir); err != nil {
		return err
	}
	// After the final purge-marker unlink, an interrupted rmdir can leave an
	// empty directory. Do not repopulate that residue with a pause marker.
	installed := false
	for _, name := range []string{"settings.json", "state.json"} {
		info, err := os.Lstat(filepath.Join(dir, name))
		if err == nil && info.Mode().IsRegular() {
			installed = true
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if !installed {
		return errors.New("local pause requires existing agent state")
	}
	if paused {
		return AtomicWrite(filepath.Join(dir, "paused"), []byte("local emergency pause\n"))
	}
	e := os.Remove(filepath.Join(dir, "paused"))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	return syncDir(dir)
}
func readArtifact(path string) ([]byte, error) {
	if e := SafePath(path); e != nil {
		return nil, e
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, MaxArtifact+1))
	if e != nil {
		return nil, e
	}
	if len(b) > MaxArtifact {
		return nil, fmt.Errorf("artifact exceeds %d bytes", MaxArtifact)
	}
	return b, nil
}
