package agent

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

// The release gate (update_gate.go) is the same on every platform, so these tests
// run everywhere: a platform whose step isn't in the release has no host, and a
// host-less build refuses consent and says so. What each platform's own gate is set
// to is tested beside its host.

type stubUpdateHost struct{ updateHost }

func useNoUpdateHost(t *testing.T) {
	t.Helper()
	old := updateHostOverride
	updateHostOverride = noUpdateHost{}
	t.Cleanup(func() { updateHostOverride = old })
}

func TestAClosedGateBuildsNoHostAndAnOpenOneBuildsIt(t *testing.T) {
	built := 0
	newHost := func() updateHost {
		built++
		return stubUpdateHost{}
	}
	if host := gatedUpdateHost(false, newHost); host != nil || built != 0 {
		t.Fatalf("a closed gate gave %v after building %d hosts", host, built)
	}
	if host := gatedUpdateHost(true, newHost); host == nil || built != 1 {
		t.Fatalf("an open gate gave %v after building %d hosts", host, built)
	}
}

func TestAnOverrideThatStandsForNoHostIsNoHost(t *testing.T) {
	useNoUpdateHost(t)
	if host := currentUpdateHost(); host != nil {
		t.Fatalf("the host is %v, and a platform with no step has none", host)
	}
	updateHostOverride = stubUpdateHost{}
	if host := currentUpdateHost(); host == nil {
		t.Fatal("a real override was taken for no host")
	}
}

// Where the step isn't in the release, nothing is installed, applied or run, the
// host says why it can't be updated, and there is nothing to remove.
func TestWhereTheStepIsNotInTheReleaseEveryFunctionOfItSaysSo(t *testing.T) {
	useNoUpdateHost(t)
	dir := t.TempDir()
	if got := UpdateEligibility(dir); got != "PLATFORM_NOT_IN_RELEASE" {
		t.Errorf("UpdateEligibility is %q, want PLATFORM_NOT_IN_RELEASE", got)
	}
	for name, err := range map[string]error{
		"InstallUpdateHelper": InstallUpdateHelper(dir, filepath.Join(dir, "vectory")),
		"ApplyStagedUpdate":   ApplyStagedUpdate(context.Background(), dir, false, nil),
		"RunUpdateHelper":     RunUpdateHelper(context.Background(), dir),
	} {
		if !errors.Is(err, errUpdateStepUnavailable) {
			t.Errorf("%s: %v, want the answer that this build has no step for the platform", name, err)
		}
	}
	if err := RemoveUpdateHelper(); err != nil {
		t.Errorf("RemoveUpdateHelper: %v; a host with no step has nothing to remove", err)
	}
}

// Setup refuses consent before it changes anything, with the sentence the
// platform's hosts are told, naming the platform.
func TestSetupRefusesConsentWhereTheStepIsNotInTheRelease(t *testing.T) {
	useNoUpdateHost(t)
	dir := t.TempDir()
	for _, goos := range []string{"windows", "darwin", "linux"} {
		for _, consent := range []string{UpdateConsentAuto, UpdateConsentAsk} {
			r := &setupRun{host: serviceHost{}}
			err := r.preflightUpdates(&updatePlan{consent: consent}, serviceChoice{kind: "windows"}, PlatformInfo{OS: goos, Arch: "amd64"}, filepath.Join(dir, "vectory"), dir)
			var failure *SetupError
			if !errors.As(err, &failure) {
				t.Fatalf("%s %s: %v, want a refusal", goos, consent, err)
			}
			want := "Agent updates aren't in this release for " + platformName(goos) + ". Hosts of this kind update by hand in this release."
			if failure.Step.ID != "updates" || failure.Step.Detail != want || failure.Step.Fix == "" {
				t.Errorf("%s %s: %+v, want the detail %q and a fix", goos, consent, failure.Step, want)
			}
		}
	}
}
