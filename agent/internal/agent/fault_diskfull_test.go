package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// applyDevice is a device with a verified old configuration and a signed
// manifest for a new version. Its state and its managed configuration are in
// separate folders, as on a real host, and check-ins go through Poll.
type applyDevice struct {
	e        *Engine
	m        Manifest
	driver   *fakeDriver
	artifact []byte
	managed  string
}

func newApplyDevice(t *testing.T) *applyDevice {
	t.Helper()
	e, m, driver := fixture(t, newConfig)
	managed := filepath.Join(t.TempDir(), "managed.json")
	if err := AtomicWrite(managed, oldConfig); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(e.Settings.ManagedConfig); err != nil {
		t.Fatal(err)
	}
	e.Settings.ManagedConfig = managed
	d := &applyDevice{e: e, m: m, driver: driver, artifact: newConfig, managed: managed}
	attemptPollFixture(t, e, &d.m, &d.artifact)
	return d
}

// journalStage is the stage of the recovery journal on disk, or "" when there
// is none.
func journalStage(t *testing.T, dir string) string {
	t.Helper()
	var j Journal
	err := ReadJSON(filepath.Join(dir, "journal.json"), &j)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatalf("the recovery journal is unreadable: %v", err)
	}
	return j.Stage
}

// requireIntact checks what must hold whatever failed and however far an apply
// got: the managed file is one complete configuration, the last known good
// exists and matches its name, the durable state reads, nothing claims the new
// version applied unless it is fully verified, and no half-written file is left.
func (d *applyDevice) requireIntact(t *testing.T) {
	t.Helper()
	managed, err := os.ReadFile(d.managed)
	if err != nil {
		t.Fatalf("the managed configuration is gone: %v", err)
	}
	switch Digest(managed) {
	case Digest(oldConfig), Digest(newConfig):
	default:
		t.Fatalf("the managed configuration is neither the old nor the new one: %q", managed)
	}
	durable, err := LoadState(d.e.Dir)
	if err != nil {
		t.Fatalf("the durable state is unreadable: %v", err)
	}
	good, err := os.ReadFile(filepath.Join(d.e.Dir, "good-"+durable.LastGoodSHA256+".json"))
	if err != nil || Digest(good) != durable.LastGoodSHA256 {
		t.Fatalf("the last known good %s is lost or damaged: %v", durable.LastGoodSHA256, err)
	}
	if durable.LastGoodSHA256 != Digest(oldConfig) && durable.LastGoodSHA256 != Digest(newConfig) {
		t.Fatalf("the last known good is neither configuration: %s", durable.LastGoodSHA256)
	}
	if durable.ReportedGeneration == d.m.Generation && (durable.LastGoodSHA256 != Digest(newConfig) || Digest(managed) != Digest(newConfig)) {
		t.Fatal("the durable state reports the new version applied without holding it")
	}
	if memory := d.e.State; memory.ReportedGeneration == d.m.Generation {
		if _, err := os.ReadFile(filepath.Join(d.e.Dir, "good-"+Digest(newConfig)+".json")); err != nil || Digest(managed) != Digest(newConfig) {
			t.Fatal("the running state reports the new version applied before it is verified and kept")
		}
	}
	if stage := journalStage(t, d.e.Dir); stage != "" && stage != "prepared" && stage != "written" {
		t.Fatalf("unknown journal stage %q", stage)
	}
	for _, dir := range []string{d.e.Dir, filepath.Dir(d.managed)} {
		if left := leftovers(t, dir); len(left) != 0 {
			t.Fatalf("temporary files left in %s: %v", dir, left)
		}
	}
}

// requireConverged checks a device that applied the new version by itself.
func (d *applyDevice) requireConverged(t *testing.T) {
	t.Helper()
	d.requireIntact(t)
	durable, err := LoadState(d.e.Dir)
	if err != nil {
		t.Fatal(err)
	}
	managed, _ := os.ReadFile(d.managed)
	switch {
	case Digest(managed) != Digest(newConfig):
		t.Fatal("the new version isn't in the managed file")
	case d.e.State.ApplyState != "verified_applied" || d.e.State.Error != nil || d.e.State.FailedGeneration != nil:
		t.Fatalf("not applied: %s %+v", d.e.State.ApplyState, d.e.State.Error)
	case durable.LastGoodSHA256 != Digest(newConfig) || durable.ReportedGeneration != d.m.Generation || durable.ApplyState != "verified_applied":
		t.Fatalf("the durable state doesn't hold the new version: %+v", durable)
	case journalStage(t, d.e.Dir) != "":
		t.Fatal("the recovery journal was left behind")
	case d.driver.starts > 2:
		t.Fatalf("Vector was activated %d times", d.driver.starts)
	}
	if _, err := os.Stat(filepath.Join(d.e.Dir, "good-"+Digest(oldConfig)+".json")); !os.IsNotExist(err) {
		t.Fatal("the superseded last known good was kept")
	}
}

// learnApplyWrites runs an apply with room to write and returns the files
// written, in order, and the position of the managed file among them.
func learnApplyWrites(t *testing.T) (writes []string, managedAt int) {
	t.Helper()
	d := newApplyDevice(t)
	record := fillDisk(t, 0, "")
	defer record.remove()
	if err := d.e.Poll(context.Background()); err != nil {
		t.Fatalf("an apply with room to write failed: %v", err)
	}
	d.requireConverged(t)
	writes = record.destinations()
	for i, dest := range writes {
		if dest == d.managed {
			managedAt = i + 1
			break
		}
	}
	if managedAt == 0 {
		t.Fatal("the apply never wrote the managed file")
	}
	return writes, managedAt
}

// A disk that fills up at any write of an apply, in any way a disk fills up,
// never costs the device its configuration: the managed file stays one
// complete configuration, the last known good stays, Vector isn't touched
// before the commit, the failure names the disk and says how to fix it, and
// the next check-in after space returns applies the same version by itself.
func TestDiskFullAtEveryWriteOfAnApply(t *testing.T) {
	writes, managedAt := learnApplyWrites(t)
	if len(writes) < 12 {
		t.Fatalf("the apply wrote only %d files; the fault points are missing: %v", len(writes), writes)
	}
	for i := 1; i <= len(writes); i++ {
		for _, step := range fullDiskSteps {
			t.Run(fmt.Sprintf("%02d %s at %s", i, writeLabel(writes[i-1]), step), func(t *testing.T) {
				d := newApplyDevice(t)
				disk := fillDisk(t, i, step)
				err := d.e.Poll(context.Background())
				if err == nil {
					t.Fatal("a full disk went unnoticed")
				}
				if !strings.Contains(err.Error(), "disk") {
					t.Fatalf("the error doesn't name the disk: %v", err)
				}
				d.requireIntact(t)
				managed, _ := os.ReadFile(d.managed)
				if i <= managedAt && Digest(managed) != Digest(oldConfig) {
					t.Fatal("the managed file changed although its own write, or an earlier one, failed")
				}
				if i <= managedAt && d.driver.starts != 0 {
					t.Fatal("Vector was touched before the commit")
				}
				if d.e.State.ApplyState != "verified_applied" {
					issue := d.e.State.Error
					found := diagnostic(issue, "DISK_FULL")
					if found == nil {
						t.Fatalf("no diagnostic names the disk: %+v", issue)
					}
					if !strings.Contains(found.Message, "disk") || !strings.Contains(found.Hint, "Free some space") || !strings.Contains(found.Hint, "next check-in") {
						t.Fatalf("the diagnostic doesn't say what to do: %+v", found)
					}
					switch {
					case i <= managedAt && issue.Code != "WRITE_FAILED":
						// Nothing was replaced, so there is nothing to roll back.
						t.Fatalf("a write that failed before the commit is reported as %s", issue.Code)
					case issue.Code != "WRITE_FAILED" && issue.Code != "ROLLBACK_FAILED" && issue.Code != "APPLY_ROLLED_BACK":
						t.Fatalf("issue code %s", issue.Code)
					}
					if d.e.State.FailedGeneration != nil {
						t.Fatal("a full disk held the version back from the next attempt")
					}
					if next := applyNextAction(d.e.State); !strings.Contains(next, "Free some space") {
						t.Fatalf("the next step doesn't name the fix: %s", next)
					}
				}

				disk.free()
				if err := d.e.Poll(context.Background()); err != nil {
					t.Fatalf("the next check-in after space returned failed: %v", err)
				}
				d.requireConverged(t)
			})
		}
	}
}

// Restarting the agent after the disk filled up recovers one complete
// configuration, whatever write failed.
func TestRestartAfterAFullDiskRecoversACompleteConfiguration(t *testing.T) {
	writes, _ := learnApplyWrites(t)
	for i := 1; i <= len(writes); i++ {
		t.Run(fmt.Sprintf("%02d %s", i, writeLabel(writes[i-1])), func(t *testing.T) {
			d := newApplyDevice(t)
			disk := fillDisk(t, i, "write")
			if err := d.e.Poll(context.Background()); err == nil {
				t.Fatal("a full disk went unnoticed")
			}
			disk.free()
			state, err := LoadState(d.e.Dir)
			if err != nil {
				t.Fatal(err)
			}
			restarted := &Engine{Dir: d.e.Dir, Settings: d.e.Settings, State: state, Driver: &fakeDriver{}}
			d.e = restarted
			if err = restarted.Recover(context.Background()); err != nil {
				t.Fatalf("recovery failed: %v", err)
			}
			if err = restarted.StartExisting(context.Background()); err != nil {
				t.Fatalf("starting the recovered configuration failed: %v", err)
			}
			d.driver = restarted.Driver.(*fakeDriver)
			d.requireIntact(t)
			if !restarted.Driver.Alive() {
				t.Fatal("Vector doesn't run after the restart")
			}
		})
	}
}

// AtomicWrite on a full disk reports it as such, keeps the OS error for
// callers that test for it, leaves the file it would have replaced exactly as
// it was, and leaves no temporary file behind.
func TestAtomicWriteOnAFullDiskLeavesTheOldFile(t *testing.T) {
	for _, step := range fullDiskSteps {
		t.Run(step, func(t *testing.T) {
			dir := privateTempDir(t)
			path := filepath.Join(dir, "state.json")
			if err := AtomicWrite(path, []byte("before")); err != nil {
				t.Fatal(err)
			}
			fillDisk(t, 1, step)
			err := AtomicWrite(path, []byte("after, which is longer than before"))
			var full *DiskFullError
			if !errors.As(err, &full) || !isDiskFull(err) || !errors.Is(err, errDiskFull) {
				t.Fatalf("a full disk isn't reported as one: %v", err)
			}
			if full.Dir != dir || !strings.Contains(err.Error(), dir) || !strings.Contains(full.Fix("run the command again"), "Free some space") {
				t.Fatalf("the error doesn't name the disk or the fix: %v", err)
			}
			if got, _ := os.ReadFile(path); string(got) != "before" {
				t.Fatalf("the old file changed: %q", got)
			}
			if left := leftovers(t, dir); len(left) != 0 {
				t.Fatalf("temporary files left: %v", left)
			}
		})
	}
}

// The two places the agent writes are told apart in the diagnostic, by what
// they hold and never by their path.
func TestDiskFullDiagnosticNamesWhatTheDiskHolds(t *testing.T) {
	d := newApplyDevice(t)
	for _, test := range []struct {
		dir  string
		want string
	}{
		{filepath.Dir(d.managed), "the managed configuration"},
		{d.e.Dir, "the agent state directory"},
	} {
		diagnostics := d.e.storageDiagnostic(&DiskFullError{Dir: test.dir, cause: errDiskFull})
		if len(diagnostics) != 1 || !strings.Contains(diagnostics[0].Message, test.want) || strings.Contains(diagnostics[0].Message, test.dir) || strings.Contains(diagnostics[0].Hint, test.dir) {
			t.Fatalf("%s: %+v", test.want, diagnostics)
		}
	}
	if d.e.storageDiagnostic(errors.New("permission denied")) != nil {
		t.Fatal("another failure was called a full disk")
	}
}
