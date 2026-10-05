//go:build !windows

package agent

import (
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type changingRegistrationHost struct {
	*fakeHost
	registered  atomic.Bool
	inspections atomic.Int32
	firstRead   chan struct{}
}

func (h *changingRegistrationHost) Registered(stateDir string) (registeredService, error) {
	registered := h.registered.Load()
	if h.inspections.Add(1) == 1 {
		close(h.firstRead)
	}
	if !registered {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the agent service was uninstalled")
	}
	return h.fakeHost.Registered(stateDir)
}

// A public installer may pass its read-only preflight while service-uninstall
// owns lifecycle.lock. It must inspect the registered service again after
// acquiring that lock, before placing a helper or registering host units.
func TestPublicUpdateInstallerRechecksServiceAfterLifecycleLock(t *testing.T) {
	f := freshHost(t)
	host := &changingRegistrationHost{fakeHost: f.host, firstRead: make(chan struct{})}
	host.registered.Store(true)
	updateHostOverride = host
	dir, err := openRootOwned(f.paths.PolicyDir, rootOwnedDirectory)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	unlock, err := lockUpdateLifecycle(dir)
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(unlock)
	defer release()
	done := make(chan error, 1)
	go func() { done <- InstallUpdateHelper(f.stateDir, f.exe) }()
	select {
	case <-host.firstRead:
	case err := <-done:
		t.Fatalf("installer stopped before inspecting the service: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("installer did not inspect the service")
	}
	host.registered.Store(false)
	release()
	select {
	case err := <-done:
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != "NO_SERVICE" {
			t.Fatalf("installer used service registration from before the lock: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("installer did not finish after lifecycle unlock")
	}
	if host.inspections.Load() < 2 {
		t.Fatal("installer did not recheck the registered service under the lifecycle lock")
	}
	if _, err := os.Lstat(f.paths.StepDir); !os.IsNotExist(err) || len(host.unitsCalls) != 0 {
		t.Fatalf("installer placed a step for an unregistered service: step %v, units %v", err, host.unitsCalls)
	}
}
