//go:build !windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The privileged step's launchd side on every Unix system, without launchd: the
// text of the step's definition and what is written, the calls made to launchctl (a
// recorder stands in for it), the way its text is read, the reading of the agent's
// definition, and the decision that a package owns the executable.
// update_launchd_step_test.go runs the whole step through this host.

// launchctlRecorder answers launchctl from a script and records every call. A
// change with no answer succeeds and prints nothing, and a print with no answer
// finds no such job; answers to a call come in order and the last one repeats.
type launchctlRecorder struct {
	calls   []string
	answers map[string][]launchctlResult
	// clock is the time the host sees; it moves only when the host sleeps.
	clock time.Time
}

func (r *launchctlRecorder) answer(call string, results ...launchctlResult) {
	if r.answers == nil {
		r.answers = map[string][]launchctlResult{}
	}
	r.answers[call] = results
}

func (r *launchctlRecorder) run(ctx context.Context, args ...string) launchctlResult {
	call := strings.Join(args, " ")
	r.calls = append(r.calls, call)
	results := r.answers[call]
	if len(results) == 0 {
		if args[0] == "print" {
			return notLoaded
		}
		return launchctlResult{}
	}
	result := results[0]
	if len(results) > 1 {
		r.answers[call] = results[1:]
	}
	return result
}

func (r *launchctlRecorder) changes() []string {
	var changes []string
	for _, call := range r.calls {
		if !strings.HasPrefix(call, "print ") {
			changes = append(changes, call)
		}
	}
	return changes
}

var notLoaded = launchctlResult{status: 113, stderr: `Could not find service "io.vectory.update" in domain for system`}

// newTestMacOSHost is the macOS host over a launchctl recorder and a directory of
// launch daemons the test owns, in the tree of the update paths it also points the
// step at. The sleeps a retry takes are recorded, not taken.
func newTestMacOSHost(t *testing.T) (*macosUpdateHost, *launchctlRecorder, *[]time.Duration) {
	t.Helper()
	paths := useUpdateRoots(t)
	root := filepath.Dir(filepath.Dir(filepath.Dir(paths.PolicyDir)))
	daemons := filepath.Join(root, "Library", "LaunchDaemons")
	mkdirMode(t, daemons, 0o755)
	recorder := &launchctlRecorder{clock: time.Date(2026, 10, 5, 2, 0, 0, 0, time.UTC)}
	var slept []time.Duration
	host := testMacOSHostOver(recorder, &slept, daemons, filepath.Join(root, "receipts", "com.vectory.agent.bom"))
	return host, recorder, &slept
}

// testMacOSHostOver is the macOS host over a launchctl recorder, with nothing in its memory.
func testMacOSHostOver(recorder *launchctlRecorder, slept *[]time.Duration, daemons, receipt string) *macosUpdateHost {
	host := newMacOSUpdateHost(recorder.run)
	host.daemonDir = daemons
	host.receipt = receipt
	host.agent = host.job("", recorder.run)
	host.step = host.job(updateLaunchdLabel, recorder.run)
	host.alive = func(int) bool { return false }
	for _, job := range []*launchdJob{&host.agent, &host.step} {
		job.now = func() time.Time { return recorder.clock }
		job.sleep = func(d time.Duration) {
			*slept = append(*slept, d)
			recorder.clock = recorder.clock.Add(d)
		}
	}
	return host
}

// nextRunOf is the host as the next run of the step has it: the update step is a new
// process every 30 seconds, and what the one before kept in memory is gone. The launchctl,
// the files and the clock are the same.
func nextRunOf(previous *macosUpdateHost, recorder *launchctlRecorder, slept *[]time.Duration) *macosUpdateHost {
	next := testMacOSHostOver(recorder, slept, previous.daemonDir, previous.receipt)
	next.alive = previous.alive
	return next
}

func macTestUnitSpec() updateUnitSpec {
	return updateUnitSpec{StateDir: "/Library/Application Support/Vectory/agent", InstallDir: "/usr/local/bin", Helper: "/Library/Application Support/Vectory/update-state/private/helper/vectory"}
}

func readTestdata(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "update", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// ---------------------------------------------------------------- the definition's text

func TestTheStepsLaunchDaemonIsPinnedWordForWord(t *testing.T) {
	got, err := launchdUpdatePlist(macTestUnitSpec(), updateLocationsFor("darwin", ""))
	if err != nil {
		t.Fatal(err)
	}
	if want := readTestdata(t, "io.vectory.update.plist"); got != want {
		t.Errorf("io.vectory.update.plist differs from the pinned text:\n%s\nwant:\n%s", got, want)
	}
}

func TestTheStepsLaunchDaemonIsTheDesignAndNothingElse(t *testing.T) {
	text, err := launchdUpdatePlist(macTestUnitSpec(), updateLocationsFor("darwin", ""))
	if err != nil {
		t.Fatal(err)
	}
	dict, err := parsePropertyList([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	paths := updateLocationsFor("darwin", "")
	want := map[string]any{
		"Label":            "io.vectory.update",
		"ProgramArguments": []any{macTestUnitSpec().Helper, "update-helper", "--state-dir", macTestUnitSpec().StateDir},
		"RunAtLoad":        true,
		"StartInterval":    plistScalar("30"),
		"EnvironmentVariables": map[string]any{
			"PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
		},
		"StandardOutPath":   "/dev/null",
		"StandardErrorPath": paths.Private + "/step.log",
	}
	if len(dict) != len(want) {
		t.Errorf("the definition sets %d things and the design names %d: %v", len(dict), len(want), dict)
	}
	for key, value := range want {
		if got, ok := dict[key]; !ok || !samePlistValue(got, value) {
			t.Errorf("%s is %#v, want %#v", key, got, value)
		}
	}
	// What the step never has: it runs as root (no UserName, no GroupName) with the
	// system's PATH alone, and nothing that would start it any other way, keep it
	// running, give it a socket or let a file in a directory run it.
	for _, never := range []string{
		"UserName", "GroupName", "Program", "KeepAlive", "WatchPaths", "QueueDirectories", "Sockets", "MachServices", "StartOnMount",
		"StartCalendarInterval", "Disabled", "Umask", "WorkingDirectory", "RootDirectory", "SessionCreate", "inetdCompatibility",
		"ThrottleInterval", "ExitTimeOut", "AbandonProcessGroup", "LaunchOnlyOnce",
	} {
		if _, found := dict[never]; found {
			t.Errorf("the definition sets %s", never)
		}
	}
	// The text is one line plus its end, as the agent's own definition is, with the
	// document type launchd's tools expect.
	if strings.Count(text, "\n") != 1 || !strings.HasSuffix(text, "</plist>\n") || !strings.Contains(text, `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"`) {
		t.Errorf("the text isn't compact:\n%s", text)
	}
}

func samePlistValue(a, b any) bool {
	switch x := a.(type) {
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !samePlistValue(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for key, value := range x {
			if other, found := y[key]; !found || !samePlistValue(value, other) {
				return false
			}
		}
		return true
	}
	return a == b
}

func TestAValueThatLaunchdWouldReadDifferentlyIsRefusedBeforeAnythingIsWritten(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	good := macTestUnitSpec()
	fields := map[string]func(updateUnitSpec, string) updateUnitSpec{
		"the step's executable":       func(s updateUnitSpec, v string) updateUnitSpec { s.Helper = v; return s },
		"the agent's state directory": func(s updateUnitSpec, v string) updateUnitSpec { s.StateDir = v; return s },
		"the install directory":       func(s updateUnitSpec, v string) updateUnitSpec { s.InstallDir = v; return s },
	}
	for _, bad := range []string{
		"/opt/a\nb", "/opt/a\rb", "/opt/a\x00b", "/opt/a\tb", "/opt/a\x01b", "/opt/a\x7fb", "/opt/a\u0085b", "", string([]byte{'/', 0xff, 0xfe}), "/opt/a￾b", "/opt/a￿b",
	} {
		for name, set := range fields {
			spec := set(good, bad)
			if _, err := launchdUpdatePlist(spec, UpdateLocations()); err == nil {
				t.Errorf("%s %q was written into a definition", name, bad)
			}
			if err := host.InstallUnits(spec); err == nil {
				t.Errorf("%s %q was installed", name, bad)
			}
		}
	}
	if entries, _ := os.ReadDir(host.daemonDir); len(entries) != 0 {
		t.Errorf("a refused value left %d files in the daemon directory", len(entries))
	}
	if len(recorder.calls) != 0 {
		t.Errorf("a refused value reached launchd: %v", recorder.calls)
	}
}

// What a path may hold that XML reads specially, and survives: spaces, quotes, an
// ampersand, angle brackets and text that isn't ASCII are escaped as XML wants, and
// the step reads back what it wrote.
func TestPathsWithSpacesQuotesAndMarkupAreWrittenAsXMLReadsThemAndReadBack(t *testing.T) {
	for _, dir := range []string{"/Library/Application Support/Vectory", `/opt/we"ird`, "/opt/it's", "/opt/a&b", "/opt/<angle>", "/opt/ünï/bin", "/opt/50%/bin", "/opt/$HOME/bin", "/opt/]]>/bin", `/opt/back\slash`} {
		spec := updateUnitSpec{StateDir: dir + "/state", InstallDir: dir, Helper: dir + "/helper"}
		text, err := launchdUpdatePlist(spec, updateLocationsFor("darwin", ""))
		if err != nil {
			t.Errorf("%q: %v", dir, err)
			continue
		}
		dict, err := parsePropertyList([]byte(text))
		if err != nil {
			t.Errorf("%q: %v", dir, err)
			continue
		}
		arguments, _ := dict["ProgramArguments"].([]any)
		if len(arguments) != 4 || arguments[0] != spec.Helper || arguments[3] != spec.StateDir {
			t.Errorf("%q reads back as %v", dir, arguments)
		}
		if strings.Contains(text, "&b") || strings.Contains(text, "<angle>") {
			t.Errorf("%q isn't escaped: %s", dir, text)
		}
	}
}

// The agent's own definition carries what XML reads specially the same way: escaped as XML
// wants, and read back by the property list as the values that were given.
func TestTheAgentsDefinitionCarriesAPathWithMarkupAsXMLReadsIt(t *testing.T) {
	for _, base := range []string{"/Library/Application Support/Vectory", `/opt/we"ird`, "/opt/it's", "/opt/a&b", "/opt/<angle>", "/opt/ünï", "/opt/50%", "/opt/]]>", `/opt/back\slash`} {
		text := mustLaunchdPlist(t, base+"/vectory", base+"/state", "_v&c")
		dict, err := parsePropertyList([]byte(text))
		if err != nil {
			t.Errorf("%q: %v", base, err)
			continue
		}
		arguments, _ := dict["ProgramArguments"].([]any)
		if len(arguments) != 4 || arguments[0] != base+"/vectory" || arguments[3] != base+"/state" || dict["UserName"] != "_v&c" {
			t.Errorf("%q reads back as %v, user %v", base, arguments, dict["UserName"])
		}
		if strings.Contains(text, "&b") || strings.Contains(text, "<angle>") {
			t.Errorf("%q isn't escaped: %s", base, text)
		}
	}
}

// ---------------------------------------------------------------- installing and removing

func TestInstallingTheStepWritesItsDefinitionForEveryoneToReadEnablesItAndLoadsIt(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	spec := macTestUnitSpec()
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	want, _ := launchdUpdatePlist(spec, UpdateLocations())
	path := filepath.Join(host.daemonDir, "io.vectory.update.plist")
	data, err := os.ReadFile(path)
	if err != nil || string(data) != want {
		t.Errorf("%s: %q, %v", path, data, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("%s: %v, %v", path, info, err)
	}
	wantCalls := []string{"print system/io.vectory.update", "enable system/io.vectory.update", "bootstrap system " + path}
	if strings.Join(recorder.calls, "|") != strings.Join(wantCalls, "|") {
		t.Errorf("the calls were %v, want %v", recorder.calls, wantCalls)
	}
	if entries, _ := os.ReadDir(host.daemonDir); len(entries) != 1 {
		t.Errorf("the daemon directory holds %d files", len(entries))
	}
}

func TestInstallingTheStepAgainUnloadsTheJobItHasSoThatLaunchdReadsTheTextNowOnDisk(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	// Loaded: print succeeds, and says there is no such job once launchd has removed it.
	recorder.answer("print system/io.vectory.update", launchctlResult{stdout: "system/io.vectory.update = {\n\tstate = not running\n\truns = 4\n}\n"}, launchctlResult{stdout: "system/io.vectory.update = {\n\tstate = running\n\truns = 4\n}\n"}, notLoaded)
	if err := host.InstallUnits(macTestUnitSpec()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(host.daemonDir, "io.vectory.update.plist")
	want := []string{"bootout system/io.vectory.update", "enable system/io.vectory.update", "bootstrap system " + path}
	if got := recorder.changes(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("the changes were %v, want %v", got, want)
	}
}

func TestAJobThatWontLoadIsTheAnswerAndAnEnableThatFailsIsNot(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	recorder.answer("enable system/io.vectory.update", launchctlResult{status: 1, stderr: "Could not enable service"})
	if err := host.InstallUnits(macTestUnitSpec()); err != nil {
		t.Errorf("an enable that failed stopped the install: %v", err)
	}
	path := filepath.Join(host.daemonDir, "io.vectory.update.plist")
	recorder.answer("bootstrap system "+path, launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"})
	err := host.InstallUnits(macTestUnitSpec())
	if err == nil || !strings.Contains(err.Error(), "Bootstrap failed: 5: Input/output error") {
		t.Errorf("a bootstrap that failed: %v", err)
	}
	// A job that is loaded and won't unload is the answer too, and nothing is written
	// over the definition it loaded.
	before, _ := os.ReadFile(path)
	recorder.answer("print system/io.vectory.update", launchctlResult{stdout: "system/io.vectory.update = {\n}\n"})
	recorder.answer("bootout system/io.vectory.update", launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"})
	if err := host.InstallUnits(updateUnitSpec{StateDir: "/srv/other", InstallDir: "/srv", Helper: "/srv/helper"}); err == nil {
		t.Error("a job that wouldn't unload was written over")
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Error("the definition changed while the job it loaded stayed")
	}
}

// writeAgentDefinition writes the agent's launch daemon for an executable, a state
// directory and an account, as setup does.
func writeAgentDefinition(t *testing.T, host *macosUpdateHost, exe, dir, account string) string {
	t.Helper()
	path := host.agent.definition
	if err := os.WriteFile(path, []byte(mustLaunchdPlist(t, exe, dir, account)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRemovingTheStepUnloadsItFirstSaysWhereTheInstallDirectoryWasAndLeavesNothing(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	if dir, removed, err := host.RemoveUnits(); err != nil || removed || dir != "" {
		t.Fatalf("with nothing installed: %q, %v, %v", dir, removed, err)
	}
	recorder.calls = nil
	spec := macTestUnitSpec()
	spec.StateDir = "/var/lib/vectory-agent"
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	writeAgentDefinition(t, host, "/opt/vectory/bin/vectory", "/var/lib/vectory-agent", "_vectory")
	recorder.calls = nil
	recorder.answer("print system/io.vectory.update", launchctlResult{stdout: "system/io.vectory.update = {\n\tstate = not running\n\truns = 4\n}\n"}, notLoaded)
	dir, removed, err := host.RemoveUnits()
	if err != nil || !removed || dir != "/opt/vectory/bin" {
		t.Fatalf("removing: %q, %v, %v", dir, removed, err)
	}
	if got := recorder.changes(); strings.Join(got, "|") != "bootout system/io.vectory.update" {
		t.Errorf("the changes were %v", got)
	}
	if _, err := os.Lstat(filepath.Join(host.daemonDir, "io.vectory.update.plist")); !os.IsNotExist(err) {
		t.Errorf("the definition is still there: %v", err)
	}

	// An agent definition for another state directory says nothing about where the
	// step's executable is, and one that isn't there says nothing at all.
	recorder.answer("print system/io.vectory.update", notLoaded)
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	writeAgentDefinition(t, host, "/opt/vectory/bin/vectory", "/srv/another", "_vectory")
	if dir, removed, err := host.RemoveUnits(); err != nil || !removed || dir != "" {
		t.Errorf("another state directory: %q, %v, %v", dir, removed, err)
	}
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(host.agent.definition); err != nil {
		t.Fatal(err)
	}
	if dir, removed, err := host.RemoveUnits(); err != nil || !removed || dir != "" {
		t.Errorf("no agent definition: %q, %v, %v", dir, removed, err)
	}

	// A job that can't be unloaded leaves the definition where it is, so that what runs
	// is still what the file says.
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	recorder.answer("print system/io.vectory.update", launchctlResult{stdout: "system/io.vectory.update = {\n}\n"})
	recorder.answer("bootout system/io.vectory.update", launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"})
	if _, _, err := host.RemoveUnits(); err == nil {
		t.Error("a job that wouldn't unload was removed")
	}
	if _, err := os.Lstat(filepath.Join(host.daemonDir, "io.vectory.update.plist")); err != nil {
		t.Errorf("a failed removal took the definition: %v", err)
	}
}

// ---------------------------------------------------------------- the agent's job

// The prints in testdata/update are launchd's own words. launchctl-print-running.txt is what
// launchd printed on a Mac for the agent's job, started at load and never exited, and
// launchctl-print-not-running.txt is what it printed for the step's own job between two of
// its runs (loaded, not running, last exit code 0, run interval 30 seconds, runs 13); the
// block of probabilistic guard malloc settings inside each is why only the lines directly
// inside the job's braces count. Neither run printed a job that was restarted or one waiting
// out its throttle, so launchctl-print-restarted.txt and launchctl-print-waiting.txt are the
// agent's real text with only the lines that depend on that state changed: runs, pid, last
// exit code, active count and state, and the reason, which launchd gave only for the job
// it started when it was loaded.
func TestTheServiceStateIsWhatLaunchctlPrintsAndNothingIsGuessed(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	const print = "print system/io.vectory.agent"
	nested := "system/io.vectory.agent = {\n\tstate = running\n\tpid = 11\n\truns = 2\n\tendpoints = {\n\t\t\"x\" = {\n\t\t\tstate = 3\n\t\t\tpid = 999\n\t\t\truns = 77\n\t\t}\n\t}\n}\n"
	for name, c := range map[string]struct {
		result  launchctlResult
		want    updateServiceState
		wantErr bool
	}{
		"running":                            {launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")}, updateServiceState{State: "active", Restarts: 0, PID: realAgentPID}, false},
		"restarted twice":                    {launchctlResult{stdout: readTestdata(t, "launchctl-print-restarted.txt")}, updateServiceState{State: "active", Restarts: 2, PID: 34455}, false},
		"waiting to start again":             {launchctlResult{stdout: readTestdata(t, "launchctl-print-waiting.txt")}, updateServiceState{State: "activating", Restarts: 1}, false},
		"loaded and not running":             {launchctlResult{stdout: readTestdata(t, "launchctl-print-not-running.txt")}, updateServiceState{State: "activating", Restarts: 12}, false},
		"not loaded":                         {notLoaded, updateServiceState{State: "inactive", Unloaded: true}, false},
		"not loaded, by its text alone":      {launchctlResult{status: 1, stderr: `Could not find service "io.vectory.agent" in domain for system`}, updateServiceState{State: "inactive", Unloaded: true}, false},
		"only the job's own lines count":     {launchctlResult{stdout: nested}, updateServiceState{State: "active", Restarts: 1, PID: 11}, false},
		"running with no process":            {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = 1\n}\n"}, updateServiceState{State: "activating"}, false},
		"no state":                           {launchctlResult{stdout: "system/io.vectory.agent = {\n\truns = 1\n}\n"}, updateServiceState{}, true},
		"no count of runs":                   {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\tpid = 5\n}\n"}, updateServiceState{}, true},
		"a count that isn't one":             {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = many\n}\n"}, updateServiceState{}, true},
		"a negative count":                   {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = -1\n}\n"}, updateServiceState{}, true},
		"a count too large to be one":        {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = 99999999999999999999\n}\n"}, updateServiceState{}, true},
		"lines that end with CR and LF":      {launchctlResult{stdout: "system/io.vectory.agent = {\r\n\tstate = running\r\n\tpid = 11\r\n\truns = 2\r\n}\r\n"}, updateServiceState{State: "active", Restarts: 1, PID: 11}, false},
		"cut off after the lines that count": {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\tpid = 11\n\truns = 2\n"}, updateServiceState{State: "active", Restarts: 1, PID: 11}, false},
		"cut off before the count of runs":   {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\tpid = 11\n"}, updateServiceState{}, true},
		"no spaces around the equals sign":   {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate=running\n\truns=1\n\tpid=5\n}\n"}, updateServiceState{}, true},
		"a pid that isn't one":               {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = 1\n\tpid = x\n}\n"}, updateServiceState{}, true},
		"nothing printed":                    {launchctlResult{}, updateServiceState{}, true},
		"launchctl failing for its reason":   {launchctlResult{status: 5, stderr: "Input/output error"}, updateServiceState{}, true},
		"launchctl that was killed":          {launchctlResult{status: -1}, updateServiceState{}, true},
	} {
		recorder.calls = nil
		recorder.answer(print, c.result)
		got, err := host.ServiceState(context.Background())
		got.Detail = "" // what launchd said is the next test's
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("%s: %+v, %v", name, got, err)
		}
		if strings.Join(recorder.calls, "|") != print {
			t.Errorf("%s: the state was read with %v", name, recorder.calls)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	recorder.answer(print, launchctlResult{status: -1})
	if _, err := host.ServiceState(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("a stopped step: %v", err)
	}
}

// The step's log is all a person has of why a build didn't stay up, because the agent's
// own standard error goes nowhere: the state carries what launchd said, in words.
func TestTheServiceStateCarriesWhatLaunchdSaidForTheStepsLog(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	const print = "print system/io.vectory.agent"
	for name, c := range map[string]struct {
		result launchctlResult
		want   string
	}{
		"a job that ended with a code":                    {launchctlResult{stdout: readTestdata(t, "launchctl-print-waiting.txt")}, `launchd says the job is "spawn scheduled" with pid 0, 2 run(s), last exit code 2, immediate reason -`},
		"a job that never exited":                         {launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")}, `launchd says the job is "running" with pid 34373, 1 run(s), last exit code (never exited), immediate reason speculative`},
		"a job that runs on an interval and ended with 0": {launchctlResult{stdout: readTestdata(t, "launchctl-print-not-running.txt")}, `launchd says the job is "not running" with pid 0, 13 run(s), last exit code 0, immediate reason -`},
		"a job whose print has no exit code":              {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = 1\n\tpid = 5\n}\n"}, `with pid 5, 1 run(s), last exit code -, immediate reason -`},
		"a job launchd doesn't know":                      {notLoaded, `launchd doesn't know the job (launchctl print exited 113: Could not find service`},
	} {
		recorder.answer(print, c.result)
		got, err := host.ServiceState(context.Background())
		if err != nil || !strings.Contains(got.Detail, c.want) {
			t.Errorf("%s: %q, %v; want it to say %q", name, got.Detail, err, c.want)
		}
	}
	// What launchd prints is bounded and one line, whatever it holds.
	hostile := "system/io.vectory.agent = {\n\tstate = " + strings.Repeat("x", 500) + "\n\tlast exit code = a\x1b[31m\nb\n\truns = 1\n}\n"
	recorder.answer(print, launchctlResult{stdout: hostile})
	got, err := host.ServiceState(context.Background())
	if err != nil || len(got.Detail) > 400 || strings.ContainsAny(got.Detail, "\n\x1b") {
		t.Errorf("a long state: %d bytes, %v", len(got.Detail), err)
	}
}

// Only a job that is running with a process is active, and a job that isn't can only be
// waiting: launchd keeps one with KeepAlive until the step ends the trial, so there is
// no failed state, and three more runs than the first are the three restarts.
func TestAJobThatLaunchdKeepsStartingCountsItsRestartsFromItsRuns(t *testing.T) {
	for runs, want := range map[int]int{0: 0, 1: 0, 2: 1, 3: 2, 4: 3, 10: 9} {
		state := launchdPrinted{State: "running", PID: 5, Runs: runs}.serviceState()
		if state.Restarts != want || state.State != "active" || state.PID != 5 {
			t.Errorf("%d runs: %+v", runs, state)
		}
	}
	if state := (launchdPrinted{State: "spawn scheduled", Runs: 3}).serviceState(); state.State != "activating" || state.Restarts != 2 || state.PID != 0 {
		t.Errorf("a job waiting out its throttle: %+v", state)
	}
	if state := (launchdPrinted{State: "running", PID: 7, Runs: 1}).serviceState(); !state.running() || state.failed() {
		t.Errorf("a running job: %+v", state)
	}
}

// realAgentPID is the process of the agent's job in launchctl-print-running.txt, which is
// what launchd printed for it on a Mac.
const realAgentPID = 34373

// listed is what print says of a job launchd lists as running with a process.
func listed(t *testing.T) launchctlResult {
	t.Helper()
	return launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")}
}

// The stop is the bootout, and it reports the job stopped only when launchd no longer
// lists it and the process the job had is gone: launchctl bootout returns when launchd has
// begun to remove the job, and the process is looked for with kill(pid, 0) after that.
func TestStoppingTheAgentJobWaitsForLaunchdToRemoveItAndForItsProcessToBeGone(t *testing.T) {
	host, recorder, slept := newTestMacOSHost(t)
	// The job is listed for the looks that come before the bootout and for two more after
	// it, and then it is gone; its process, realAgentPID in the listing, is there for three
	// looks more.
	recorder.answer("print system/io.vectory.agent", listed(t), listed(t), listed(t), listed(t), notLoaded)
	var looked []int
	remaining := 3
	host.alive = func(pid int) bool {
		looked = append(looked, pid)
		if remaining > 0 {
			remaining--
			return true
		}
		return false
	}
	if err := host.StopService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := recorder.changes(); strings.Join(got, "|") != "bootout system/io.vectory.agent" {
		t.Errorf("stop: %v", got)
	}
	// Two pauses between the looks at the listing that still found the job, then three
	// that found the process, each a quarter of a second after the one before.
	if len(looked) != 4 || looked[0] != realAgentPID {
		t.Errorf("the process was looked for as %v", looked)
	}
	if want := 2 + 3; len(*slept) != want {
		t.Errorf("slept %d times (%v), want %d", len(*slept), *slept, want)
	}
	for _, d := range *slept {
		if d != launchdUnloadPoll {
			t.Errorf("a pause of %s", d)
		}
	}

	// A job that isn't loaded has nothing to boot out, and no process to wait for.
	recorder.calls, *slept, looked = nil, nil, nil
	recorder.answer("print system/io.vectory.agent", notLoaded)
	if err := host.StopService(context.Background()); err != nil || len(recorder.changes()) != 0 || len(looked) != 0 {
		t.Errorf("stopping an unloaded job: %v, %v, %v", err, recorder.changes(), looked)
	}
}

func TestStoppingTheAgentJobGivesUpWhenItsProcessOutlastsTheStopLimit(t *testing.T) {
	host, recorder, slept := newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", listed(t), listed(t), notLoaded)
	host.alive = func(int) bool { return true }
	err := host.StopService(context.Background())
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("process %d is still there", realAgentPID)) {
		t.Fatalf("a process that never went: %v", err)
	}
	total := time.Duration(0)
	for _, d := range *slept {
		total += d
	}
	if total < serviceStopLimit || total > serviceStopLimit+time.Second {
		t.Errorf("the stop waited %s of the %s it has", total, serviceStopLimit)
	}

	// A bootout that fails is the answer, and no process is looked for.
	host, recorder, _ = newTestMacOSHost(t)
	recorder.answer("bootout system/io.vectory.agent", launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"})
	recorder.answer("print system/io.vectory.agent", listed(t))
	host.alive = func(int) bool { t.Error("a process was looked for after a stop that failed"); return false }
	if err := host.StopService(context.Background()); err == nil {
		t.Error("a stop that failed was reported as done")
	}

	// A step that is stopped doesn't keep waiting.
	host, recorder, _ = newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", listed(t), listed(t), notLoaded)
	ctx, cancel := context.WithCancel(context.Background())
	host.alive = func(int) bool { cancel(); return true }
	if err := host.StopService(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("a stop of a stopped step: %v", err)
	}
}

// listingOf is what print says of a job launchd lists as running with the process pid, or
// as loaded with none when pid is 0.
func listingOf(pid int) launchctlResult {
	if pid == 0 {
		return launchctlResult{stdout: "system/io.vectory.agent = {\n\tactive count = 0\n\tstate = not running\n\truns = 1\n\tlast exit code = 0\n}\n"}
	}
	return launchctlResult{stdout: fmt.Sprintf("system/io.vectory.agent = {\n\tactive count = 1\n\tstate = running\n\truns = 1\n\tpid = %d\n}\n", pid)}
}

// makeThePrivateDirectory makes the step's private directory, where a run of the step keeps
// what a later one reads: a run always has it.
func makeThePrivateDirectory(t *testing.T) {
	t.Helper()
	mkdirMode(t, UpdateLocations().Private, 0o700)
}

// leavingRecord is what the step kept of the job it told launchd to remove, or "" when it
// kept nothing.
func leavingRecord(t *testing.T, host *macosUpdateHost) string {
	t.Helper()
	data, err := os.ReadFile(host.leavingPath())
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// launchd goes on listing a job as running while it removes it, and nothing in the listing
// tells that job from one that was started. A stop that gives up leaves such a job, and the
// step is a new process at its next run: the process of the job it told launchd to remove is
// kept in a file until `print` says there is no such job, and a start never takes a listing
// of that process, or of no process, for a start. It waits for launchd within its minute and
// says what it found when launchd isn't done.
func TestAStopThatGivesUpLeavesTheDepartingJobRememberedForTheNextRunAndAListingOfItIsNotAStart(t *testing.T) {
	const print = "print system/io.vectory.agent"
	host, recorder, slept := newTestMacOSHost(t)
	makeThePrivateDirectory(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")

	// launchd takes the bootout in hand and lists the job as running for as long as the stop
	// waits.
	recorder.answer(print, listingOf(4242))
	err := host.StopService(context.Background())
	if err == nil || !strings.Contains(err.Error(), "still stopping after 6 min") {
		t.Fatalf("a stop launchd never finished: %v", err)
	}
	if got := leavingRecord(t, host); got != "4242\n" {
		t.Fatalf("what the step kept of the job it told to leave: %q", got)
	}

	// The next run is a new process. Its start finds the job listed, with that process.
	next := nextRunOf(host, recorder, slept)
	recorder.calls, *slept = nil, nil
	err = next.StartService(context.Background())
	if err == nil || !strings.Contains(err.Error(), "launchd doesn't show the agent's job after 60 s") || !strings.Contains(err.Error(), "it lists only the job it was told to remove, of the process 4242") {
		t.Fatalf("a start that found only the job that was told to leave: %v", err)
	}
	if changes := recorder.changes(); len(changes) != 0 {
		t.Errorf("launchd was asked %v while it removed the job", changes)
	}
	total := time.Duration(0)
	for _, d := range *slept {
		total += d
	}
	if total < launchdStartBound || total > launchdStartBound+launchdUnloadPoll {
		t.Errorf("the start waited %s of its %s", total, launchdStartBound)
	}
	if got := leavingRecord(t, next); got != "4242\n" {
		t.Errorf("the record after a start that found the job still leaving: %q", got)
	}

	// launchd finishes, and the start after that bootstraps the definition and is done when
	// launchd lists the job that was made.
	last := nextRunOf(next, recorder, slept)
	recorder.calls = nil
	recorder.answer(print, listingOf(4242), listingOf(4242), notLoaded, listingOf(4300))
	if err := last.StartService(context.Background()); err != nil {
		t.Fatalf("the start after launchd finished: %v", err)
	}
	if got := strings.Join(recorder.changes(), "|"); got != "bootstrap system "+agent {
		t.Errorf("launchd was asked %q", got)
	}
	if got := leavingRecord(t, last); got != "" {
		t.Errorf("the record is still there after launchd was seen to be done: %q", got)
	}
}

// A listing of another process is a job that was started since, and a listing of the same
// process or of none is the job that is leaving.
func TestAListingIsTheJobThatWasToldToLeaveOnlyWhenItHasThatProcessOrNone(t *testing.T) {
	const print = "print system/io.vectory.agent"
	for name, c := range map[string]struct {
		listing   launchctlResult
		departing bool
	}{
		"the same process":             {listingOf(4242), true},
		"no process":                   {listingOf(0), true},
		"another process":              {listingOf(4300), false},
		"a listing that can't be read": {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n}\n"}, true},
	} {
		t.Run(name, func(t *testing.T) {
			host, recorder, _ := newTestMacOSHost(t)
			makeThePrivateDirectory(t)
			host.rememberLeaving(4242)
			recorder.answer(print, c.listing)
			err := host.StartService(context.Background())
			if c.departing != (err != nil) {
				t.Errorf("a start that found %s: %v", name, err)
			}
			if !c.departing && leavingRecord(t, host) != "" {
				t.Errorf("a job that was started since leaves the record: %q", leavingRecord(t, host))
			}
		})
	}

	// With nothing kept, any listing is a start, as it always was.
	host, recorder, _ := newTestMacOSHost(t)
	recorder.answer(print, listingOf(4242))
	if err := host.StartService(context.Background()); err != nil {
		t.Errorf("a listing when the step told launchd to remove nothing: %v", err)
	}
	// A record that isn't a process ID is no record: only the step writes it, in a
	// directory only root can enter.
	for _, text := range []string{"", "x\n", "-1\n", "4242 4243\n", strings.Repeat("9", 40)} {
		host, recorder, _ := newTestMacOSHost(t)
		makeThePrivateDirectory(t)
		if err := os.WriteFile(host.leavingPath(), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		recorder.answer(print, listingOf(4242))
		if err := host.StartService(context.Background()); err != nil {
			t.Errorf("a record of %q was taken for a job that is leaving: %v", text, err)
		}
	}
}

// What the step keeps is for a bootout that launchd took in hand. A stop that worked leaves
// nothing, and so does one launchd refused: the job it was asked to remove is what it was,
// and a start that finds it listed finds the agent. A bootout that launchd answered "no such
// process" or didn't answer, with the job still listed, may be a removal under way (a
// person's bootout began a moment earlier), and keeps it.
func TestTheStepKeepsTheDepartingJobOnlyForABootoutLaunchdTookInHand(t *testing.T) {
	const print, bootout = "print system/io.vectory.agent", "bootout system/io.vectory.agent"
	refused := launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"}
	for name, c := range map[string]struct {
		bootout launchctlResult
		prints  []launchctlResult
		stopped bool
		kept    string
	}{
		"a stop that worked":                      {launchctlResult{}, []launchctlResult{listingOf(4242), listingOf(4242), listingOf(4242), notLoaded}, true, ""},
		"a bootout launchd refused":               {refused, []launchctlResult{listingOf(4242)}, false, ""},
		"a bootout answered with no such process": {launchctlResult{status: launchctlNoSuchProcess, stderr: "Boot-out failed: 3: No such process"}, []launchctlResult{listingOf(4242)}, false, "4242\n"},
		"a bootout that was killed":               {launchctlResult{status: -1}, []launchctlResult{listingOf(4242)}, false, "4242\n"},
		"a bootout that kept removing the job":    {launchctlResult{status: launchctlInProgress, stderr: "Boot-out failed: 36: Operation now in progress"}, []launchctlResult{listingOf(4242)}, false, "4242\n"},
	} {
		t.Run(name, func(t *testing.T) {
			host, recorder, _ := newTestMacOSHost(t)
			makeThePrivateDirectory(t)
			recorder.answer(bootout, c.bootout)
			recorder.answer(print, c.prints...)
			err := host.StopService(context.Background())
			if (err == nil) != c.stopped {
				t.Fatalf("the stop: %v", err)
			}
			if got := leavingRecord(t, host); got != c.kept {
				t.Errorf("the step kept %q, want %q", got, c.kept)
			}
		})
	}
}

// The start of a job the step told launchd to remove is no start while launchd lists only
// that job, and a request ends on it only when launchd was seen to be done: the reproduction
// of a stop that gives up while launchd takes longer than the stop waits for.
func TestAStopThatGivesUpWhileLaunchdStillRemovesTheJobLeavesTheRequestOpenInEveryRunUntilLaunchdIsDone(t *testing.T) {
	f := newStepFixture(t)
	machine, _ := f.useLaunchd()
	// launchd lists the departing job for 2000 looks, a quarter of a second apart: longer
	// than the six minutes the stop waits for it and than the minute the start waits after.
	machine.removalPrints = 2000
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	oldDigest := f.executableDigest()

	var closedAt int
	for run := 1; run <= 8 && closedAt == 0; run++ {
		if run > 1 {
			f.clock.advance(30 * time.Second)
			f.anotherStepProcess(machine)
		}
		err := f.run()
		journal, found := f.journal()
		open := found && journal.active()
		switch {
		case machine.removing > 0:
			// launchd still lists the job the step told it to remove: nothing may have ended.
			if err == nil || !open || journal.Stage != UpdateStageSwapping {
				t.Fatalf("run %d: launchd is still removing the agent's job, and the run ended %v with the journal %+v (found %v)", run, err, journal, found)
			}
			if f.executableDigest() != oldDigest {
				t.Fatalf("run %d: the executable changed", run)
			}
			if last := f.status().Last; last != nil && last.Release == release.manifestSHA() {
				t.Fatalf("run %d: the request was answered with %+v", run, last)
			}
		case open:
			t.Fatalf("run %d: launchd is done with the job, and the request is still open after a run that ended %v", run, err)
		default:
			closedAt = run
		}
	}
	if closedAt == 0 {
		t.Fatal("the request never ended")
	}
	if closedAt < 3 {
		t.Errorf("the request ended at run %d, before launchd was done with the job it was told to remove", closedAt)
	}
	f.requireAnswered(release, UpdateOutcomeFailed, "INTERRUPTED")
	if service := f.service(); service.State != "active" || service.Version != "0.1.0" {
		t.Errorf("the agent's service when the request ended: %+v", service)
	}
	if !machine.loaded {
		t.Error("launchd has no job for the agent: nothing loaded it after it finished removing the old one")
	}
	if got := f.executableDigest(); got != oldDigest {
		t.Errorf("the executable is %s", got)
	}
	bootouts, bootstraps := 0, 0
	for _, change := range machine.changes() {
		switch {
		case strings.HasPrefix(change, "bootout "):
			bootouts++
		case strings.HasPrefix(change, "bootstrap "):
			bootstraps++
		}
	}
	if bootouts != 1 || bootstraps != 1 {
		t.Errorf("launchd was asked %v: one bootout, then one bootstrap once the job was gone", machine.changes())
	}
	if _, err := os.Stat(filepath.Join(f.paths.Private, updateLeavingFile)); !os.IsNotExist(err) {
		t.Errorf("the record of the job that was told to leave is still there: %v", err)
	}
}

// The start doesn't act on what print says at that instant and no more: it bootstraps a
// job launchd doesn't know, and returns only when launchd lists it.
func TestStartingTheAgentJobBootstrapsItAndConfirmsThatLaunchdListsIt(t *testing.T) {
	host, recorder, slept := newTestMacOSHost(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	const print = "print system/io.vectory.agent"

	// Nothing loaded: bootstrap, a moment for launchd, and a look that shows the job.
	recorder.answer(print, notLoaded, listed(t))
	if err := host.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := recorder.changes(); strings.Join(got, "|") != "bootstrap system "+agent {
		t.Errorf("start: %v", got)
	}
	if len(*slept) != 1 || (*slept)[0] != launchdUnloadPoll {
		t.Errorf("the pauses were %v", *slept)
	}

	// A job launchd lists is a job started, whatever it is doing: running, or waiting out
	// its throttle after its process ended. Nothing is bootstrapped or kicked, and the
	// watch judges it by its runs.
	for name, text := range map[string]string{"running": "launchctl-print-running.txt", "waiting to start again": "launchctl-print-waiting.txt", "not running": "launchctl-print-not-running.txt"} {
		recorder.calls = nil
		recorder.answer(print, launchctlResult{stdout: readTestdata(t, text)})
		if err := host.StartService(context.Background()); err != nil || len(recorder.changes()) != 0 {
			t.Errorf("start of a job that is %s: %v, %v", name, err, recorder.changes())
		}
	}
}

// launchd refuses a bootstrap in the moments while it tears a job down: it is tried again
// every two seconds, for a minute in all.
func TestAStartLaunchdRefusesIsTriedEveryTwoSecondsForAMinute(t *testing.T) {
	refused := launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"}
	const print = "print system/io.vectory.agent"

	host, recorder, slept := newTestMacOSHost(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	// Refused three times (seven seconds are more than the four tries of two seconds
	// the step once made), then taken, then listed.
	recorder.answer(print, notLoaded, notLoaded, notLoaded, notLoaded, listed(t))
	recorder.answer("bootstrap system "+agent, refused, refused, refused, launchctlResult{})
	if err := host.StartService(context.Background()); err != nil {
		t.Fatalf("a start that worked on the fourth try: %v", err)
	}
	wantPauses := []time.Duration{launchdStartPause, launchdStartPause, launchdStartPause, launchdUnloadPoll}
	if fmt.Sprint(*slept) != fmt.Sprint(wantPauses) {
		t.Errorf("the pauses were %v, want %v", *slept, wantPauses)
	}

	// Refused for good: it is the answer after a minute, with what launchd said, and the
	// tries stopped when the minute did.
	host, recorder, slept = newTestMacOSHost(t)
	recorder.answer("bootstrap system "+host.agent.definition, refused)
	err := host.StartService(context.Background())
	if err == nil || !strings.Contains(err.Error(), "launchd doesn't show the agent's job after 60 s") || !strings.Contains(err.Error(), "Bootstrap failed: 5") {
		t.Fatalf("a start that never worked: %v", err)
	}
	total := time.Duration(0)
	for _, d := range *slept {
		total += d
	}
	if want := launchdStartBound; total < want || total > want+launchdStartPause {
		t.Errorf("the start tried for %s, and it has %s", total, want)
	}
	tries := 0
	for _, call := range recorder.calls {
		if strings.HasPrefix(call, "bootstrap ") {
			tries++
		}
	}
	if tries != int(launchdStartBound/launchdStartPause) {
		t.Errorf("%d tries in a minute, two seconds apart", tries)
	}

	// A step that is stopped doesn't keep trying.
	host, recorder, slept = newTestMacOSHost(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := host.StartService(ctx); !errors.Is(err, context.Canceled) || len(*slept) != 0 || len(recorder.changes()) != 0 {
		t.Errorf("a start of a stopped step: %v after %d pauses, %v", err, len(*slept), recorder.changes())
	}
}

// A bootstrap that failed because launchd already has the job (it says "Input/output
// error" then too) is a job that is there: the next look shows it.
func TestABootstrapThatFailedBecauseLaunchdHasTheJobIsAJobStarted(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	recorder.answer("print system/io.vectory.agent", notLoaded, listed(t))
	recorder.answer("bootstrap system "+agent, launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"})
	if err := host.StartService(context.Background()); err != nil {
		t.Errorf("%v", err)
	}
}

// A bootstrap launchd accepts and then drops is looked for again after the pause, and
// bootstrapped again within the same minute. A job that is never listed after launchd
// accepted the bootstrap is an error that says so.
func TestABootstrapLaunchdAcceptsAndDropsIsNotAStart(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	recorder.answer("print system/io.vectory.agent", notLoaded, notLoaded, notLoaded, listed(t))
	if err := host.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	bootstraps := 0
	for _, call := range recorder.calls {
		if call == "bootstrap system "+agent {
			bootstraps++
		}
	}
	if bootstraps != 3 {
		t.Errorf("bootstrapped %d times", bootstraps)
	}

	host, _, _ = newTestMacOSHost(t)
	err := host.StartService(context.Background())
	if err == nil || !strings.Contains(err.Error(), "launchd doesn't show the agent's job after 60 s: launchd accepted the bootstrap and then didn't list the job") {
		t.Errorf("a job that was never listed: %v", err)
	}
}

// What print says other than a job or "no such job" is not a start: it is looked at again,
// and is the answer if it doesn't change.
func TestAPrintThatSaysNothingAboutTheJobIsNeverTakenForAStart(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", launchctlResult{status: -1}, launchctlResult{status: 5, stderr: "Input/output error"}, listed(t))
	if err := host.StartService(context.Background()); err != nil || len(recorder.changes()) != 0 {
		t.Errorf("%v, %v", err, recorder.changes())
	}
	host, recorder, _ = newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", launchctlResult{status: 5, stderr: "Input/output error"})
	err := host.StartService(context.Background())
	if err == nil || !strings.Contains(err.Error(), "launchctl print system/io.vectory.agent failed") || len(recorder.changes()) != 0 {
		t.Errorf("%v, %v", err, recorder.changes())
	}
}

// A job that launchd lost while a build was tried is loaded again, and the host says it
// did; a job it lists is left alone.
func TestReloadingTheAgentJobLoadsItOnlyWhenLaunchdDoesNotKnowIt(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	const print = "print system/io.vectory.agent"

	recorder.answer(print, listed(t))
	if reloaded, err := host.ReloadService(context.Background()); reloaded || err != nil || len(recorder.changes()) != 0 {
		t.Errorf("a job launchd lists: %v, %v, %v", reloaded, err, recorder.changes())
	}

	recorder.calls = nil
	recorder.answer(print, notLoaded, notLoaded, listed(t))
	if reloaded, err := host.ReloadService(context.Background()); !reloaded || err != nil || strings.Join(recorder.changes(), "|") != "bootstrap system "+agent {
		t.Errorf("a job launchd lost: %v, %v, %v", reloaded, err, recorder.changes())
	}

	// A print that said something else is no reason to load anything.
	recorder.calls = nil
	recorder.answer(print, launchctlResult{status: 5, stderr: "Input/output error"})
	if reloaded, err := host.ReloadService(context.Background()); reloaded || err != nil || len(recorder.changes()) != 0 {
		t.Errorf("a print that failed: %v, %v, %v", reloaded, err, recorder.changes())
	}

	// A job launchd won't take again is the error, and it was not reloaded.
	host, recorder, _ = newTestMacOSHost(t)
	recorder.answer("bootstrap system "+host.agent.definition, launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"})
	if reloaded, err := host.ReloadService(context.Background()); reloaded || err == nil || !strings.Contains(err.Error(), "launchd doesn't show the agent's job") {
		t.Errorf("a reload launchd refused: %v, %v", reloaded, err)
	}
}

// A person's `launchctl bootout` of the job during a trial leaves launchd saying it doesn't
// know the job, which the step sees as an inactive service that nothing is trying to start.
func TestAJobLaunchdDoesNotKnowIsInactiveAndUnloadedAndOneItListsIsNeither(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	recorder.answer("print system/io.vectory.agent", notLoaded)
	state, err := host.ServiceState(context.Background())
	if err != nil || state.State != "inactive" || !state.Unloaded {
		t.Errorf("a job launchd doesn't know: %+v, %v", state, err)
	}
	recorder.answer("print system/io.vectory.agent", launchctlResult{stdout: readTestdata(t, "launchctl-print-waiting.txt")})
	state, err = host.ServiceState(context.Background())
	if err != nil || state.State != "activating" || state.Unloaded {
		t.Errorf("a job launchd lists: %+v, %v", state, err)
	}
}

// ---------------------------------------------------------------- reading the agent's definition

func TestTheAgentsDefinitionIsReadOnlyWhenItIsExactlyWhatSetupWrites(t *testing.T) {
	const exe, dir = "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent"
	good := mustLaunchdPlist(t, exe, dir, "_vectory")
	got, err := parseAgentDefinition(good)
	if err != nil || got != (agentDefinition{Account: "_vectory", Executable: exe, StateDir: dir}) {
		t.Fatalf("the definition setup writes: %+v, %v", got, err)
	}
	// An update in place of what doesn't identify the service (the drain's timeout, the
	// umask) is the same service.
	if _, err := parseAgentDefinition(strings.Replace(good, "330", "400", 1)); err != nil {
		t.Errorf("a changed timeout: %v", err)
	}
	// The definition the package installs, written over several lines with a comment.
	packaged, err := os.ReadFile("../../../packaging/launchd/io.vectory.agent.plist")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := parseAgentDefinition(string(packaged)); err != nil || got.Account != "_vectory" || got.Executable != exe {
		t.Errorf("the packaged definition: %+v, %v", got, err)
	}
	for name, text := range map[string]string{
		"another label":                 strings.Replace(good, "<string>io.vectory.agent</string>", "<string>io.other.agent</string>", 1),
		"a Program":                     strings.Replace(good, "<key>RunAtLoad</key>", "<key>Program</key><string>/bin/sh</string><key>RunAtLoad</key>", 1),
		"no UserName":                   strings.Replace(good, "<key>UserName</key><string>_vectory</string>", "", 1),
		"an empty UserName":             strings.Replace(good, "<string>_vectory</string>", "<string></string>", 1),
		"another verb":                  strings.Replace(good, "<string>run</string>", "<string>service</string>", 1),
		"another flag":                  strings.Replace(good, "<string>--state-dir</string>", "<string>--other-dir</string>", 1),
		"a trailing argument":           strings.Replace(good, "</array>", "<string>--extra</string></array>", 1),
		"a missing argument":            strings.Replace(good, "<string>run</string>", "", 1),
		"a relative executable":         strings.Replace(good, "<string>"+exe+"</string>", "<string>vectory</string>", 1),
		"a relative state dir":          strings.Replace(good, "<string>"+dir+"</string>", "<string>state</string>", 1),
		"an executable with ..":         strings.Replace(good, "<string>"+exe+"</string>", "<string>/usr/local/../local/bin/vectory</string>", 1),
		"the arguments twice":           strings.Replace(good, "<key>RunAtLoad</key>", "<key>ProgramArguments</key><array><string>/bin/sh</string></array><key>RunAtLoad</key>", 1),
		"arguments that aren't strings": strings.Replace(good, "<string>run</string>", "<integer>1</integer>", 1),
		"not XML":                       "ProgramArguments = (/usr/local/bin/vectory);",
		"a list at the top":             "<plist><array><string>x</string></array></plist>",
		"an empty document":             "",
		"an unknown element":            strings.Replace(good, "<true/>", "<blob/>", 1),
		"a key with no value":           strings.Replace(good, "<key>RunAtLoad</key><true/>", "<key>RunAtLoad</key>", 1),
		"a value with no key":           strings.Replace(good, "<key>Label</key>", "", 1),
	} {
		if got, err := parseAgentDefinition(text); err == nil {
			t.Errorf("%s was read: %+v", name, got)
		}
	}
	// It agrees with the test setup uses for the same definition.
	for _, other := range []string{
		mustLaunchdPlist(t, exe, dir, "_other"), mustLaunchdPlist(t, "/opt/bin/vectory", dir, "_vectory"), mustLaunchdPlist(t, exe, "/srv/agent", "_vectory"),
	} {
		parsed, err := parseAgentDefinition(other)
		if err != nil {
			t.Fatal(err)
		}
		if plistIdentity(other) == plistIdentity(good) || (parsed == got) {
			t.Errorf("a different service was taken for the same: %+v", parsed)
		}
	}
	// Quoting setup does survives the reading.
	odd, err := parseAgentDefinition(mustLaunchdPlist(t, `/opt/my "apps"/a&b/vectory`, `/srv/a <b>/state`, "_vectory"))
	if err != nil || odd.Executable != `/opt/my "apps"/a&b/vectory` || odd.StateDir != "/srv/a <b>/state" {
		t.Errorf("a definition with quotes, an ampersand and angle brackets: %+v, %v", odd, err)
	}
}

func TestThePropertyListReaderRefusesWhatABoundedReaderMust(t *testing.T) {
	deep := "<plist><dict><key>a</key>" + strings.Repeat("<array>", 20) + strings.Repeat("</array>", 20) + "</dict></plist>"
	many := "<plist><dict><key>a</key><array>" + strings.Repeat("<string>x</string>", plistMaxElements+1) + "</array></dict></plist>"
	for name, text := range map[string]string{
		"nesting too deep":           deep,
		"too many elements":          many,
		"a key twice":                "<plist><dict><key>a</key><true/><key>a</key><false/></dict></plist>",
		"too large":                  "<plist><dict>" + strings.Repeat(" ", maxPlistFile) + "</dict></plist>",
		"markup in a text":           "<plist><dict><key>a</key><string>x<b>y</b></string></dict></plist>",
		"an entity it can't resolve": "<plist><dict><key>a</key><string>&nope;</string></dict></plist>",
		"unclosed":                   "<plist><dict><key>a</key>",
		"another root":               "<dict></dict>",
	} {
		if dict, err := parsePropertyList([]byte(text)); err == nil {
			t.Errorf("%s was read: %v", name, dict)
		}
	}
	dict, err := parsePropertyList([]byte(`<?xml version="1.0" encoding="UTF-8"?><!-- a comment --><plist version="1.0"><dict><key>a</key><string>x &amp; y</string><key>b</key><true/><key>c</key><false/><key>d</key><integer>7</integer><key>e</key><array><string>1</string><dict/></array></dict></plist>`))
	if err != nil {
		t.Fatal(err)
	}
	if !samePlistValue(dict, map[string]any{"a": "x & y", "b": true, "c": false, "d": plistScalar("7"), "e": []any{"1", map[string]any{}}}) {
		t.Errorf("%#v", dict)
	}
}

func TestTheRegisteredServiceOnAMacIsTheOneSetupWroteForThisStateDirectoryAndAnAccountThatExists(t *testing.T) {
	nobody, err := user.Lookup("nobody")
	if err != nil {
		t.Skip("there is no account called nobody here")
	}
	uid, uidErr := strconv.ParseUint(nobody.Uid, 10, 32)
	gid, gidErr := strconv.ParseUint(nobody.Gid, 10, 32)
	if uidErr != nil || gidErr != nil {
		t.Skip("nobody has no numeric user and group")
	}
	host, _, _ := newTestMacOSHost(t)
	const exe, dir = "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent"
	refusedWith := func(name, code string, err error) {
		t.Helper()
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != code {
			t.Errorf("%s: %v, want %s", name, err, code)
		}
	}

	_, err = host.Registered(dir)
	refusedWith("no definition", "NO_SERVICE", err)

	path := writeAgentDefinition(t, host, exe, dir, "nobody")
	got, err := host.Registered(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Executable != exe || got.StateDir != dir || got.Account != (updateAccount{Name: "nobody", UID: uint32(uid), GID: uint32(gid)}) {
		t.Errorf("the registered service: %+v", got)
	}
	// The state directory written another way is the same.
	if _, err := host.Registered(dir + "/"); err != nil {
		t.Errorf("the state directory with a slash: %v", err)
	}
	_, err = host.Registered("/var/lib/another-agent")
	refusedWith("another state directory", "NO_SERVICE", err)

	writeAgentDefinition(t, host, exe, dir, "no-such-account-vectory")
	_, err = host.Registered(dir)
	refusedWith("no such account", "NO_SERVICE", err)

	if err := os.WriteFile(path, []byte(strings.Replace(mustLaunchdPlist(t, exe, dir, "nobody"), "<string>run</string>", "<string>run</string><string>-x</string>", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = host.Registered(dir)
	refusedWith("arguments that aren't setup's", "NO_SERVICE", err)

	// A definition the account could have changed is not read at all.
	writeAgentDefinition(t, host, exe, dir, "nobody")
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatal(err)
	}
	_, err = host.Registered(dir)
	refusedWith("a definition anyone can write", "UNTRUSTED_LOCATION", err)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(host.daemonDir, 0o777); err != nil {
		t.Fatal(err)
	}
	_, err = host.Registered(dir)
	refusedWith("a directory anyone can write", "UNTRUSTED_LOCATION", err)
	if err := os.Chmod(host.daemonDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// A link in place of the definition is refused as one, never followed.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(filepath.Dir(host.daemonDir), "elsewhere.plist")
	if err := os.WriteFile(elsewhere, []byte(mustLaunchdPlist(t, exe, dir, "nobody")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, path); err != nil {
		t.Fatal(err)
	}
	_, err = host.Registered(dir)
	refusedWith("a link", "UNTRUSTED_LOCATION", err)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	// A definition that isn't a property list is no service this step knows.
	if err := os.WriteFile(path, []byte(strings.Repeat("x", maxPlistFile+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = host.Registered(dir)
	refusedWith("a definition too large to read", "NO_SERVICE", err)

	// root is an account that exists; the step's checks refuse it, one level up.
	writeAgentDefinition(t, host, exe, dir, "root")
	if got, err := host.Registered(dir); err != nil || got.Account.UID != 0 {
		t.Errorf("a service that runs as root is reported as it is, for the step to refuse: %+v, %v", got, err)
	}
}

// ---------------------------------------------------------------- packages and the install directory

func TestAnExecutableAPackageOwnsOnAMacIsNotUpdatedBehindItsBack(t *testing.T) {
	host, _, _ := newTestMacOSHost(t)
	for _, executable := range []string{
		"/usr/bin/vectory", "/usr/sbin/vectory", "/bin/vectory", "/sbin/vectory", "/usr/lib/vectory/vectory",
		"/opt/homebrew/bin/vectory", "/opt/homebrew/Cellar/vectory/0.1.0/bin/vectory", "/usr/local/Cellar/vectory/0.1.0/bin/vectory",
		// MacPorts installs into /opt/local.
		"/opt/local/bin/vectory", "/opt/local/libexec/vectory/vectory",
	} {
		if reason, managed := host.PackageManaged(executable); !managed || reason == "" {
			t.Errorf("%s isn't taken for a package's", executable)
		}
	}
	for _, executable := range []string{
		"/usr/local/bin/vectory", "/opt/vectory/vectory", "/usr/binary/vectory", "/Library/Application Support/Vectory/bin/vectory", "/usr/local/Cellar2/vectory",
		"/opt/local2/bin/vectory", "/opt/localbin/vectory", "/opt/locally/vectory",
	} {
		if reason, managed := host.PackageManaged(executable); managed {
			t.Errorf("%s is taken for a package's: %s", executable, reason)
		}
	}

	// Homebrew links /usr/local/bin/vectory into its Cellar: a link to a file under a
	// package directory is the package's file.
	if _, err := os.Stat("/usr/bin/env"); err == nil {
		link := filepath.Join(t.TempDir(), "vectory")
		if err := os.Symlink("/usr/bin/env", link); err != nil {
			t.Fatal(err)
		}
		if _, managed := host.PackageManaged(link); !managed {
			t.Error("a link to a package's file isn't one")
		}
	}

	// The installer package's receipt: whatever the path, the agent is the package's.
	if reason, managed := host.PackageManaged("/opt/vectory/vectory"); managed {
		t.Errorf("with no receipt: %q", reason)
	}
	mkdirMode(t, filepath.Dir(host.receipt), 0o755)
	if err := os.WriteFile(host.receipt, []byte("bom"), 0o644); err != nil {
		t.Fatal(err)
	}
	if reason, managed := host.PackageManaged("/opt/vectory/vectory"); !managed || !strings.Contains(reason, "installer package") {
		t.Errorf("with the receipt: %q, %v", reason, managed)
	}
}

func TestTheInstallerPackageAndTheReceiptThisHostLooksForAreTheOnesTheBuildMakes(t *testing.T) {
	script, err := os.ReadFile("../../../packaging/macos/build-pkg.sh")
	if err != nil {
		t.Fatal(err)
	}
	identifier := strings.TrimSuffix(filepath.Base(macosPackageReceipt), ".bom")
	if !strings.Contains(string(script), "--identifier "+identifier+" ") {
		t.Errorf("packaging/macos/build-pkg.sh builds no package called %s, whose receipt is %s", identifier, macosPackageReceipt)
	}
}

func TestWhatTheStepsDirectoriesDoNotHideAMacIsNeverUnreachable(t *testing.T) {
	host, _, _ := newTestMacOSHost(t)
	for _, path := range []string{"/Library/Application Support/Vectory/agent", "/Users/you/agent", "/private/var/lib/x", "/tmp/x"} {
		if err := host.StateDirReachable(path); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
}

func TestADirectoryAnAdministratorOwnsAtUsrLocalBinIsRefusedWithWhatToDo(t *testing.T) {
	refusal := untrustedLocation("/usr/local/bin belongs to uid 501, not to root")
	got := explainInstallRefusal(refusal)
	var explained *UpdateRefusal
	if !errors.As(got, &explained) || explained.Code != "UNTRUSTED_LOCATION" ||
		explained.Detail != "/usr/local/bin belongs to uid 501, not to root (Homebrew on an Intel Mac takes /usr/local/bin). Install the agent where only root can write" {
		t.Errorf("%v", got)
	}
	// Anything else about that directory, or another directory, is said as it is.
	for _, detail := range []string{
		"/usr/local/bin is writable by its group (mode 0775)", "/usr/local/bin/vectory belongs to uid 501, not to root",
		"/opt/bin belongs to uid 501, not to root", "/usr/local/bin is a symbolic link",
	} {
		same := untrustedLocation(detail)
		if got := explainInstallRefusal(same); got != error(same) {
			t.Errorf("%q was changed to %v", detail, got)
		}
	}
	other := errors.New("some other failure")
	if got := explainInstallRefusal(other); got != other {
		t.Errorf("another error was changed to %v", got)
	}
	if got := explainInstallRefusal(nil); got != nil {
		t.Errorf("no error became %v", got)
	}
}
