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

// launchctl bootout gives up with 36 while the agent still drains Vector; the
// job then keeps stopping. Stop waits until launchd no longer knows it.
func TestLaunchdStopWaitsForAJobStillStopping(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true, true, true, false}, running: true, clock: time.Now(),
		bootout: launchctlResult{status: launchctlInProgress, stderr: "Boot-out failed: 36: Operation now in progress"}}
	if err := f.job().control("stop"); err != nil {
		t.Fatal(err)
	}
	want := "print system/io.vectory.agent,bootout system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent"
	if strings.Join(f.calls, ",") != want || f.sleeping != 2*launchdStopPoll {
		t.Fatalf("calls %v, slept %s", f.calls, f.sleeping)
	}
}

// launchctl bootout returns when launchd has begun to remove the job, not when it has:
// the job is still listed, with the process it is stopping, for about half a second
// (launchd's log shows "removing service" that long after "bootout initiated"). A stop
// that returned then would let a start find that job and leave it alone; the job would
// be gone a moment later with nothing started. Stop waits until launchd no longer
// knows the job, whatever bootout said.
func TestLaunchdStopWaitsUntilTheJobIsGoneAfterABootoutThatSucceeded(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true, true, true, true, false}, running: true, clock: time.Now(), bootout: launchctlResult{}}
	if err := f.job().control("stop"); err != nil {
		t.Fatal(err)
	}
	want := "print system/io.vectory.agent,bootout system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent,print system/io.vectory.agent"
	if strings.Join(f.calls, ",") != want || f.sleeping != 3*launchdStopPoll {
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

func TestLaunchdStopReportsOtherFailures(t *testing.T) {
	f := &fakeLaunchctl{loaded: []bool{true}, running: true, clock: time.Now(), bootout: launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"}}
	err := f.job().control("stop")
	if err == nil || !strings.Contains(err.Error(), "launchctl bootout system/io.vectory.agent failed: Boot-out failed: 5: Input/output error") || len(f.calls) != 2 {
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
	plist := launchdPlist("/usr/local/bin/vectory", "/var/lib/vectory-agent", "_vectory")
	if plistIdentity(strings.Replace(plist, "330", "400", 1)) != plistIdentity(plist) || plistIdentity(strings.Replace(plist, "<key>Umask</key><integer>63</integer>", "", 1)) != plistIdentity(plist) {
		t.Fatal("a timeout or umask change must be an in-place update")
	}
	for _, other := range []string{
		launchdPlist("/usr/local/bin/vectory", "/var/lib/vectory-agent", "_other"),
		launchdPlist("/opt/bin/vectory", "/var/lib/vectory-agent", "_vectory"),
		launchdPlist("/usr/local/bin/vectory", "/srv/agent", "_vectory"),
	} {
		if plistIdentity(other) == plistIdentity(plist) {
			t.Fatalf("a different service was treated as the same: %s", other)
		}
	}
}

// The packaged definition and setup's own carry the same label under the same
// file name, and both keep the agent's files private.
func TestPackagedLaunchdDefinitionMatchesSetup(t *testing.T) {
	packaged, err := os.ReadFile("../../../packaging/launchd/" + launchdLabel + ".plist")
	if err != nil {
		t.Fatal(err)
	}
	generated := launchdPlist("/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
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
