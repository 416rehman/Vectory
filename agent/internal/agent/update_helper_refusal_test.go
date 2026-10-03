//go:build !windows

package agent

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// What a host is, as the tests compare it before and after a request: the
// executable, the policy, the floors, the installed record, the files beside the
// executable and what the service manager was told.
type machineSnapshot struct {
	executable string
	policy     []byte
	counters   []byte
	installed  []byte
	beside     []string
	history    []string
}

func (f *stepFixture) snapshot() machineSnapshot {
	f.t.Helper()
	read := func(path string) []byte {
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			f.t.Fatal(err)
		}
		return data
	}
	return machineSnapshot{
		executable: f.executableDigest(), policy: read(f.paths.Policy), counters: read(f.paths.Counters), installed: read(f.paths.Installed),
		beside: f.beside(), history: append([]string(nil), f.service().History...),
	}
}

func (f *stepFixture) requireUnchanged(before machineSnapshot, ignore ...string) {
	f.t.Helper()
	after := f.snapshot()
	skip := func(what string) bool {
		for _, name := range ignore {
			if name == what {
				return true
			}
		}
		return false
	}
	switch {
	case after.executable != before.executable:
		f.t.Errorf("the executable changed: %s, was %s", after.executable, before.executable)
	case !bytes.Equal(after.policy, before.policy):
		f.t.Errorf("the policy changed:\n%s\nwas\n%s", after.policy, before.policy)
	case !skip("counters") && !bytes.Equal(after.counters, before.counters):
		f.t.Errorf("the floors changed:\n%s\nwas\n%s", after.counters, before.counters)
	case !skip("installed") && !bytes.Equal(after.installed, before.installed):
		f.t.Errorf("installed.json changed:\n%s\nwas\n%s", after.installed, before.installed)
	case strings.Join(after.beside, ",") != strings.Join(before.beside, ","):
		f.t.Errorf("the files beside the executable changed: %v, were %v", after.beside, before.beside)
	case strings.Join(after.history, ",") != strings.Join(before.history, ","):
		f.t.Errorf("the service was touched: %v, was %v", after.history, before.history)
	}
	if journal, found := f.journal(); found {
		f.t.Errorf("a journal is left: %+v", journal)
	}
	if !f.stagingEmpty() {
		f.t.Error("the staging directory isn't empty")
	}
	if entries, _ := os.ReadDir(f.paths.Probe); len(entries) != 0 {
		f.t.Errorf("the probe directory holds %d files", len(entries))
	}
}

// requireAnswered says the step answered the release with this result.
func (f *stepFixture) requireAnswered(release *fakeRelease, outcome, code string) {
	f.t.Helper()
	status := f.status()
	if status.Last == nil || status.Last.Release != release.manifestSHA() || status.Last.Outcome != outcome || status.Last.Code != code || status.Stage != UpdateStageIdle {
		f.t.Fatalf("the result is %+v (stage %s), want %s %s for %s", status.Last, status.Stage, outcome, code, release.manifestSHA()[:12])
	}
}

// ---------------------------------------------------------------- the offer

type refusalCase struct {
	name string
	code string
	// stage stages the offer and returns the release the request names.
	stage func(f *stepFixture) *fakeRelease
	// counters says the floors or the fork are expected to change.
	changesCounters bool
}

func plainRelease(version string, options releaseOptions) func(f *stepFixture) *fakeRelease {
	return func(f *stepFixture) *fakeRelease {
		release := f.newRelease(version, "good", options)
		f.stage(release)
		return release
	}
}

func TestEveryRefusalOfAnOfferLeavesTheHostAsItWas(t *testing.T) {
	other := testPrivateKey(t, 21)
	otherKey := testPublicKey(t, other, "someone else")
	cases := []refusalCase{
		{name: "a signature of a key the host doesn't pin", code: "KEY_NOT_PINNED", stage: plainRelease("0.1.1", releaseOptions{signer: &other, signerKey: &otherKey})},
		{name: "a manifest with one flipped byte", code: "SIGNATURE_INVALID", stage: func(f *stepFixture) *fakeRelease {
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			release.manifest[40] ^= 1
			f.stage(release)
			return release
		}},
		{name: "a counter at the floor", code: "COUNTER_REPLAYED", stage: func(f *stepFixture) *fakeRelease {
			f.setFloor(7)
			release := f.newRelease("0.1.1", "good", releaseOptions{counter: 7})
			f.stage(release)
			return release
		}},
		{name: "a counter below the floor", code: "COUNTER_REPLAYED", stage: func(f *stepFixture) *fakeRelease {
			f.setFloor(7)
			release := f.newRelease("0.1.1", "good", releaseOptions{counter: 5})
			f.stage(release)
			return release
		}},
		{name: "an expired manifest", code: "MANIFEST_EXPIRED", stage: plainRelease("0.1.1", releaseOptions{issued: fixtureStart.Add(-48 * time.Hour), expires: fixtureStart.Add(-time.Hour)})},
		{name: "a manifest issued a day ahead of the clock", code: "MANIFEST_INVALID", stage: plainRelease("0.1.1", releaseOptions{issued: fixtureStart.Add(25 * time.Hour), expires: fixtureStart.Add(24 * 24 * time.Hour)})},
		{name: "the build of another platform", code: "PLATFORM_NOT_IN_RELEASE", stage: plainRelease("0.1.1", releaseOptions{mutate: func(m *ReleaseManifest) {
			m.Artifacts[0].OS, m.Artifacts[0].Arch, m.Artifacts[0].File = "windows", "amd64", "vectory-0.1.1-windows-amd64.exe"
		}})},
		{name: "a request that names another build than the manifest does", code: "ARTIFACT_MISMATCH", stage: func(f *stepFixture) *fakeRelease {
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			f.request(release.manifestSHA(), digestOf([]byte("another build")), f.clock.Now())
			return release
		}},
		{name: "a manifest that disagrees with the build about its size", code: "ARTIFACT_MISMATCH", stage: plainRelease("0.1.1", releaseOptions{mutate: func(m *ReleaseManifest) { m.Artifacts[0].Size++ }})},
		{name: "a manifest that disagrees with the build about its digest", code: "ARTIFACT_MISMATCH", stage: plainRelease("0.1.1", releaseOptions{mutate: func(m *ReleaseManifest) { m.Artifacts[0].SHA256 = digestOf([]byte("not this")) }})},
		{name: "the version the host runs", code: "ALREADY_RUNNING", stage: plainRelease("0.1.0", releaseOptions{})},
		{name: "an older version", code: "DOWNGRADE_REFUSED", stage: func(f *stepFixture) *fakeRelease {
			f.installBuild(fakeBuild("0.1.5", "good", "newer"))
			f.recordInstalled("0.1.5")
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			return release
		}},
		{name: "a minor release on the patch track", code: "VERSION_NOT_ON_TRACK", stage: plainRelease("0.2.0", releaseOptions{})},
		{name: "a release the running version is too old for", code: "AGENT_TOO_OLD", stage: plainRelease("0.1.1", releaseOptions{minFrom: "0.1.1"})},
		{name: "a release that needs a newer service definition", code: "SERVICE_DEFINITION_OUTDATED", stage: plainRelease("0.1.1", releaseOptions{mutate: func(m *ReleaseManifest) { m.ServiceDefinition = 2 }})},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newStepFixture(t)
			release := c.stage(f)
			before := f.snapshot()
			f.mustRun()
			outcome := outcomeOf(c.code, true)
			f.requireAnswered(release, outcome, c.code)
			f.requireUnchanged(before)
			if got := f.status().Last; got.FromVersion == "" {
				t.Errorf("the result doesn't say the version the host ran: %+v", got)
			}
		})
	}
}

func TestARequestForAReleaseThatIsNotStagedIsLeftUnanswered(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	// The request names another manifest than the one that is staged: the agent
	// withdrew the offer (or never staged what it names), and says so itself.
	f.request(digestOf([]byte("another manifest")), release.buildSHA(), f.clock.Now())
	before := f.snapshot()
	f.mustRun()
	if status := f.status(); status.Last != nil || status.Stage != UpdateStageIdle {
		t.Fatalf("a request for what isn't staged was answered: %+v", status)
	}
	f.requireUnchanged(before)
}

// setFloor puts a counter floor for the pinned key in counters.json, as an earlier
// attempt left it.
func (f *stepFixture) setFloor(counter uint64) {
	f.t.Helper()
	private, err := openRootOwned(f.paths.Private, rootOwnedDirectory)
	if err != nil {
		f.t.Fatal(err)
	}
	defer private.Close()
	if err := writeUpdateCounters(private, updateCounters{HighestCounters: map[string]uint64{f.public.Fingerprint(): counter}}); err != nil {
		f.t.Fatal(err)
	}
}

func TestARefusedOfferIsAnsweredOnceAndTheAnsweredRequestIsNotAnsweredAgain(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.0", "good", releaseOptions{})
	f.stage(release)
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeRefused, "ALREADY_RUNNING")
	answered := f.status().Last.At
	// The agent hasn't cleared the request yet. A later run leaves it alone, and the
	// result stays what it was.
	f.clock.advance(30 * time.Second)
	f.mustRun()
	if got := f.status().Last; !got.At.Equal(answered) {
		t.Errorf("the request was answered again at %s", got.At)
	}
	// The agent writes a new request for the same release: a new question.
	f.clock.advance(time.Minute)
	f.request(release.manifestSHA(), release.buildSHA(), f.clock.Now())
	f.mustRun()
	if got := f.status().Last; !got.At.After(answered) {
		t.Errorf("a request written again wasn't answered: %s", got.At)
	}
}

// ---------------------------------------------------------------- consent

func TestWithoutConsentARequestIsRefusedAndNothingHappens(t *testing.T) {
	for name, c := range map[string]struct {
		setup func(f *stepFixture)
		code  string
	}{
		"consent off":                              {func(f *stepFixture) { f.setPolicy(func(p *UpdatePolicy) { p.Consent, p.Keys = UpdateConsentOff, nil }) }, "UPDATES_OFF"},
		"no policy file":                           {func(f *stepFixture) { _ = os.Remove(f.paths.Policy) }, "UPDATES_OFF"},
		"a policy that is paused":                  {func(f *stepFixture) { f.setPolicy(func(p *UpdatePolicy) { p.Paused = true }) }, "UPDATES_PAUSED"},
		"a policy that is damaged":                 {func(f *stepFixture) { _ = os.WriteFile(f.paths.Policy, []byte("{"), 0o644) }, "UPDATES_OFF"},
		"a policy directory that others can write": {func(f *stepFixture) { _ = os.Chmod(f.paths.PolicyDir, 0o775) }, "UNTRUSTED_LOCATION"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			c.setup(f)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeRefused, c.code)
			f.requireUnchanged(before)
		})
	}
}

func TestAnAskHostWaitsForAPersonAndApplyAppliesWhatWaits(t *testing.T) {
	f := newStepFixture(t)
	f.setPolicy(func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk })
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	before := f.snapshot()
	for i := 0; i < 3; i++ {
		f.clock.advance(30 * time.Second)
		f.mustRun()
	}
	if status := f.status(); status.Last != nil || status.Stage != UpdateStageIdle || status.Eligibility != UpdateEligible {
		t.Fatalf("an ask host that waits: %+v", status)
	}
	if after := f.snapshot(); after.executable != before.executable || len(after.history) != len(before.history) {
		t.Fatal("the timer's run changed an ask host")
	}
	var said []string
	if err := ApplyStagedUpdate(bg(), f.stateDir, false, func(line string) { said = append(said, line) }); err != nil {
		t.Fatal(err)
	}
	if f.executableDigest() != release.buildSHA() || f.status().Last.Outcome != UpdateOutcomeCommitted {
		t.Fatalf("apply didn't commit: %+v", f.status().Last)
	}
	if len(said) < 4 {
		t.Errorf("apply said little: %v", said)
	}
}

func TestApplyWithNothingStagedOrAPausedHostSaysSo(t *testing.T) {
	f := newStepFixture(t)
	if err := ApplyStagedUpdate(bg(), f.stateDir, false, nil); err == nil || !strings.Contains(err.Error(), "no update is staged") {
		t.Errorf("nothing staged: %v", err)
	}
	f.setPolicy(func(p *UpdatePolicy) { p.Paused = true })
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	if err := ApplyStagedUpdate(bg(), f.stateDir, true, nil); err != nil {
		t.Fatal(err)
	}
	f.requireAnswered(release, UpdateOutcomeRefused, "UPDATES_PAUSED")
	if f.executableDigest() == release.buildSHA() {
		t.Error("a paused host applied an update because a person asked")
	}
}

func TestAnAutomaticHostWithAWindowAppliesOnlyWhileOneIsOpen(t *testing.T) {
	f := newStepFixture(t)
	// The fixture's clock is 02:00 UTC; a UTC window for 03:00 to 04:00 is closed.
	f.setPolicy(func(p *UpdatePolicy) { p.Windows = []string{"daily 03:00-04:00 UTC"} })
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	before := f.snapshot()
	f.mustRun()
	if f.status().Last != nil {
		t.Fatalf("a closed window answered the request: %+v", f.status().Last)
	}
	if after := f.snapshot(); after.executable != before.executable || len(after.history) != len(before.history) {
		t.Fatal("the step changed the host outside the window")
	}
	f.clock.advance(70 * time.Minute) // 03:10
	f.request(release.manifestSHA(), release.buildSHA(), f.clock.Now())
	f.mustRun()
	if f.executableDigest() != release.buildSHA() {
		t.Fatalf("the window was open and nothing was applied: %+v", f.status().Last)
	}
}

func TestATrialThatStartedInAWindowMayEndAfterIt(t *testing.T) {
	f := newStepFixture(t)
	f.setPolicy(func(p *UpdatePolicy) { p.Windows = []string{"daily 01:59-02:01 UTC"} })
	release := f.newRelease("0.1.1", "slow", releaseOptions{})
	f.stage(release)
	f.mustRun()
	// The window closed a second after the start and the trial ran for minutes: the
	// build never checked in within them, and the step decided that at its deadline
	// and not at the window's end.
	if status := f.status(); status.Last == nil || status.Last.Code != "NO_CHECK_IN" || status.Last.Outcome != UpdateOutcomeRolledBack {
		t.Fatalf("a trial that outlasted its window: %+v", status.Last)
	}
}

// ---------------------------------------------------------------- what can't be updated

func TestAHostThatCantBeUpdatedSaysWhyAndTouchesNothing(t *testing.T) {
	for name, c := range map[string]struct {
		setup func(f *stepFixture)
		code  string
	}{
		"managed by a package":                  {func(f *stepFixture) { f.host.cfg.Packaged = true }, "PACKAGE_MANAGED"},
		"read-only":                             {func(f *stepFixture) { f.host.cfg.ReadOnly = true }, "READ_ONLY"},
		"an install directory others can write": {func(f *stepFixture) { _ = os.Chmod(f.installDir, 0o775) }, "UNTRUSTED_LOCATION"},
		"a service that runs as root":           {func(f *stepFixture) { f.host.account.UID = 0 }, "NO_SERVICE"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			c.setup(f)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			before := f.snapshot()
			f.mustRun()
			status := f.status()
			if status.Eligibility != c.code || status.Last != nil || status.Stage != UpdateStageIdle {
				t.Fatalf("status: %+v", status)
			}
			if after := f.snapshot(); after.executable != before.executable || len(after.history) != len(before.history) {
				t.Fatal("the step changed a host that can't be updated")
			}
			// The request is left where it is: nothing on this host reads it.
			if _, err := os.Stat(UpdateExchangeFor(f.stateDir).Request); err != nil {
				t.Errorf("the request was taken: %v", err)
			}
			if err := ApplyStagedUpdate(bg(), f.stateDir, false, nil); err == nil || !strings.Contains(err.Error(), c.code) {
				t.Errorf("apply on a host that can't be updated: %v", err)
			}
		})
	}
}

func TestAnInstallDirectoryThatIsASymbolicLinkIsRefused(t *testing.T) {
	f := newStepFixture(t)
	real := filepath.Join(f.root, "usr", "local", "real-bin")
	if err := os.Rename(f.installDir, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, f.installDir); err != nil {
		t.Fatal(err)
	}
	f.mustRun()
	if got := f.status().Eligibility; got != "UNTRUSTED_LOCATION" {
		t.Fatalf("an install directory that is a link: %s", got)
	}
}

func TestTheStepWritesWhatItsStatusSaysEveryRun(t *testing.T) {
	f := newStepFixture(t)
	f.mustRun()
	first := f.status()
	if first.RunAt != f.clock.Now() || first.Stage != UpdateStageIdle || first.Eligibility != UpdateEligible || first.Last != nil {
		t.Fatalf("an idle host: %+v", first)
	}
	f.clock.advance(30 * time.Second)
	f.mustRun()
	if second := f.status(); !second.RunAt.After(first.RunAt) {
		t.Errorf("status.json says it ran at %s, then at %s", first.RunAt, second.RunAt)
	}
	info, err := os.Stat(f.paths.Status)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("status.json: %v, %v", info, err)
	}
}

func TestNoPlatformMeansNoStep(t *testing.T) {
	updateHostOverride = nil
	t.Cleanup(func() { updateHostOverride = nil })
	if runtime.GOOS == "linux" {
		return // Linux has a host: the others say there is no step.
	}
	if err := RunUpdateHelper(bg(), "/var/lib/vectory-agent"); err != errUpdateStepUnavailable {
		t.Errorf("a platform with no step: %v", err)
	}
}
