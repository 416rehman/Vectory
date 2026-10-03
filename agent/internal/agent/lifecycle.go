package agent

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const purgeMarkerName = ".vectory-purge.json"

type purgeMarker struct {
	Kind        string `json:"kind"`
	StateDir    string `json:"state_dir"`
	DirectoryID string `json:"directory_id"`
}

func readPurgeMarker(path, identity string) (*purgeMarker, error) {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	if err := regularPath(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(f, 513))
	_ = f.Close()
	if readErr != nil || len(data) > 512 {
		return nil, errors.New("purge marker is unreadable or oversized")
	}
	var marker purgeMarker
	if json.Unmarshal(data, &marker) != nil || marker.Kind != "vectory-agent-state-purge-v1" || marker.StateDir != identity || marker.DirectoryID == "" {
		return nil, errors.New("purge marker does not match this state directory")
	}
	return &marker, nil
}

func checkNoPendingPurge(dir string) error {
	if _, err := os.Lstat(filepath.Join(dir, purgeMarkerName)); err == nil {
		return errors.New("state purge is incomplete; finish uninstall --purge before another agent operation")
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}

func createFreshStateDirectory(dir string) error {
	// On Windows, the directory that holds the state directory under ProgramData is
	// judged before anything is made in it (see state_root.go).
	if err := ensureStateRoot(dir); err != nil {
		return err
	}
	// A previously absent parent has no installed state to purge yet. It stays
	// traversable: the service account owns the state directory below it.
	if err := makeTraversable(filepath.Dir(dir)); err != nil {
		return err
	}
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return err
	}
	defer releaseLifecycle()
	if err := checkNoPendingPurge(dir); err != nil {
		return err
	}
	return makePrivateDirectory(dir)
}

// Lock keeps the existing state-file lock for the duration of an operation.
// The lifecycle guard serializes opening that file with state deletion, so
// deleting and recreating a directory cannot split the lock into two inodes.
func Lock(dir string) (func(), error) {
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return nil, err
	}
	defer releaseLifecycle()
	if err := checkNoPendingPurge(dir); err != nil {
		return nil, err
	}
	return lockAgentFile(dir)
}

// PurgeState removes only a validated installed state directory. Its marker
// stays inside the protected state tree so an unrelated user cannot plant a
// predictable sibling file and permanently block the agent. Retrying is safe
// after intermediate removal, even if settings.json has disappeared. If a
// process dies after the marker is removed but before rmdir, only an empty
// directory can remain; that narrow final gap requires manual inspection.
func PurgeState(dir string) error {
	return purgeState(dir, os.RemoveAll)
}

func purgeState(dir string, remove func(string) error) error {
	if err := adoptionLocalPath(dir); err != nil {
		return err
	}
	resolved := filepath.Clean(dir)
	if filepath.Dir(resolved) == resolved || filepath.Base(resolved) == "." {
		return errors.New("unsafe purge path")
	}
	releaseLifecycle, err := lockLifecycle(resolved)
	if err != nil {
		return err
	}
	defer releaseLifecycle()
	if err = SafePath(resolved); err != nil {
		return err
	}
	identity, err := purgeMarkerIdentity(resolved)
	if err != nil {
		return err
	}
	directoryID, err := stateDirectoryIdentity(resolved)
	if err != nil {
		return err
	}
	markerPath := filepath.Join(resolved, purgeMarkerName)
	marker, err := readPurgeMarker(markerPath, identity)
	if err != nil {
		return err
	}
	if marker != nil && marker.DirectoryID != directoryID {
		return errors.New("purge marker belongs to a different state directory object; inspect the replacement before continuing")
	}
	if marker == nil {
		if err := verifyInstalledPurgeSettings(resolved); err != nil {
			return err
		}
	}
	unlock, err := lockAgentFile(resolved)
	if err != nil {
		return err
	}
	agentLocked := true
	defer func() {
		if agentLocked {
			unlock()
		}
	}()
	if err = SafePath(resolved); err != nil {
		return err
	}
	confirmedID, err := stateDirectoryIdentity(resolved)
	if err != nil {
		return err
	}
	if confirmedID != directoryID {
		return errors.New("state directory changed during purge preflight")
	}
	if marker == nil {
		if err := verifyInstalledPurgeSettings(resolved); err != nil {
			return err
		}
		marker = &purgeMarker{Kind: "vectory-agent-state-purge-v1", StateDir: identity, DirectoryID: directoryID}
		if err := WriteJSON(markerPath, marker); err != nil {
			return err
		}
	}
	if purgeNeedsAgentUnlock() {
		unlock()
		agentLocked = false
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == purgeMarkerName {
			continue
		}
		if err := remove(filepath.Join(resolved, entry.Name())); err != nil {
			return err
		}
	}
	// On Unix, persist all data-entry removals before deleting the retry marker.
	if err := syncDir(resolved); err != nil {
		return err
	}
	if err := os.Remove(markerPath); err != nil {
		return err
	}
	if err := os.Remove(resolved); err != nil {
		return err
	}
	return syncDir(filepath.Dir(resolved))
}

func verifyInstalledPurgeSettings(dir string) error {
	doc, err := loadSettingsDocument(dir)
	if err != nil {
		return errors.New("purge requires valid installed Vectory settings.json")
	}
	s := doc.value
	if !s.Adopted || s.VectorBinary == "" || s.ManagedConfig == "" || !approvedDigest.MatchString(s.VectorBinarySHA256) || s.ValidationSeconds <= 0 || s.StartupSeconds <= 0 || adoptionLocalPath(s.VectorBinary) != nil || adoptionLocalPath(s.ManagedConfig) != nil {
		return errors.New("purge requires valid installed Vectory settings.json")
	}
	return nil
}
