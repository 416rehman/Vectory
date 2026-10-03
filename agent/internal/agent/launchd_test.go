package agent

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fakeLaunchctl answers launchctl runs from a script and records them. print
// answers from loaded; the clock only moves when the job sleeps.
type fakeLaunchctl struct {
	calls    []string
	loaded   []bool // print answers, in order; the last one repeats
	running  bool
	bootout  launchctlResult
	clock    time.Time
	sleeping time.Duration
	removed  bool // the definition file is gone
}

func (f *fakeLaunchctl) job() launchdJob {
	return launchdJob{
		definition: "/Library/LaunchDaemons/" + launchdLabel + ".plist",
		installed:  func() bool { return !f.removed },
		now:        func() time.Time { return f.clock },
		sleep: func(d time.Duration) {
			f.sleeping += d
			f.clock = f.clock.Add(d)
		},
		run: func(ctx context.Context, args ...string) launchctlResult {
			f.calls = append(f.calls, strings.Join(args, " "))
			switch args[0] {
			case "print":
				loaded := f.loaded[0]
				if len(f.loaded) > 1 {
					f.loaded = f.loaded[1:]
				}
				if !loaded {
					return launchctlResult{status: 113, stderr: `Could not find service "` + launchdLabel + `" in domain for system`}
				}
				state := "not running"
				if f.running {
					state = "running"
				}
				return launchctlResult{stdout: "system/" + launchdLabel + " = {\n\tstate = " + state + "\n\tpid = 812\n}\n"}
			case "bootout":
				return f.bootout
			}
			return launchctlResult{}
		},
	}
}

// mustLaunchdPlist is the agent's definition for values a definition can hold.
func mustLaunchdPlist(t *testing.T, exe, dir, account string) string {
	t.Helper()
	plist, err := launchdPlist(exe, dir, account)
	if err != nil {
		t.Fatal(err)
	}
	return plist
}

// launchctl bootout gives up with 36 while the agent still drains Vector; the
// job then keeps stopping. Stop waits until launchd no longer knows it.
func TestLaunchdStopWaitsForAJobStillStopping(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true, true, true, false}, running: true, clock: time.Now(),
		bootout: launchctlResult{status: launchctlInProgress, stderr: "Boot-out failed: 36: Operation now in progress"}}
	if err := f.job().control("stop"); err != nil {
		t.Fatal(err)
	}
	want := "print system/io.vectory.agent,bootout system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent"
	if strings.Join(f.calls, ",") != want || f.sleeping != 2*launchdUnloadPoll {
		t.Fatalf("calls %v, slept %s", f.calls, f.sleeping)
	}
}

func TestLaunchdStopGivesUpAfterTheStopLimit(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true}, running: true, clock: time.Now(),
		bootout: launchctlResult{status: launchctlInProgress, stderr: "Boot-out failed: 36: Operation now in progress"}}
	err := f.job().control("stop")
	if err == nil || !strings.Contains(err.Error(), "still stopping after 6 min") || f.sleeping < serviceStopLimit || f.sleeping > serviceStopLimit+time.Second {
		t.Fatalf("err %v after %s", err, f.sleeping)
	}
}

// launchctl bootout answers when launchd has begun to remove the job, not when it has:
// launchd's log shows the removal about half a second after the command ended, and
// print lists the job as running until then. A stop that went on at once would meet the
// departing job, so it ends when print says there is no such job.
func TestLaunchdStopReturnsOnlyWhenLaunchdNoLongerListsTheJob(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true, true, true, true, false}, running: true, clock: time.Now()}
	if err := f.job().control("stop"); err != nil {
		t.Fatal(err)
	}
	want := "print system/io.vectory.agent,bootout system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent"
	if strings.Join(f.calls, ",") != want || f.sleeping != 3*launchdUnloadPoll {
		t.Fatalf("a bootout that answered 0 was taken for a stop: calls %v, slept %s", f.calls, f.sleeping)
	}

	// A bootout that is the agent's own (service-stop, uninstall) waits the same way.
	own := &fakeLaunchctl{loaded: []bool{true, false}, running: true, clock: time.Now()}
	if err := own.job().bootout(); err != nil || own.sleeping != launchdUnloadPoll {
		t.Fatalf("bootout: %v, slept %s, calls %v", err, own.sleeping, own.calls)
	}
}

// Only an answer that says launchd has no such job ends the wait: a print that failed
// in another way, or didn't answer, says nothing about the job.
func TestLaunchdStopIsNotEndedByAPrintThatSaysNothingAboutTheJob(t *testing.T) {
	answers := []launchctlResult{
		{stdout: "system/io.vectory.agent = {\n\tstate = running\n}\n"}, // the stop's own look: loaded
		{},           // bootout
		{status: -1}, // print timed out
		{status: 5, stderr: "Input/output error"},                          // print failed in another way
		{stdout: "system/io.vectory.agent = {\n\tstate = running\n}\n"},    // still listed
		{status: 113, stderr: `Could not find service "io.vectory.agent"`}, // gone
	}
	var calls []string
	slept := time.Duration(0)
	clock := time.Now()
	job := launchdJob{
		definition: "/Library/LaunchDaemons/io.vectory.agent.plist",
		now:        func() time.Time { return clock },
		sleep:      func(d time.Duration) { slept += d; clock = clock.Add(d) },
		run: func(_ context.Context, args ...string) launchctlResult {
			calls = append(calls, strings.Join(args, " "))
			result := answers[0]
			answers = answers[1:]
			return result
		},
	}
	if err := job.control("stop"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 6 || slept != 3*launchdUnloadPoll {
		t.Errorf("calls %v, slept %s", calls, slept)
	}
}

// A print that fails or times out doesn't skip the bootout either: only "no such job"
// does.
func TestLaunchdStopDoesNotSkipTheBootoutOnAPrintThatSaysNothing(t *testing.T) {
	answers := []launchctlResult{
		{status: -1}, // the stop's own look timed out
		{},           // bootout: launchd has the job and boots it out
		{status: 113, stderr: `Could not find service "io.vectory.agent"`}, // gone
	}
	var calls []string
	job := launchdJob{
		definition: "/Library/LaunchDaemons/io.vectory.agent.plist",
		now:        time.Now,
		sleep:      func(time.Duration) {},
		run: func(_ context.Context, args ...string) launchctlResult {
			calls = append(calls, args[0])
			result := answers[0]
			answers = answers[1:]
			return result
		},
	}
	if err := job.control("stop"); err != nil || strings.Join(calls, ",") != "print,bootout,print" {
		t.Fatalf("%v, calls %v", err, calls)
	}
}

func TestLaunchdStopReportsOtherFailures(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true}, running: true, clock: time.Now(), bootout: launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"}}
	err := f.job().control("stop")
	// The job is still listed after the bootout that failed, so it is the answer; the last
	// call is the look that shows the job is still there.
	if err == nil || !strings.Contains(err.Error(), "launchctl bootout system/io.vectory.agent failed: Boot-out failed: 5: Input/output error") || len(f.calls) != 3 {
		t.Fatalf("err %v, calls %v", err, f.calls)
	}
	stopped := &fakeLaunchctl{loaded: []bool{false}, clock: time.Now()}
	if err := stopped.job().control("stop"); err != nil || strings.Join(stopped.calls, ",") != "print system/io.vectory.agent" {
		t.Fatalf("stopping an unloaded job: %v %v", err, stopped.calls)
	}
	// A job launchd still runs is stopped even if its file was removed.
	orphan := &fakeLaunchctl{loaded: []bool{true, false}, running: true, removed: true, clock: time.Now()}
	if err := orphan.job().control("stop"); err != nil || strings.Join(orphan.calls, ",") != "print system/io.vectory.agent,bootout system/io.vectory.agent,print system/io.vectory.agent" {
		t.Fatalf("stopping a loaded job without its file: %v %v", err, orphan.calls)
	}
	// A bootout that fails because the job went in the meantime has stopped it.
	gone := &fakeLaunchctl{loaded: []bool{true, false}, running: true, clock: time.Now(), bootout: launchctlResult{status: 3, stderr: "Boot-out failed: 3: No such process"}}
	if err := gone.job().control("stop"); err != nil {
		t.Fatalf("a bootout of a job that was already gone: %v", err)
	}
}

// A restart with the loaded definition is kickstart -k; start never
// bootstraps a job launchd already has.
func TestLaunchdRestartAndStart(t *testing.T) {
	for _, tc := range []struct {
		action  string
		loaded  bool
		running bool
		want    string
	}{
		{"restart", true, true, "kickstart -k system/io.vectory.agent"},
		{"restart", false, false, "bootstrap system /Library/LaunchDaemons/io.vectory.agent.plist"},
		{"start", true, true, ""},
		{"start", true, false, "kickstart system/io.vectory.agent"},
		{"start", false, false, "bootstrap system /Library/LaunchDaemons/io.vectory.agent.plist"},
	} {
		f := &fakeLaunchctl{loaded: []bool{tc.loaded}, running: tc.running, clock: time.Now()}
		if err := f.job().control(tc.action); err != nil {
			t.Fatal(err)
		}
		var changes []string
		for _, call := range f.calls {
			if !strings.HasPrefix(call, "print ") {
				changes = append(changes, call)
			}
		}
		if strings.Join(changes, ",") != tc.want {
			t.Errorf("%s (loaded %v, running %v): %v, want %q", tc.action, tc.loaded, tc.running, changes, tc.want)
		}
	}
}

func TestLaunchdDefinitionUpdatesInPlaceOnlyForTheSameService(t *testing.T) {
	plist := mustLaunchdPlist(t, "/usr/local/bin/vectory", "/var/lib/vectory-agent", "_vectory")
	if plistIdentity(strings.Replace(plist, "330", "400", 1)) != plistIdentity(plist) || plistIdentity(strings.Replace(plist, "<key>Umask</key><integer>63</integer>", "", 1)) != plistIdentity(plist) {
		t.Fatal("a timeout or umask change must be an in-place update")
	}
	for _, other := range []string{
		mustLaunchdPlist(t, "/usr/local/bin/vectory", "/var/lib/vectory-agent", "_other"),
		mustLaunchdPlist(t, "/opt/bin/vectory", "/var/lib/vectory-agent", "_vectory"),
		mustLaunchdPlist(t, "/usr/local/bin/vectory", "/srv/agent", "_vectory"),
	} {
		if plistIdentity(other) == plistIdentity(plist) {
			t.Fatalf("a different service was treated as the same: %s", other)
		}
	}
}

// A value that XML 1.0 can't carry, or that launchd would read as something else than was
// meant, is refused before any definition is made, as the update step's own definition does:
// the escaper writes U+FFFD for NUL and for U+FFFE, and a control character comes back as
// another one. The definition that setup writes and the one the update step compares with
// are this text, so the same refusal holds for both.
func TestTheAgentsDefinitionRefusesAValueLaunchdWouldReadDifferently(t *testing.T) {
	const exe, dir, account = "/usr/local/bin/vectory", "/var/lib/vectory-agent", "_vectory"
	for _, bad := range []string{
		"", "/opt/a\nb", "/opt/a\rb", "/opt/a\x00b", "/opt/a\tb", "/opt/a\x01b", "/opt/a\x7fb", "/opt/a\u0085b",
		string([]byte{'/', 0xff, 0xfe}), "/opt/a￾b", "/opt/a￿b",
	} {
		for what, args := range map[string][3]string{
			"the executable":      {bad, dir, account},
			"the state directory": {exe, bad, account},
			"the service account": {exe, dir, bad},
		} {
			if text, err := launchdPlist(args[0], args[1], args[2]); err == nil {
				t.Errorf("%s %q was written into the agent's definition: %s", what, bad, text)
			}
		}
	}
	// What is allowed is the same text every time, whatever else is in a path.
	if first, second := mustLaunchdPlist(t, exe, dir, account), mustLaunchdPlist(t, exe, dir, account); first != second {
		t.Error("the definition for the same values differs between two calls")
	}
}

// The packaged definition and setup's own carry the same label under the same
// file name, and both keep the agent's files private.
func TestPackagedLaunchdDefinitionMatchesSetup(t *testing.T) {
	packaged, err := os.ReadFile("../../../packaging/launchd/" + launchdLabel + ".plist")
	if err != nil {
		t.Fatal(err)
	}
	generated := mustLaunchdPlist(t, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	compact := regexp.MustCompile(`>\s+<`).ReplaceAllString(string(packaged), "><")
	for _, setting := range []string{
		"<key>Label</key><string>" + launchdLabel + "</string>",
		"<key>Umask</key><integer>63</integer>",
		"<key>ExitTimeOut</key><integer>330</integer>",
		"<key>AbandonProcessGroup</key><false/>",
		"<key>KeepAlive</key><true/>",
	} {
		if !strings.Contains(compact, setting) || !strings.Contains(generated, setting) {
			t.Errorf("packaged and generated definitions differ on %s", setting)
		}
	}
	if plistIdentity(compact) != plistIdentity(generated) {
		t.Error("the packaged definition doesn't run the agent the way setup registers it")
	}
}
