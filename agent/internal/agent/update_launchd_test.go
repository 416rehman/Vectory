//go:build !windows

package agent

import (
	"context"
	"errors"
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
	recorder := &launchctlRecorder{}
	host := newMacOSUpdateHost(recorder.run)
	host.daemonDir = daemons
	host.receipt = filepath.Join(root, "receipts", "com.vectory.agent.bom")
	host.agent = host.job("", recorder.run)
	host.step = host.job(updateLaunchdLabel, recorder.run)
	var slept []time.Duration
	for _, job := range []*launchdJob{&host.agent, &host.step} {
		job.sleep = func(d time.Duration) { slept = append(slept, d) }
	}
	return host, recorder, &slept
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
	// Loaded: print succeeds. It is gone once bootout has returned.
	recorder.answer("print system/io.vectory.update", launchctlResult{stdout: "system/io.vectory.update = {\n\tstate = not running\n\truns = 4\n}\n"})
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
	if err := os.WriteFile(path, []byte(launchdPlist(exe, dir, account)), 0o644); err != nil {
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
	recorder.answer("print system/io.vectory.update", launchctlResult{stdout: "system/io.vectory.update = {\n\tstate = not running\n\truns = 4\n}\n"})
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

func TestTheServiceStateIsWhatLaunchctlPrintsAndNothingIsGuessed(t *testing.T) {
	host, recorder, _ := newTestMacOSHost(t)
	const print = "print system/io.vectory.agent"
	nested := "system/io.vectory.agent = {\n\tstate = running\n\tpid = 11\n\truns = 2\n\tendpoints = {\n\t\t\"x\" = {\n\t\t\tstate = 3\n\t\t\tpid = 999\n\t\t\truns = 77\n\t\t}\n\t}\n}\n"
	for name, c := range map[string]struct {
		result  launchctlResult
		want    updateServiceState
		wantErr bool
	}{
		"running":                          {launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")}, updateServiceState{State: "active", Restarts: 0, PID: 4242}, false},
		"restarted twice":                  {launchctlResult{stdout: readTestdata(t, "launchctl-print-restarted.txt")}, updateServiceState{State: "active", Restarts: 2, PID: 4399}, false},
		"waiting to start again":           {launchctlResult{stdout: readTestdata(t, "launchctl-print-waiting.txt")}, updateServiceState{State: "activating", Restarts: 1}, false},
		"loaded and not running":           {launchctlResult{stdout: readTestdata(t, "launchctl-print-not-running.txt")}, updateServiceState{State: "activating", Restarts: 0}, false},
		"not loaded":                       {notLoaded, updateServiceState{State: "inactive"}, false},
		"not loaded, by its text alone":    {launchctlResult{status: 1, stderr: `Could not find service "io.vectory.agent" in domain for system`}, updateServiceState{State: "inactive"}, false},
		"only the job's own lines count":   {launchctlResult{stdout: nested}, updateServiceState{State: "active", Restarts: 1, PID: 11}, false},
		"running with no process":          {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = 1\n}\n"}, updateServiceState{State: "activating"}, false},
		"no state":                         {launchctlResult{stdout: "system/io.vectory.agent = {\n\truns = 1\n}\n"}, updateServiceState{}, true},
		"no count of runs":                 {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\tpid = 5\n}\n"}, updateServiceState{}, true},
		"a count that isn't one":           {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = many\n}\n"}, updateServiceState{}, true},
		"a negative count":                 {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = -1\n}\n"}, updateServiceState{}, true},
		"a pid that isn't one":             {launchctlResult{stdout: "system/io.vectory.agent = {\n\tstate = running\n\truns = 1\n\tpid = x\n}\n"}, updateServiceState{}, true},
		"nothing printed":                  {launchctlResult{}, updateServiceState{}, true},
		"launchctl failing for its reason": {launchctlResult{status: 5, stderr: "Input/output error"}, updateServiceState{}, true},
		"launchctl that was killed":        {launchctlResult{status: -1}, updateServiceState{}, true},
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
		"a job that ended with a code": {launchctlResult{stdout: readTestdata(t, "launchctl-print-waiting.txt")}, `launchd says the job is "waiting" with pid 0, 2 run(s), last exit code 2`},
		"a job that never exited":      {launchctlResult{stdout: readTestdata(t, "launchctl-print-not-running.txt")}, `last exit code (never exited)`},
		"a job with no exit code":      {launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")}, `with pid 4242, 1 run(s), last exit code -, immediate reason inefficient`},
		"a job launchd doesn't know":   {notLoaded, `launchd doesn't know the job (launchctl print exited 113: Could not find service`},
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

func TestStoppingAndStartingTheAgentJobAreTheCallsLaunchdGetsAndABootstrapItRefusesIsTriedAgain(t *testing.T) {
	host, recorder, slept := newTestMacOSHost(t)
	agent := writeAgentDefinition(t, host, "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent", "_vectory")
	// Stop: the job is loaded, so it is booted out (which waits for the drain).
	recorder.answer("print system/io.vectory.agent", launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")})
	if err := host.StopService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := recorder.changes(); strings.Join(got, "|") != "bootout system/io.vectory.agent" {
		t.Errorf("stop: %v", got)
	}
	// Start, with nothing loaded: bootstrap.
	recorder.calls = nil
	recorder.answer("print system/io.vectory.agent", notLoaded)
	if err := host.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := recorder.changes(); strings.Join(got, "|") != "bootstrap system "+agent {
		t.Errorf("start: %v", got)
	}
	// Start, loaded and not running: kickstart. Running: nothing.
	recorder.calls = nil
	recorder.answer("print system/io.vectory.agent", launchctlResult{stdout: readTestdata(t, "launchctl-print-waiting.txt")})
	if err := host.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := recorder.changes(); strings.Join(got, "|") != "kickstart system/io.vectory.agent" {
		t.Errorf("start of a loaded job: %v", got)
	}
	recorder.calls = nil
	recorder.answer("print system/io.vectory.agent", launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")})
	if err := host.StartService(context.Background()); err != nil || len(recorder.changes()) != 0 {
		t.Errorf("start of a running job: %v, %v", err, recorder.changes())
	}

	// launchd refuses a bootstrap in the moments after a bootout: it is tried again,
	// with a pause, and then it is the answer.
	recorder.calls, *slept = nil, nil
	recorder.answer("print system/io.vectory.agent", notLoaded)
	recorder.answer("bootstrap system "+agent,
		launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"},
		launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"},
		launchctlResult{})
	if err := host.StartService(context.Background()); err != nil {
		t.Errorf("a start that worked on the third try: %v", err)
	}
	if len(*slept) != 2 || (*slept)[0] != launchdStartPause {
		t.Errorf("the pauses were %v", *slept)
	}
	recorder.calls, *slept = nil, nil
	recorder.answer("bootstrap system "+agent, launchctlResult{status: 5, stderr: "Bootstrap failed: 5: Input/output error"})
	err := host.StartService(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Bootstrap failed: 5") || len(*slept) != launchdStartAttempts-1 {
		t.Errorf("a start that never worked: %v after %d pauses", err, len(*slept))
	}
	// A step that is stopped doesn't keep trying.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	recorder.calls, *slept = nil, nil
	if err := host.StartService(ctx); !errors.Is(err, context.Canceled) || len(*slept) != 0 {
		t.Errorf("a start of a stopped step: %v after %d pauses", err, len(*slept))
	}
	recorder.answer("bootout system/io.vectory.agent", launchctlResult{status: 5, stderr: "Boot-out failed: 5: Input/output error"})
	recorder.answer("print system/io.vectory.agent", launchctlResult{stdout: readTestdata(t, "launchctl-print-running.txt")})
	if err := host.StopService(context.Background()); err == nil {
		t.Error("a stop that failed was reported as done")
	}
}

// ---------------------------------------------------------------- reading the agent's definition

func TestTheAgentsDefinitionIsReadOnlyWhenItIsExactlyWhatSetupWrites(t *testing.T) {
	const exe, dir = "/usr/local/bin/vectory", "/Library/Application Support/Vectory/agent"
	good := launchdPlist(exe, dir, "_vectory")
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
		launchdPlist(exe, dir, "_other"), launchdPlist("/opt/bin/vectory", dir, "_vectory"), launchdPlist(exe, "/srv/agent", "_vectory"),
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
	odd, err := parseAgentDefinition(launchdPlist(`/opt/my "apps"/a&b/vectory`, `/srv/a <b>/state`, "_vectory"))
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

	if err := os.WriteFile(path, []byte(strings.Replace(launchdPlist(exe, dir, "nobody"), "<string>run</string>", "<string>run</string><string>-x</string>", 1)), 0o644); err != nil {
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
	if err := os.WriteFile(elsewhere, []byte(launchdPlist(exe, dir, "nobody")), 0o644); err != nil {
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
	} {
		if reason, managed := host.PackageManaged(executable); !managed || reason == "" {
			t.Errorf("%s isn't taken for a package's", executable)
		}
	}
	for _, executable := range []string{"/usr/local/bin/vectory", "/opt/vectory/vectory", "/usr/binary/vectory", "/Library/Application Support/Vectory/bin/vectory", "/usr/local/Cellar2/vectory"} {
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
