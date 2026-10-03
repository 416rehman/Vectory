//go:build windows

package agent

import "testing"

// The gate of this platform decides whether it has a host at all. Closing it is
// the whole of what "Windows updates are not in this release" means, so the
// platform's answer must follow it.
func TestTheWindowsGateDecidesWhetherThereIsAHost(t *testing.T) {
	if old := updateHostOverride; old != nil {
		t.Fatal("a test left an override of the step's host set")
	}
	if got := currentUpdateHost() != nil; got != windowsUpdatesInRelease {
		t.Errorf("the Windows step has a host: %v, and its gate is open: %v", got, windowsUpdatesInRelease)
	}
	if !windowsUpdatesInRelease {
		if got := UpdateEligibility(t.TempDir()); got != "PLATFORM_NOT_IN_RELEASE" {
			t.Errorf("a Windows host with the gate closed reports %q", got)
		}
	}
}
