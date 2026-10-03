//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAGoodReleaseIsStagedSwappedTrialledAndCommitted(t *testing.T) {
	f := newStepFixture(t)
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)

	f.mustRun()

	journal, found := f.journal()
	if !found || journal.Stage != updateJournalCommitted || journal.Release != release.manifestSHA() || journal.Counter != 7 ||
		journal.From.SHA256 != oldDigest || journal.To.SHA256 != release.buildSHA() || journal.To.Version != "0.1.1" || journal.Code != "" ||
		len(journal.Signers) != 1 || journal.Signers[0] != f.public.Fingerprint() || journal.Interruptions != 0 || journal.BootIDBefore == "" {
		t.Fatalf("the journal after a commit: %+v (found %v)", journal, found)
	}
	if got := f.executableDigest(); got != release.buildSHA() {
		t.Fatalf("the executable is %s, want the new build %s", got, release.buildSHA())
	}
	if got := fileDigest(t, filepath.Join(f.installDir, ".vectory-previous")); got != oldDigest {
		t.Errorf("the previous build kept beside the executable is %s, want %s", got, oldDigest)
	}
	if beside := f.beside(); len(beside) != 1 || beside[0] != ".vectory-previous" {
		t.Errorf("files beside the executable: %v", beside)
	}
	if record := f.installedRecord(); record.Version != "0.1.1" || record.SHA256 != release.buildSHA() || record.Release != release.manifestSHA() {
		t.Errorf("installed.json: %+v", record)
	}
	if floors := f.counters().HighestCounters; len(floors) != 1 || floors[f.public.Fingerprint()] != 7 {
		t.Errorf("the floors: %v", floors)
	}
	status := f.status()
	if status.Stage != UpdateStageIdle || status.Eligibility != UpdateEligible || status.Release != "" || status.Last == nil ||
		status.Last.Outcome != UpdateOutcomeCommitted || status.Last.Release != release.manifestSHA() || status.Last.Code != "" ||
		status.Last.FromVersion != "0.1.0" || status.Last.ToVersion != "0.1.1" || status.Last.FirstCheckInMS == nil || *status.Last.FirstCheckInMS != 3000 ||
		status.HighestCounters[f.public.Fingerprint()] != 7 || status.ServiceDefinition != updateServiceDefinition {
		t.Errorf("status.json: %+v last %+v", status, status.Last)
	}
	if got := fileDigest(t, f.paths.HelperExecutable); got != release.buildSHA() {
		t.Errorf("the helper copy is %s, want the build that committed", got)
	}
	if !f.stagingEmpty() {
		t.Error("the staging directory still holds the request's files")
	}
	if entries, _ := os.ReadDir(f.paths.Probe); len(entries) != 0 {
		t.Errorf("the probe directory holds %d files", len(entries))
	}
	service := f.service()
	if want := []string{"start 0.1.0", "stop", "start 0.1.1"}; len(service.History) != len(want) || service.History[1] != "stop" || service.History[2] != "start 0.1.1" {
		t.Errorf("the service's history: %v", service.History)
	}
	if len(f.host.probeCalls) != 1 || filepath.Dir(f.host.probeCalls[0]) != f.paths.Probe {
		t.Errorf("the probe ran from %v, which isn't the probe directory %s", f.host.probeCalls, f.paths.Probe)
	}
	// The next run is idle and changes nothing: the request is the committed one.
	before := f.executableDigest()
	f.clock.advance(30 * time.Second)
	f.mustRun()
	if f.executableDigest() != before || f.status().Last.Outcome != UpdateOutcomeCommitted {
		t.Error("an idle run after the commit changed something")
	}
}
