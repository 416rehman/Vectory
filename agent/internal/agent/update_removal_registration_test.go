//go:build !windows

package agent

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A rollback that has put the previous build back and can't start it is held open by the step's
// tries, and the removal of the step and `update off` end it when the previous build is in place
// and only its start is missing. They find out where the previous build is from the executable the
// agent's service is registered to run. Where the registration is gone (its definition, unit or
// service was removed by hand) they can't, so they don't end the rollback: they refuse with the
// words that say the agent's service isn't registered, so the step can't start the previous build,
// and what gives it a registration again, after which the step finishes the rollback itself.
//
// The fixture's host embeds a fake whose AgentExecutable answers with the fake's executable whatever
// the definition says, so the tests here put each system's own locator in its place: the one that
// reads the registration.

// macOSLocatorHost is the fixture's launchd host whose locator is the macOS host's own, which reads
// the agent's definition.
type macOSLocatorHost struct{ *launchdHost }

func (h *macOSLocatorHost) AgentExecutable() (string, error) { return h.mac.AgentExecutable() }

// registrationWords is what the removal and turning updates off say about a rollback whose agent
// service has no registration, where gone says what is missing.
func registrationWords(gone string) string {
	return "an update is being rolled back on this host, and the agent's service isn't registered (" + gone + "), so the update step can't start the previous build. " +
		"Register the service again with `sudo vectory service-install`; the update step then finishes the rollback by itself, usually within a minute or two"
}

// requireTheRegistrationRefusal says that removing the step and turning updates off are both refused
// with the words for a rollback whose agent service isn't registered, and that neither changed
// anything: not the policy, the floors, the executable, the units, the step's directory or the
// journal.
func requireTheRegistrationRefusal(t *testing.T, f *stepFixture, gone string) {
	t.Helper()
	before := f.snapshot()
	units := len(f.host.unitsCalls)
	want := registrationWords(gone)
	if err := RemoveUpdateHelper(); err == nil || err.Error() != want {
		t.Errorf("removing the step: %v\nwant %s", err, want)
	}
	done, err := WithdrawUpdates(f.stateDir)
	var busy *UpdateBusyError
	if !errors.As(err, &busy) || busy.Message != want {
		t.Errorf("turning updates off: %v\nwant %s", err, want)
	}
	if done.PolicyOff || done.Discarded || done.StepRemoved || done.RollbackEnded {
		t.Errorf("turning updates off changed something before it was refused: %+v", done)
	}
	if after := f.snapshot(); !reflect.DeepEqual(after, before) {
		t.Errorf("the host changed: %+v, was %+v", after, before)
	}
	if _, statErr := os.Lstat(f.paths.StepDir); statErr != nil {
		t.Error("the step's directory was removed")
	}
	if len(f.host.unitsCalls) != units {
		t.Errorf("the units were touched: %v", f.host.unitsCalls[units:])
	}
	if journal, found := f.journal(); !found || journal.Stage != UpdateStageRollingBack {
		t.Errorf("the journal: %+v (found %v)", journal, found)
	}
	if strings.Contains(want, "every 30 seconds") {
		t.Error("the words promise a retry that can't succeed: the step has no service to start")
	}
}

// heldRollbackWithoutItsDefinition drives the step into a rollback that can't start the previous
// build because a person removed the agent's definition by hand while the rollback began: launchd
// can't load a job from a file that isn't there. Every run after that is a new process, and ends
// with an error.
func heldRollbackWithoutItsDefinition(t *testing.T) (f *stepFixture, machine *launchdOverMachine, mac *macosUpdateHost, release *fakeRelease, oldDigest string) {
	t.Helper()
	f = newStepFixture(t)
	machine, mac = f.useLaunchd()
	oldDigest = f.executableDigest()
	release = f.newRelease("0.1.2", "crash", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point == "rolling_back" {
			if err := os.Remove(mac.agent.definition); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		}
	}
	if err := f.run(); err == nil {
		t.Fatal("the run that couldn't start the previous build ended without an error")
	}
	updateFault = nil
	for i := 0; i < 6; i++ {
		f.clock.advance(30 * time.Second)
		f.anotherStepProcess(machine)
		if err := f.run(); err == nil {
			t.Fatalf("run %d started the previous build", i+2)
		}
	}
	journal, found := f.journal()
	if !found || journal.Stage != UpdateStageRollingBack || journal.From == nil || f.executableDigest() != journal.From.SHA256 {
		t.Fatalf("the journal of a rollback that can't start the previous build: %+v (found %v)", journal, found)
	}
	return f, machine, mac, release, oldDigest
}

// With the definition there, the removal ends the rollback through the macOS host's own locator,
// which reads it: every other test of the removal reads the fake's.
func TestTheRemovalEndsARollbackThatCanNeverStartThePreviousBuildThroughTheMacOSLocatorWhenTheDefinitionIsThere(t *testing.T) {
	f, _, _, _ := heldRollback(t)
	host := updateHostOverride.(*launchdHost)
	if executable, err := host.mac.AgentExecutable(); err != nil || executable != f.exe {
		t.Fatalf("the macOS host's locator: %q, %v, want %q", executable, err, f.exe)
	}
	updateHostOverride = &macOSLocatorHost{host}

	if err := RemoveUpdateHelper(); err != nil {
		t.Fatalf("removing the step while the rollback waits for a start that never comes: %v", err)
	}
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
}

// The definition of the agent's job was removed by hand: the removal and turning updates off don't
// end the rollback, refuse with words that say the agent's service isn't registered, and change
// nothing. `vectory service-install` writes the definition again (nothing about an open rollback
// stands in its way: it takes the state directory's lifecycle guard and writes a file, and never
// reads the step's journal), and the step's next run finishes the rollback itself.
func TestARollbackWhoseAgentDefinitionWasRemovedByHandIsRefusedWithWordsThatSayWhatToRunAndTheStepFinishesItOnceTheServiceIsRegistered(t *testing.T) {
	f, machine, mac, release, oldDigest := heldRollbackWithoutItsDefinition(t)
	definition := mac.agent.definition
	host := updateHostOverride.(*launchdHost)
	updateHostOverride = &macOSLocatorHost{host}

	if _, err := host.mac.AgentExecutable(); !errors.Is(err, errAgentNotRegistered) {
		t.Fatalf("the macOS host's locator for a definition that is gone: %v", err)
	}
	requireTheRegistrationRefusal(t, f, definition+" doesn't exist")

	// What `vectory service-install` writes.
	plist, err := launchdPlist(f.exe, f.stateDir, "_vectory")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(definition, []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(30 * time.Second)
	f.anotherStepProcess(machine)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if service := f.service(); service.Version != "0.1.0" || service.State != "active" {
		t.Errorf("the host after the step finished the rollback: %+v", service)
	}
}

// A definition that is there and can't be read as the one setup writes isn't one that registering
// the service again puts right, and the words say what was found and name no command.
func TestARollbackWhoseAgentDefinitionCantBeReadIsRefusedWithWordsThatNameNoCommand(t *testing.T) {
	f, _, mac, _, _ := heldRollbackWithoutItsDefinition(t)
	host := updateHostOverride.(*launchdHost)
	updateHostOverride = &macOSLocatorHost{host}
	if err := os.WriteFile(mac.agent.definition, []byte("not a property list"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := RemoveUpdateHelper()
	var busy *UpdateBusyError
	if !errors.As(err, &busy) {
		t.Fatalf("removing the step: %v", err)
	}
	for _, want := range []string{"an update is being rolled back on this host, and the update step can't read the registration of the agent's service (", "so it can't start the previous build. Put the registration right; the update step then finishes the rollback by itself"} {
		if !strings.Contains(busy.Message, want) {
			t.Errorf("the words don't say %q: %s", want, busy.Message)
		}
	}
	if strings.Contains(busy.Message, "service-install") || errors.Is(err, errAgentNotRegistered) {
		t.Errorf("the words name the command for a registration that is gone, and this one is there: %s", busy.Message)
	}
	if _, statErr := os.Lstat(f.paths.StepDir); statErr != nil {
		t.Error("the step's directory was removed")
	}
}
