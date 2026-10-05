package agent

import (
	"errors"
	"fmt"
	"time"
)

var errUpdatePolicyLockBusy = errors.New("another update policy writer is running")

// lockUpdatePolicy waits for a separate, persistent lock file in the checked
// policy directory. The lock belongs to the OS handle, so process death releases
// it. All cooperating policy writers take it before they read or replace the
// policy. A bounded wait keeps a hung local writer from hanging the CLI forever.
func lockUpdatePolicy(dir *rootOwned) (func(), error) {
	deadline := time.Now().Add(30 * time.Second)
	for {
		unlock, err := tryLockUpdatePolicy(dir)
		if err == nil {
			return unlock, nil
		}
		if !errors.Is(err, errUpdatePolicyLockBusy) {
			return nil, err
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("timed out waiting for %s: %w", dir.entryPath(updatePolicyLockFile), err)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
