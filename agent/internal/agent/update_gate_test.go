package agent

import (
	"context"
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The gate: an operating system ships agent updates only while its line in
// update_gate.go says so, and one that doesn't has no step, says so in every place a
// person or the server can ask, and refuses --updates in setup with nothing changed.
// The tests close the gate for the system they run on, so that the refusal is shown
// on each of them: the one-line decision at the cut is never a weaker mechanism, only
// this.

// closeUpdateGate makes this build ship updates on no operating system, until the
// test ends, and leaves no host in place of the platform's.
func closeUpdateGate(t *testing.T) {
	t.Helper()
	oldGate, oldHost := updateGateOverride, updateHostOverride
	updateGateOverride, updateHostOverride = func(string) bool { return false }, nil
	t.Cleanup(func() { updateGateOverride, updateHostOverride = oldGate, oldHost })
}

func TestTheGateShipsTheSystemsItsLinesSayAndNoOtherSystem(t *testing.T) {
	for goos, want := range map[string]bool{
		"linux": linuxUpdatesInRelease, "darwin": macosUpdatesInRelease, "windows": windowsUpdatesInRelease,
		"freebsd": false, "openbsd": false, "plan9": false, "": false,
	} {
		if got := updatesInRelease(goos); got != want {
			t.Errorf("%q: %v, want %v", goos, got, want)
		}
	}
	// Linux must ship.
	if !linuxUpdatesInRelease {
		t.Error("Linux doesn't ship agent updates")
	}
	// An operating system the gate ships and that has a step has a host, and the others
	// have none.
	updateHostOverride = nil
	hasStep := runtime.GOOS == "linux" || runtime.GOOS == "darwin" || runtime.GOOS == "windows"
	if shipped := updatesInRelease(runtime.GOOS) && hasStep; (currentUpdateHost() != nil) != shipped {
		t.Errorf("%s: a host is %v, and the gate and the step say %v", runtime.GOOS, currentUpdateHost() != nil, shipped)
	}
}

// inertHost stands for the operating system's host on a machine the step was never
// installed on: removal asks it for the step's units and it has none. Any other call is
// a mistake of the test, and panics.
type inertHost struct {
	updateHost
	removals int
}

func (h *inertHost) RemoveUnits() (string, bool, error) {
	h.removals++
	return "", false, nil
}

func TestAnOperatingSystemOutsideTheReleaseHasNoStepAndEveryFunctionOfTheStepSaysSo(t *testing.T) {
	closeUpdateGate(t)
	paths := useUpdateRoots(t)
	// Removal is the one function that asks the operating system's host whatever the gate
	// says, and this is a host with nothing installed, so that the test touches nothing
	// of the machine it runs on.
	inert := &inertHost{}
	updateHostOverride = inert
	if currentUpdateHost() != nil {
		t.Fatal("a build that ships nothing has a host")
	}
	if got := UpdateEligibility(t.TempDir()); got != "PLATFORM_NOT_IN_RELEASE" {
		t.Errorf("the eligibility is %q", got)
	}
	exe, dir := os.Args[0], t.TempDir()
	if err := InstallUpdateHelper(dir, exe); !errors.Is(err, errUpdateStepUnavailable) {
		t.Errorf("installing the step: %v", err)
	}
	if err := RunUpdateHelper(context.Background(), dir); !errors.Is(err, errUpdateStepUnavailable) {
		t.Errorf("a run of the step: %v", err)
	}
	if err := ApplyStagedUpdate(context.Background(), dir, true, func(string) {}); !errors.Is(err, errUpdateStepUnavailable) {
		t.Errorf("applying a staged update: %v", err)
	}
	// There is no step to remove, and removing it changes nothing. The gate
	// prevents any concurrent installer while the cleanup checks host units.
	if err := RemoveUpdateHelper(); err != nil {
		t.Errorf("removing the step: %v", err)
	}
	if inert.removals != 1 {
		t.Errorf("removal asked the host for the step's units %d times, want once: the gate doesn't decide it", inert.removals)
	}
	for _, path := range []string{paths.StepDir, paths.PolicyDir} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Errorf("%s exists: %v", path, err)
		}
	}
}

func TestAHostWhoseOperatingSystemIsOutsideTheReleaseReportsItAndTheCommandsSayThatItUpdatesByHand(t *testing.T) {
	closeUpdateGate(t)
	useUpdateRoots(t)
	view := readUpdateView(realTempDir(t), time.Now(), UpdateEligibility)
	if view.Eligibility != "PLATFORM_NOT_IN_RELEASE" {
		t.Fatalf("the view says %q", view.Eligibility)
	}
	if want := "not in this release for " + platformName(runtime.GOOS) + ": hosts of this kind update by hand"; view.Headline() != want {
		t.Errorf("the headline is %q, want %q", view.Headline(), want)
	}
	if words := updateEligibilityWords("PLATFORM_NOT_IN_RELEASE"); !strings.Contains(words, "update by hand") || !strings.Contains(words, platformName(runtime.GOOS)) {
		t.Errorf("the words of the code: %q", words)
	}
}

func TestSetupRefusesConsentWhereTheBuildShipsNoUpdatesAndChangesNothing(t *testing.T) {
	closeUpdateGate(t)
	f := newConsentFixture(t)
	f.host.eligibility = nil // setup asks the build's own answer
	f.consent(UpdateConsentAuto, f.key)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" {
		t.Fatalf("%v", err)
	}
	want := "Agent updates aren't in this release for " + platformName(runtime.GOOS) + ". Hosts of this kind update by hand in this release."
	if failed.Step.Detail != want || failed.Step.Fix != "Leave out --updates, and upgrade this host with the Upgrade agent command when a new agent is out." {
		t.Errorf("detail %q\nfix %q", failed.Step.Detail, failed.Step.Fix)
	}
	f.events = nil
	f.untouched()
}

// Leaving the flags out is setup as it has always been, on every system.
func TestSetupWithoutUpdateFlagsIsTheSameWhereTheBuildShipsNoUpdates(t *testing.T) {
	closeUpdateGate(t)
	f := newConsentFixture(t)
	f.host.eligibility = nil
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if result.Updates != nil || stepStatus(result, "updates") != "" {
		t.Errorf("updates were mentioned: %+v", result.Steps)
	}
	for _, path := range []string{f.paths.PolicyDir, f.paths.StepDir} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Errorf("%s exists", path)
		}
	}
}
