package agent

import (
	"errors"
	"fmt"
	"time"
)

var errUpdateFileLockBusy = errors.New("another update operation is running")

// lockUpdatePolicy waits for a separate, persistent lock file in the checked
// policy directory. The lock belongs to the OS handle, so process death releases
// it. All cooperating policy writers take it before they read or replace the
// policy. A bounded wait keeps a hung local writer from hanging the CLI forever.
func lockUpdatePolicy(dir *rootOwned) (func(), error) {
	return lockUpdateFile(dir, updatePolicyLockFile, 30*time.Second)
}

// lockUpdateLifecycle serializes setup's final update-step installation with
// withdrawal's policy change and step/unit removal. It is always taken before
// policy.lock or the step's own lock, never while either is held.
func lockUpdateLifecycle(dir *rootOwned) (func(), error) {
	return lockUpdateFile(dir, updateLifecycleLockFile, 2*time.Minute)
}

func lockUpdateFile(dir *rootOwned, name string, wait time.Duration) (func(), error) {
	deadline := time.Now().Add(wait)
	for {
		unlock, err := tryLockUpdateFile(dir, name)
		if err == nil {
			return unlock, nil
		}
		if !errors.Is(err, errUpdateFileLockBusy) {
			return nil, err
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("timed out waiting for %s: %w", dir.entryPath(name), err)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// acquireUpdateLifecycle creates the checked policy directory when installation
// needs it, and keeps its handle open for the whole lifecycle transaction.
func acquireUpdateLifecycle() (func(), error) {
	dir, err := ensureRootOwnedDir(UpdateLocations().PolicyDir, rootReadable)
	if err != nil {
		return nil, err
	}
	unlock, err := lockUpdateLifecycle(dir)
	if err != nil {
		_ = dir.Close()
		return nil, err
	}
	return func() { unlock(); _ = dir.Close() }, nil
}

func withUpdateLifecycle(operation func() error) error {
	release, err := acquireUpdateLifecycle()
	if err != nil {
		return err
	}
	defer release()
	return operation()
}
