//go:build linux

package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// The removal of the step and `update off` for a rollback that can't start the previous build,
// through the Linux host's own locator, which reads the agent's unit. The fixture's host embeds a
// fake whose locator answers with the fake's executable whatever the unit says, so this puts the
// real one in its place (update_removal_registration_test.go says what is expected).

// linuxLocatorHost is the fixture's host whose locator is the Linux host's own.
type linuxLocatorHost struct {
	*fakeHost
	linux *linuxUpdateHost
}

func (h *linuxLocatorHost) AgentExecutable() (string, error) { return h.linux.AgentExecutable() }

// heldRollbackOnTheFakeHost drives the step into a rollback that has put the previous build back and
// can't start it: the service manager takes no start from then on.
func heldRollbackOnTheFakeHost(t *testing.T) (f *stepFixture, release *fakeRelease, oldDigest string) {
	t.Helper()
	f = newStepFixture(t)
	oldDigest = f.executableDigest()
	release = f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	armed := false
	updateFault = func(point string) {
		if point == "rollback:restored" && !armed {
			armed = true
			f.host.cfg.StartFails = 1000
		}
	}
	if err := f.run(); err == nil {
		t.Fatal("the run that couldn't start the previous build ended without an error")
	}
	updateFault = nil
	f.requireRollbackWaitingForAStart(oldDigest, release)
	return f, release, oldDigest
}

func TestARollbackWhoseAgentUnitWasRemovedByHandIsRefusedWithWordsThatSayWhatToRunThroughTheLinuxLocator(t *testing.T) {
	f, _, _ := heldRollbackOnTheFakeHost(t)
	linux := newLinuxUpdateHost()
	linux.unitDir = filepath.Join(f.root, "etc", "systemd", "system")
	mkdirMode(t, linux.unitDir, 0o755)
	updateHostOverride = &linuxLocatorHost{fakeHost: f.host, linux: linux}
	unit := filepath.Join(linux.unitDir, ServiceName)

	requireTheRegistrationRefusal(t, f, unit+" doesn't exist")

	// With the unit written as `vectory service-install` writes it, the same removal ends the
	// rollback through the same locator.
	text := systemdUnitFile(f.exe, f.stateDir, "", "svc", "65534")
	if err := os.WriteFile(unit, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unit, 0o644); err != nil {
		t.Fatal(err)
	}
	if executable, err := linux.AgentExecutable(); err != nil || executable != f.exe {
		t.Fatalf("the Linux host's locator with the unit there: %q, %v", executable, err)
	}
	if err := RemoveUpdateHelper(); err != nil {
		t.Fatalf("removing the step while the rollback waits for a start that never comes: %v", err)
	}
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
}
