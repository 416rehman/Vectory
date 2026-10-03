//go:build !windows

package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The gate says which operating systems this build ships updates on, and so what it may
// start. It never says what the build may leave behind: a host that an earlier build
// installed the step on keeps a root launch daemon or timer that runs it, and a build
// whose gate is closed must still take that away, on `update off` and on uninstall. The
// host here is the fixture's, the one an earlier build installed the step with, and the
// gate is closed over it.

// closeUpdateGateKeepingTheHost makes this build ship updates on no operating system,
// and leaves the test's host in place: the machine is one the step was installed on.
func closeUpdateGateKeepingTheHost(t *testing.T) {
	t.Helper()
	old := updateGateOverride
	updateGateOverride = func(string) bool { return false }
	t.Cleanup(func() { updateGateOverride = old })
}

// hostWithAStepOfAnEarlierBuild is a host the step was installed on, and what an update
// of it left beside the executable.
func hostWithAStepOfAnEarlierBuild(t *testing.T) *stepFixture {
	t.Helper()
	f := freshHost(t)
	if err := InstallUpdateHelper(f.stateDir, f.exe); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{updatePreviousName, updatePreviousName + ".new", "vectory-keep"} {
		if err := os.WriteFile(filepath.Join(f.installDir, name), []byte(name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func TestAClosedGateStartsNothingAndStillHasAHostToTakeTheStepAway(t *testing.T) {
	f := hostWithAStepOfAnEarlierBuild(t)
	closeUpdateGateKeepingTheHost(t)

	if currentUpdateHost() != nil {
		t.Error("a build that ships no updates here has a host for the step")
	}
	if removalUpdateHost() != updateHostOverride {
		t.Error("removal doesn't use the host the step was installed with")
	}
	if got := UpdateEligibility(f.stateDir); got != "PLATFORM_NOT_IN_RELEASE" {
		t.Errorf("the eligibility is %q", got)
	}
	if err := InstallUpdateHelper(f.stateDir, f.exe); !errors.Is(err, errUpdateStepUnavailable) {
		t.Errorf("installing the step: %v", err)
	}
	if err := RunUpdateHelper(bg(), f.stateDir); !errors.Is(err, errUpdateStepUnavailable) {
		t.Errorf("a run of the step: %v", err)
	}
}

// What uninstall does first, and what `update off` does when the step is there.
func TestRemovingTheStepOnABuildWhoseGateIsClosedTakesAwayWhatAnEarlierBuildInstalled(t *testing.T) {
	f := hostWithAStepOfAnEarlierBuild(t)
	closeUpdateGateKeepingTheHost(t)
	executable := f.executableDigest()

	if err := RemoveUpdateHelper(); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step's directory is still there")
	}
	if last := f.host.unitsCalls[len(f.host.unitsCalls)-1]; last != "remove" {
		t.Errorf("the units weren't taken away: %v", f.host.unitsCalls)
	}
	if got := f.beside(); strings.Join(got, ",") != "vectory-keep" {
		t.Errorf("beside the executable: %v", got)
	}
	if f.executableDigest() != executable {
		t.Error("the executable changed")
	}
	if err := RemoveUpdateHelper(); err != nil {
		t.Errorf("removing what is already gone: %v", err)
	}
}

func TestUpdateOffOnABuildWhoseGateIsClosedRemovesTheStepAndSaysSoOnlyBecauseItIsGone(t *testing.T) {
	f := hostWithAStepOfAnEarlierBuild(t)
	closeUpdateGateKeepingTheHost(t)

	done, err := WithdrawUpdates(f.stateDir)

	if err != nil {
		t.Fatal(err)
	}
	if !done.PolicyOff || !done.StepRemoved {
		t.Errorf("%+v", done)
	}
	if _, err := os.Lstat(f.paths.StepDir); err == nil {
		t.Error("the step is reported removed and its directory is still there")
	}
	if last := f.host.unitsCalls[len(f.host.unitsCalls)-1]; last != "remove" {
		t.Errorf("the units weren't taken away: %v", f.host.unitsCalls)
	}
	if policy := f.policy(); policy.Consent != UpdateConsentOff {
		t.Errorf("the policy: %+v", policy)
	}
}

// A host the step was never installed on, under a build whose gate is closed: removal
// asks the host once for units it hasn't got, and nothing is said to have been removed.
func TestUpdateOffOnABuildWhoseGateIsClosedOnAHostWithNoStepRemovesNothingAndClaimsNothing(t *testing.T) {
	f := freshHost(t)
	closeUpdateGateKeepingTheHost(t)

	done, err := WithdrawUpdates(f.stateDir)

	if err != nil {
		t.Fatal(err)
	}
	if done.StepRemoved {
		t.Errorf("a step that was never there is reported removed: %+v", done)
	}
	if err := RemoveUpdateHelper(); err != nil {
		t.Errorf("removing a step that was never installed: %v", err)
	}
	if got := f.host.unitsCalls; len(got) != 1 || got[0] != "remove" {
		t.Errorf("the units: %v", got)
	}
}

// A removal that returned and left the step's directory is one that didn't happen.
func TestAWithdrawalWhoseRemovalLeavesTheStepsDirectoryIsAnErrorAndNeverReportsTheStepRemoved(t *testing.T) {
	root, paths := withdrawalTree(t)
	state := filepath.Join(root, "var", "lib", "vectory-agent")
	mkdirMode(t, state, 0o700)

	done, err := withdrawUpdates(state, func() error { return nil })

	if err == nil || !strings.Contains(err.Error(), paths.StepDir+" is still there") || !strings.Contains(err.Error(), "the step is not removed") {
		t.Fatalf("a removal that left the directory: %v", err)
	}
	if done.StepRemoved {
		t.Errorf("the step is reported removed: %+v", done)
	}
	if !done.PolicyOff {
		t.Errorf("what was done before it isn't reported: %+v", done)
	}
}

// Where no step is written for the operating system there is none to remove. A step's
// directory that is there anyway is said to be out of reach, and a withdrawal says the
// step is removed only when it is gone.
func TestWhereNoStepIsWrittenForTheOperatingSystemItsDirectoryIsOutOfReachAndNeverReportedRemoved(t *testing.T) {
	root, paths := withdrawalTree(t)
	if err := os.RemoveAll(paths.StepDir); err != nil {
		t.Fatal(err)
	}
	if err := removeStepWith(nil); err != nil {
		t.Fatalf("no step directory and no host: %v", err)
	}
	if err := os.MkdirAll(paths.StepDir, 0o755); err != nil {
		t.Fatal(err)
	}

	err := removeStepWith(nil)

	if err == nil || !strings.Contains(err.Error(), "has no update step for this operating system") || !strings.Contains(err.Error(), paths.StepDir) || !strings.Contains(err.Error(), "delete it yourself") {
		t.Fatalf("a step directory with no host: %v", err)
	}
	if _, statErr := os.Lstat(paths.StepDir); statErr != nil {
		t.Errorf("the step's directory was touched: %v", statErr)
	}
	state := filepath.Join(root, "var", "lib", "vectory-agent")
	mkdirMode(t, state, 0o700)
	done, err := withdrawUpdates(state, func() error { return removeStepWith(nil) })
	if err == nil || done.StepRemoved {
		t.Errorf("a withdrawal that couldn't remove the step: %+v, %v", done, err)
	}
}
