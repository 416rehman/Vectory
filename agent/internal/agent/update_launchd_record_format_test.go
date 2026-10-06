//go:build !windows

package agent

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// What a record of a job the step told launchd to remove says, and when it still holds. A record
// that held for ever would keep a swap open for as long as an agent runs with the process ID it
// names, and one that was dropped early would let the next run take a departing listing for a
// start.

func TestARecordHoldsOnlyForTheBootSessionAndTheAwakeTimeItWasWrittenIn(t *testing.T) {
	const day = 24 * time.Hour
	for name, c := range map[string]struct {
		change func(host *macosUpdateHost, recorder *launchctlRecorder)
		holds  bool
	}{
		"just written": {func(*macosUpdateHost, *launchctlRecorder) {}, true},
		"as old as its life": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.clock = r.clock.Add(recordLife())
		}, true},
		"a second older than its life": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.clock = r.clock.Add(recordLife() + time.Second)
		}, false},
		"from another boot session": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.boot = "uuid:boot-b"
		}, false},
		// A session of another kind than the record's can't be compared with it, and one the system
		// doesn't say can't be either: the record holds as long as its age allows.
		"from a boot session of another kind": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.boot = "boottime:1790000000"
		}, true},
		"where the system gives no boot session now": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.boot = ""
		}, true},
		// The uptime of a Mac that was restarted begins again, so one below the record's is from before
		// it, where the boot session can't tell.
		"from before a restart, where the system gives no boot session": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.boot, r.booted = "", r.clock.Add(-time.Minute)
		}, false},
		// A Mac that sleeps doesn't spend the record's age: a day of sleep leaves the record as
		// young as the time the Mac was awake.
		"after a Mac slept for a day": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.clock = r.clock.Add(day)
			r.booted = r.booted.Add(day)
		}, true},
		"after a Mac slept for a day and was awake past the record's life": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.clock = r.clock.Add(day + recordLife() + time.Second)
			r.booted = r.booted.Add(day)
		}, false},
		"where the clock was set back an hour": {func(_ *macosUpdateHost, r *launchctlRecorder) {
			r.clock = r.clock.Add(-time.Hour)
			r.booted = r.booted.Add(-time.Hour)
		}, true},
		// Where the system doesn't say how long the Mac has been awake, the wall clock stands in.
		"by the wall clock, inside its life": {func(h *macosUpdateHost, r *launchctlRecorder) {
			h.uptime = func() (time.Duration, bool) { return 0, false }
			r.clock = r.clock.Add(recordLife())
		}, true},
		"by the wall clock, past its life": {func(h *macosUpdateHost, r *launchctlRecorder) {
			h.uptime = func() (time.Duration, bool) { return 0, false }
			r.clock = r.clock.Add(recordLife() + time.Second)
		}, false},
		"by the wall clock, set back an hour": {func(h *macosUpdateHost, r *launchctlRecorder) {
			h.uptime = func() (time.Duration, bool) { return 0, false }
			r.clock = r.clock.Add(-time.Hour)
		}, true},
	} {
		t.Run(name, func(t *testing.T) {
			host, recorder, _ := newTestMacOSHost(t)
			if err := host.rememberLeaving(4242); err != nil {
				t.Fatal(err)
			}
			c.change(host, recorder)
			if _, holds := host.leavingRecord(); holds != c.holds {
				t.Errorf("the record holds: %v, want %v", holds, c.holds)
			}
		})
	}
}

// A record written where the system doesn't say how long the Mac has been awake, or which boot it
// is, is judged by the wall clock alone, and holds for the same life.
func TestARecordWrittenWhereTheSystemSaysNeitherTheBootNorTheTimeAwakeHoldsByTheWallClock(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	host.bootSession = func() string { return "" }
	host.uptime = func() (time.Duration, bool) { return 0, false }
	if err := host.rememberLeaving(4242); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`{"pid":4242,"boot":"","awake_ns":0,"at":"%s"}`+"\n", recorder.clock.Format(time.RFC3339Nano))
	if got := leavingRecord(t, host); got != want {
		t.Errorf("the record:\n%q\nwant\n%q", got, want)
	}
	recorder.clock = recorder.clock.Add(recordLife())
	if _, holds := host.leavingRecord(); !holds {
		t.Error("the record is over at its life")
	}
	recorder.clock = recorder.clock.Add(time.Second)
	if _, holds := host.leavingRecord(); holds {
		t.Error("the record holds past its life")
	}
}

// A job `print` listed without a process is recorded as one that names none, which is what makes
// any listing of the job the one that was told to leave.
func TestTheRecordOfAJobPrintListedNoProcessForNamesNoProcess(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", listingOf(0))
	if err := host.StopService(context.Background()); err == nil {
		t.Fatal("a stop of a job launchd lists for ever ended without an error")
	}
	if got := leavingRecord(t, host); !strings.HasPrefix(got, `{"pid":null,"boot":"uuid:boot-a",`) {
		t.Errorf("the record of a job listed with no process: %q", got)
	}
	if pid, kept := recordNames(t, host); !kept || pid != 0 {
		t.Errorf("the record names process %d (kept %v)", pid, kept)
	}
}

// Two boot sessions are one boot unless both are known, of one kind and different.
func TestTwoBootSessionsAreOneBootUnlessBothAreKnownOfOneKindAndDiffer(t *testing.T) {
	for _, c := range []struct {
		recorded, now string
		same          bool
	}{
		{"uuid:A", "uuid:A", true},
		{"uuid:A", "uuid:B", false},
		{"boottime:100", "boottime:100", true},
		{"boottime:100", "boottime:200", false},
		{"uuid:A", "boottime:200", true},
		{"boottime:200", "uuid:A", true},
		{"", "uuid:A", true},
		{"uuid:A", "", true},
		{"", "", true},
	} {
		if got := sameBoot(c.recorded, c.now); got != c.same {
			t.Errorf("sameBoot(%q, %q) = %v, want %v", c.recorded, c.now, got, c.same)
		}
	}
}

// The record outlasts neither a restart nor its life, and a stop that gave up leaves it to the
// start that follows, which waits for launchd as it did.
func TestAStartTakesAListingOfTheProcessARecordNamesForAStartOnceTheRecordIsOver(t *testing.T) {
	const print = "print system/io.vectory.agent"
	host, recorder, slept := newTestMacOSHost(t)
	recorder.answer(print, listingOf(4242))
	if err := host.StopService(context.Background()); err == nil {
		t.Fatal("a stop of a job launchd lists for ever ended without an error")
	}
	stopped := recorder.clock

	// Inside its life, a listing of that process is the job that was told to leave.
	next := nextRunOf(host, recorder, slept)
	recorder.clock = stopped
	if err := next.StartService(context.Background()); err == nil || !strings.Contains(err.Error(), "it still lists the agent's label while an earlier bootout is unresolved (recorded process 4242 before bootout)") {
		t.Fatalf("a start inside the record's life: %v", err)
	}
	// Past it, the same listing is a start, and the record goes.
	last := nextRunOf(next, recorder, slept)
	recorder.clock = stopped.Add(recordLife())
	if err := last.StartService(context.Background()); err != nil {
		t.Fatalf("a start past the record's life: %v", err)
	}
	if _, kept := recordNames(t, last); kept {
		t.Error("the record of a job that was over is still there")
	}
}
