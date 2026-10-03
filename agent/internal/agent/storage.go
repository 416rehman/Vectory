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
	"time"
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
	if e := makeTraversable(filepath.Dir(path)); e != nil {
		return e
	}
	if e := os.MkdirAll(path, 0700); e != nil {
		return e
	}
	return protect(path, true)
}

// makeTraversable creates the directories above a private one that don't exist
// yet, each readable and searchable by everyone whatever the umask. The service
// account that owns the private directory has to reach it through them, and they
// hold nothing private: MkdirAll with 0700 would have made them root's alone.
// A directory that exists is left as it is.
func makeTraversable(dir string) error {
	if _, err := os.Lstat(dir); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if parent := filepath.Dir(dir); parent != dir {
		if err := makeTraversable(parent); err != nil {
			return err
		}
	}
	if err := os.Mkdir(dir, 0755); err != nil && !os.IsExist(err) {
		return err
	}
	return os.Chmod(dir, 0755)
}

// atomicTempPrefix names AtomicWrite's temporary files, so a leftover from a
// crash mid-write is recognized rather than taken for an unrelated file.
const atomicTempPrefix = ".vectory-tmp-"

// atomicTempStale is the age after which a temporary or staged file can't
// belong to a write or validation in progress.
const atomicTempStale = 10 * time.Minute

// agentLeftover reports the agent's own transient files: atomic-write
// temporaries and staged candidates.
func agentLeftover(name string) bool {
	return strings.HasPrefix(name, atomicTempPrefix) || strings.HasPrefix(name, ".vectory-stage-") && strings.HasSuffix(name, ".json")
}

// Adoption and service registration must never change ownership/permissions on
// shared directories such as /etc or an existing multi-file Vector installation.
// The agent's own leftovers are accepted, and stale ones removed.
func CheckManagedDirectory(config, state string) error {
	return checkManagedDirectory(config, state, true)
}

// checkManagedDirectory is CheckManagedDirectory; a dry run passes clean false
// and changes nothing.
func checkManagedDirectory(config, state string, clean bool) error {
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
		if name != filepath.Base(config) && !agentLeftover(name) {
			return errors.New("managed config directory contains unrelated files; choose a dedicated directory")
		}
		path := filepath.Join(parent, name)
		if err = SafePath(path); err != nil {
			return err
		}
		if info, err := entry.Info(); clean && err == nil && agentLeftover(name) && info.Mode().IsRegular() && time.Since(info.ModTime()) > atomicTempStale {
			_ = os.Remove(path)
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
		// adoption-inventory is the copy of an existing Vector's configuration
		// that setup made before the agent was installed.
		if entry.Name() == adoptionInventoryDir && entry.IsDir() {
			continue
		}
		if entry.Name() != "agent.lock" && entry.Name() != "adoption-backup.json" && !strings.HasPrefix(entry.Name(), atomicTempPrefix) {
			return errors.New("state directory contains unrelated files; choose a dedicated Vectory state directory")
		}
	}
	return nil
}

// atomicFile is what AtomicWrite writes its temporary file through.
type atomicFile interface {
	Name() string
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

// createAtomicTemp creates the temporary file that will replace dest, beside
// it. It is a variable so a test can make the disk fill up at a chosen write;
// nothing else replaces it.
var createAtomicTemp = func(dest string) (atomicFile, error) {
	return os.CreateTemp(filepath.Dir(dest), atomicTempPrefix+"*")
}

// AtomicWrite replaces path with data: the bytes are written and synced to a
// private temporary file beside it, which then takes the place of path, so a
// crash leaves the old file or the new one, never part of either. The result
// is private to the writing account whatever file it replaces. A full disk
// comes back as a *DiskFullError and leaves path untouched.
func AtomicWrite(path string, data []byte) error {
	if e := SafePath(path); e != nil {
		return e
	}
	dir := filepath.Dir(path)
	f, e := createAtomicTemp(path)
	if e != nil {
		return storageError(dir, e)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = protect(tmp, false); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(data); e != nil {
		f.Close()
		return storageError(dir, e)
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return storageError(dir, e)
	}
	if e = f.Close(); e != nil {
		return storageError(dir, e)
	}
	keepOwner(tmp, path)
	if e = replaceFile(tmp, path); e != nil {
		return storageError(dir, e)
	}
	return storageError(dir, syncDir(dir))
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

// localPauseMarker is the file `vectory pause` leaves in the state directory. A
// pause is in force while it is there, and for as long as it can't be shown not to
// be: LocalPaused counts any error but "does not exist" as a pause.
const localPauseMarker = "paused"

func LocalPaused(dir string) bool {
	_, e := os.Stat(filepath.Join(dir, localPauseMarker))
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
		return AtomicWrite(filepath.Join(dir, localPauseMarker), []byte("local emergency pause\n"))
	}
	e := os.Remove(filepath.Join(dir, localPauseMarker))
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
