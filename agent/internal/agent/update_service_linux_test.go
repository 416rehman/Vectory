//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The privileged step's service manager side on Linux, without a service manager:
// the units' text and what is written, the calls made to systemctl (a recorder
// stands in for it), the reading of the agent's unit, and the decision that a
// package owns the executable. systemd-analyze, which reads unit files offline,
// checks the text when it is installed.

type systemctlRecorder struct {
	calls  []string
	output map[string]string
	fail   map[string]error
}

func (r *systemctlRecorder) run(_ context.Context, args ...string) ([]byte, error) {
	call := strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if err := r.fail[call]; err != nil {
		return nil, err
	}
	return []byte(r.output[call]), nil
}

func newTestLinuxHost(t *testing.T) (*linuxUpdateHost, *systemctlRecorder) {
	t.Helper()
	root := ownTree(t)
	unitDir := filepath.Join(root, "etc", "systemd", "system")
	mkdirMode(t, unitDir, 0o755)
	recorder := &systemctlRecorder{output: map[string]string{}, fail: map[string]error{}}
	host := &linuxUpdateHost{
		unitDir: unitDir, dpkgList: filepath.Join(root, "dpkg", "vectory.list"),
		systemctl: recorder.run, systemdRunning: func() bool { return true },
	}
	return host, recorder
}

func testUnitSpec() updateUnitSpec {
	return updateUnitSpec{StateDir: "/var/lib/vectory-agent", InstallDir: "/usr/local/bin", Helper: "/var/lib/vectory-update/private/helper/vectory"}
}

// unitSettings reads the lines of a unit that have the form Name=value into a list
// per section and name, in order.
func unitSettings(text string) map[string][]string {
	settings := map[string][]string{}
	section := ""
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]"):
			section = line
		case strings.Contains(line, "="):
			name, value, _ := strings.Cut(line, "=")
			settings[section+" "+name] = append(settings[section+" "+name], value)
		}
	}
	return settings
}

// ---------------------------------------------------------------- the units' text

func TestTheStepsUnitTextIsPinnedWordForWord(t *testing.T) {
	service, timer, err := systemdUpdateUnits(testUnitSpec())
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string]string{"vectory-update.service": service, "vectory-update.timer": timer} {
		want, err := os.ReadFile(filepath.Join("testdata", "update", name))
		if err != nil {
			t.Fatal(err)
		}
		if got != string(want) {
			t.Errorf("%s differs from the pinned text:\n%s\nwant:\n%s", name, got, want)
		}
	}
}

func TestTheStepsServiceIsTheSandboxOfTheDesignAndNothingElse(t *testing.T) {
	service, timer, err := systemdUpdateUnits(testUnitSpec())
	if err != nil {
		t.Fatal(err)
	}
	paths := UpdateLocations()
	golden := map[string]string{
		"[Unit] Description":                "Vectory agent update step",
		"[Service] Type":                    "oneshot",
		"[Service] ExecStart":               `"/var/lib/vectory-update/private/helper/vectory" update-helper --state-dir "/var/lib/vectory-agent"`,
		"[Service] TimeoutStartSec":         "1200",
		"[Service] ProtectSystem":           "strict",
		"[Service] ProtectHome":             "true",
		"[Service] PrivateTmp":              "true",
		"[Service] NoNewPrivileges":         "true",
		"[Service] ProtectControlGroups":    "true",
		"[Service] RestrictAddressFamilies": "AF_UNIX",
		"[Service] SystemCallFilter":        "@system-service",
		"[Service] ReadWritePaths":          `"/usr/local/bin" "` + paths.StepDir + `" "` + paths.PolicyDir + `"`,
		"[Service] CapabilityBoundingSet":   "CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_KILL",
	}
	got := unitSettings(service)
	for name, want := range golden {
		if values := got[name]; len(values) != 1 || values[0] != want {
			t.Errorf("%s is %q, want %q", name, values, want)
		}
	}
	if len(got) != len(golden) {
		t.Errorf("the service sets %d things and the design names %d: %v", len(got), len(golden), got)
	}
	// What the step never has: it runs as root with the manager's environment alone,
	// and nothing that would start it with another or let a file change what it runs.
	for _, never := range []string{"User", "Group", "DynamicUser", "Environment", "EnvironmentFile", "PassEnvironment", "ExecStartPre", "ExecStartPost", "ExecStop", "Restart", "AmbientCapabilities", "SupplementaryGroups"} {
		if _, found := got["[Service] "+never]; found {
			t.Errorf("the service sets %s", never)
		}
	}

	goldenTimer := map[string]string{
		"[Unit] Description":        "Vectory agent update step schedule",
		"[Timer] OnBootSec":         "15s",
		"[Timer] OnUnitInactiveSec": "30s",
		"[Timer] AccuracySec":       "5s",
		"[Install] WantedBy":        "timers.target",
	}
	gotTimer := unitSettings(timer)
	for name, want := range goldenTimer {
		if values := gotTimer[name]; len(values) != 1 || values[0] != want {
			t.Errorf("%s is %q, want %q", name, values, want)
		}
	}
	if len(gotTimer) != len(goldenTimer) {
		t.Errorf("the timer sets %d things and the design names %d: %v", len(gotTimer), len(goldenTimer), gotTimer)
	}
}

func TestAValueThatCouldEndALineOrAQuoteIsRefusedBeforeAnythingIsWritten(t *testing.T) {
	host, recorder := newTestLinuxHost(t)
	good := testUnitSpec()
	fields := map[string]func(updateUnitSpec, string) updateUnitSpec{
		"the step's executable": func(s updateUnitSpec, v string) updateUnitSpec { s.Helper = v; return s },
		"the state directory":   func(s updateUnitSpec, v string) updateUnitSpec { s.StateDir = v; return s },
		"the install directory": func(s updateUnitSpec, v string) updateUnitSpec { s.InstallDir = v; return s },
	}
	for _, bad := range []string{
		"/opt/a\nExecStart=/bin/sh", "/opt/a\rb", "/opt/a\x00b", "/opt/a b", "/opt/a b", "/opt/a\x7fb", "/opt/a\u0085b", "/opt/a\tb",
		"/opt/$HOME/bin", "/opt/a$b", "", string([]byte{'/', 0xff, 0xfe}),
	} {
		for name, set := range fields {
			spec := set(good, bad)
			if _, _, err := systemdUpdateUnits(spec); err == nil {
				t.Errorf("%s %q was written into a unit", name, bad)
			}
			if err := host.InstallUnits(spec); err == nil {
				t.Errorf("%s %q was installed", name, bad)
			}
		}
	}
	if entries, _ := os.ReadDir(host.unitDir); len(entries) != 0 {
		t.Errorf("a refused value left %d files in the unit directory", len(entries))
	}
	if len(recorder.calls) != 0 {
		t.Errorf("a refused value reached the service manager: %v", recorder.calls)
	}
}

// What a path may hold that a unit file reads specially, and survives: spaces,
// quotes, backslashes, percent signs and text that isn't ASCII are written inside
// quotes with the escapes systemd reads, and the step reads back what it wrote.
func TestPathsWithSpacesQuotesAndPercentSignsAreWrittenAsTheUnitReadsThemAndReadBack(t *testing.T) {
	for _, dir := range []string{"/opt/my apps/bin", `/opt/we"ird`, `/opt/back\slash`, "/opt/50%/bin", "/opt/ünï/bin", "/opt/it's/bin", "/opt/%h/bin"} {
		spec := updateUnitSpec{StateDir: dir + "/state", InstallDir: dir, Helper: dir + "/helper"}
		service, _, err := systemdUpdateUnits(spec)
		if err != nil {
			t.Errorf("%q: %v", dir, err)
			continue
		}
		if got := installDirOfStepUnit(service); got != dir {
			t.Errorf("the install directory %q reads back as %q", dir, got)
		}
		line := unitSettings(service)["[Service] ExecStart"][0]
		first, err := strconv.QuotedPrefix(line)
		if err != nil {
			t.Errorf("%q: the executable isn't one quoted word: %v", dir, err)
			continue
		}
		if helper, _ := undoUnitArg(first); helper != spec.Helper {
			t.Errorf("the helper %q reads back as %q", spec.Helper, helper)
		}
		if strings.Count(service, "\n") != strings.Count(strings.ReplaceAll(service, "\r", ""), "\n") || strings.ContainsAny(service, "\r\x00") {
			t.Errorf("%q: the service holds a character that could end a line", dir)
		}
		// A percent sign is a specifier to systemd unless it is doubled.
		for _, setting := range []string{"ExecStart", "ReadWritePaths"} {
			for _, value := range unitSettings(service)["[Service] "+setting] {
				if strings.Contains(strings.ReplaceAll(value, "%%", ""), "%") {
					t.Errorf("%q: %s holds a single percent sign: %s", dir, setting, value)
				}
			}
		}
	}
	if got := installDirOfStepUnit("[Service]\nType=oneshot\n"); got != "" {
		t.Errorf("a unit with no ReadWritePaths names the install directory %q", got)
	}
	if got := installDirOfStepUnit("ReadWritePaths=not quoted\n"); got != "" {
		t.Errorf("an unquoted first path names the install directory %q", got)
	}
}

// systemd-analyze may also warn about installed host units pulled in as
// dependencies. Only diagnostics naming one of our generated units assess the
// generated text; a host's unrelated warning cannot make this test fail.
func stepUnitDiagnostics(output string) string {
	var own []string
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if strings.Contains(line, updateServiceUnit) || strings.Contains(line, updateTimerUnit) {
			own = append(own, line)
		}
	}
	return strings.Join(own, "\n")
}

func stepUnitVerifyProblem(output string, commandErr error) error {
	if commandErr != nil {
		return fmt.Errorf("systemd-analyze verify failed: %w\n%s", commandErr, strings.TrimSpace(output))
	}
	if own := stepUnitDiagnostics(output); own != "" {
		return fmt.Errorf("systemd-analyze verify says:\n%s", own)
	}
	return nil
}

func TestStepUnitDiagnosticsIgnoresUnrelatedHostWarnings(t *testing.T) {
	host := "/lib/systemd/system/snapd.service:23: Unknown key name 'RestartMode' in section 'Service', ignoring."
	own := "/tmp/vectory-update.service:12: Failed to parse ProtectSystem=bogus"
	if got := stepUnitDiagnostics(host + "\n" + own); got != own {
		t.Errorf("%q, want %q", got, own)
	}
	if got := stepUnitDiagnostics(host); got != "" {
		t.Errorf("unrelated installed-unit warning: %q", got)
	}
	if err := stepUnitVerifyProblem(host, nil); err != nil {
		t.Errorf("successful verify should ignore unrelated warning: %v", err)
	}
	if err := stepUnitVerifyProblem(host, errors.New("exit status 1")); err == nil || !strings.Contains(err.Error(), "exit status 1") {
		t.Errorf("failed verify must not be hidden by the filter: %v", err)
	}
	if err := stepUnitVerifyProblem(own, nil); err == nil || !strings.Contains(err.Error(), own) {
		t.Errorf("our generated-unit warning must be reported: %v", err)
	}
}

// systemd-analyze reads unit files offline. Its exit status is 0 for a unit it
// only warns about, so the test checks the generated units' diagnostics, and an
// intentionally broken unit must still produce one.
func TestSystemdAcceptsTheStepsUnitsAndHasNothingToSayAboutThem(t *testing.T) {
	analyze, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze isn't installed")
	}
	dir := t.TempDir()
	spec := testUnitSpec()
	spec.Helper, _ = os.Executable()
	service, timer, err := systemdUpdateUnits(spec)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(service, timer string) (string, error) {
		t.Helper()
		for name, text := range map[string]string{updateServiceUnit: service, updateTimerUnit: timer} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		command := exec.Command(analyze, "verify", "--man=no", filepath.Join(dir, updateServiceUnit), filepath.Join(dir, updateTimerUnit))
		out, err := command.CombinedOutput()
		return string(out), err
	}
	out, verifyErr := verify(service, timer)
	if err := stepUnitVerifyProblem(out, verifyErr); err != nil {
		t.Fatal(err)
	}
	broken := strings.Replace(service, "ProtectSystem=strict", "ProtectSystem=bogus", 1)
	out, verifyErr = verify(broken, timer)
	if !strings.Contains(stepUnitDiagnostics(out), "bogus") {
		if verifyErr != nil {
			t.Fatalf("the broken generated unit failed verification without a diagnostic about that unit: %v\n%s", verifyErr, out)
		}
		t.Skipf("this systemd-analyze doesn't warn about an unknown ProtectSystem value, so its silence proves nothing here: %q", out)
	}
}

// ---------------------------------------------------------------- installing and removing

func TestInstallingTheUnitsWritesThemForEveryoneToReadAndStartsTheTimerAndOneRun(t *testing.T) {
	host, recorder := newTestLinuxHost(t)
	spec := testUnitSpec()
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	service, timer, _ := systemdUpdateUnits(spec)
	for name, want := range map[string]string{updateServiceUnit: service, updateTimerUnit: timer} {
		path := filepath.Join(host.unitDir, name)
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Errorf("%s: %q, %v", name, data, err)
		}
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o644 {
			t.Errorf("%s: %v, %v", name, info, err)
		}
	}
	want := []string{"daemon-reload", "enable --now vectory-update.timer", "start --no-block vectory-update.service"}
	if strings.Join(recorder.calls, "|") != strings.Join(want, "|") {
		t.Errorf("the calls were %v, want %v", recorder.calls, want)
	}

	// A call that fails stops the rest and is reported.
	recorder.calls = nil
	recorder.fail["enable --now vectory-update.timer"] = errors.New("systemctl enable failed")
	if err := host.InstallUnits(spec); err == nil || !strings.Contains(err.Error(), "enable") {
		t.Errorf("a timer that wouldn't start: %v", err)
	}
	if len(recorder.calls) != 2 {
		t.Errorf("the calls after the failure: %v", recorder.calls)
	}
}

func TestRemovingTheUnitsStopsThemFirstSaysWhereTheInstallDirectoryWasAndLeavesNothing(t *testing.T) {
	host, recorder := newTestLinuxHost(t)
	if dir, removed, err := host.RemoveUnits(); err != nil || removed || dir != "" || len(recorder.calls) != 0 {
		t.Fatalf("with nothing installed: %q, %v, %v, %v", dir, removed, err, recorder.calls)
	}
	spec := testUnitSpec()
	spec.InstallDir = "/opt/vectory/bin"
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	recorder.calls = nil
	dir, removed, err := host.RemoveUnits()
	if err != nil || !removed || dir != "/opt/vectory/bin" {
		t.Fatalf("removing: %q, %v, %v", dir, removed, err)
	}
	want := []string{"disable --now vectory-update.timer", "stop vectory-update.service", "daemon-reload", "reset-failed vectory-update.service"}
	if strings.Join(recorder.calls, "|") != strings.Join(want, "|") {
		t.Errorf("the calls were %v, want %v", recorder.calls, want)
	}
	if entries, _ := os.ReadDir(host.unitDir); len(entries) != 0 {
		t.Errorf("the unit directory holds %d files", len(entries))
	}

	// A timer that can't be stopped leaves the units where they are, so that what
	// runs is still what the files say.
	if err := host.InstallUnits(spec); err != nil {
		t.Fatal(err)
	}
	recorder.calls = nil
	recorder.fail["disable --now vectory-update.timer"] = errors.New("systemctl disable failed")
	if _, _, err := host.RemoveUnits(); err == nil {
		t.Error("a timer that wouldn't stop was removed")
	}
	if entries, _ := os.ReadDir(host.unitDir); len(entries) != 2 {
		t.Errorf("a failed removal left %d files", len(entries))
	}
}

// ---------------------------------------------------------------- the agent's service

func TestTheServiceStateIsWhatSystemctlShowsAndNothingIsGuessed(t *testing.T) {
	host, recorder := newTestLinuxHost(t)
	show := "show vectory.service --no-pager -p ActiveState -p SubState -p NRestarts -p MainPID"
	for name, c := range map[string]struct {
		output  string
		want    updateServiceState
		wantErr bool
	}{
		"running":                        {"ActiveState=active\nSubState=running\nNRestarts=0\nMainPID=4242\n", updateServiceState{State: "active", Restarts: 0, PID: 4242}, false},
		"restarted twice":                {"ActiveState=active\nSubState=running\nNRestarts=2\nMainPID=4300\n", updateServiceState{State: "active", Restarts: 2, PID: 4300}, false},
		"waiting to restart":             {"ActiveState=activating\nSubState=auto-restart\nNRestarts=1\nMainPID=0\n", updateServiceState{State: "activating", Restarts: 1}, false},
		"failed":                         {"ActiveState=failed\nSubState=failed\nNRestarts=3\nMainPID=0\n", updateServiceState{State: "failed", Restarts: 3}, false},
		"stopped":                        {"ActiveState=inactive\nSubState=dead\nNRestarts=0\nMainPID=0\n", updateServiceState{State: "inactive"}, false},
		"no state":                       {"SubState=running\nNRestarts=0\n", updateServiceState{}, true},
		"no restart count":               {"ActiveState=active\nSubState=running\nMainPID=1\n", updateServiceState{}, true},
		"a restart count that isn't one": {"ActiveState=active\nNRestarts=many\nMainPID=1\n", updateServiceState{}, true},
		"a negative count":               {"ActiveState=active\nNRestarts=-1\nMainPID=1\n", updateServiceState{}, true},
		"nothing":                        {"", updateServiceState{}, true},
	} {
		recorder.output[show] = c.output
		got, err := host.ServiceState(context.Background())
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("%s: %+v, %v", name, got, err)
		}
	}
	recorder.fail[show] = errors.New("systemctl show failed")
	if _, err := host.ServiceState(context.Background()); err == nil {
		t.Error("a manager that didn't answer gave a state")
	}
	for _, call := range recorder.calls {
		if call != show {
			t.Errorf("the state was read with %q", call)
		}
	}
}

func TestStoppingAndStartingTheAgentServiceAreTheCallsTheManagerGetsAndAFailedStateIsResetFirst(t *testing.T) {
	host, recorder := newTestLinuxHost(t)
	if err := host.StopService(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := host.StartService(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"stop vectory.service", "reset-failed vectory.service", "start vectory.service"}
	if strings.Join(recorder.calls, "|") != strings.Join(want, "|") {
		t.Errorf("the calls were %v, want %v", recorder.calls, want)
	}
	// A reset that is refused (the service had not failed) doesn't stop the start; a
	// start that is refused is the answer.
	recorder.calls = nil
	recorder.fail["reset-failed vectory.service"] = errors.New("refused")
	if err := host.StartService(context.Background()); err != nil {
		t.Errorf("a refused reset stopped the start: %v", err)
	}
	recorder.fail["start vectory.service"] = errors.New("systemctl start failed")
	if err := host.StartService(context.Background()); err == nil {
		t.Error("a start that failed was reported as done")
	}
	recorder.fail["stop vectory.service"] = errors.New("systemctl stop failed")
	if err := host.StopService(context.Background()); err == nil {
		t.Error("a stop that failed was reported as done")
	}
}

// runSystemctl is the one place the step runs a program of the host's: with a clean
// environment, with what it prints bounded, and with a failure that says why.
func TestSystemctlIsRunWithACleanEnvironmentAndItsFailureSaysWhy(t *testing.T) {
	dir, err := os.MkdirTemp("", "vectory-systemctl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	script := `#!/bin/sh
case "$1" in
  fail) echo "Failed to connect to bus: No such file or directory" >&2; echo "second line: Unit vectory.service not found." >&2; exit 1 ;;
  loud) head -c 100000 /dev/zero | tr '\0' x; exit 0 ;;
esac
echo "args=$*"
echo "leak=$VECTORY_SYSTEMCTL_LEAK"
echo "path=$PATH"
`
	if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("VECTORY_SYSTEMCTL_LEAK", "secret")

	out, err := runSystemctl(context.Background(), "show", "vectory.service", "-p", "ActiveState")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "args=show vectory.service -p ActiveState\n") || !strings.Contains(string(out), "leak=\n") {
		t.Errorf("systemctl saw: %s", out)
	}
	if _, err := runSystemctl(context.Background(), "fail"); err == nil || !strings.Contains(err.Error(), "Unit vectory.service not found") || !strings.Contains(err.Error(), "systemctl fail failed") {
		t.Errorf("a failure: %v", err)
	}
	if out, err := runSystemctl(context.Background(), "loud"); err != nil || len(out) > 8192 {
		t.Errorf("a command that printed a great deal: %d bytes, %v", len(out), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runSystemctl(ctx, "show"); !errors.Is(err, context.Canceled) {
		t.Errorf("a stopped step: %v", err)
	}
}

// ---------------------------------------------------------------- reading the agent's unit

func TestTheAgentsUnitIsReadOnlyWhenItIsExactlyWhatSetupWrites(t *testing.T) {
	const exe, dir = "/usr/local/bin/vectory", "/var/lib/vectory-agent"
	good := systemdUnitFile(exe, dir, "/etc/vectory/managed", "vectory", "998")
	unit, err := parseAgentUnit(good)
	if err != nil || unit != (agentUnit{User: "vectory", Group: "998", Executable: exe, StateDir: dir}) {
		t.Fatalf("the unit setup writes: %+v, %v", unit, err)
	}
	for name, text := range map[string]string{
		"no ExecStart":          strings.Replace(good, "ExecStart=", "ExecStartNot=", 1),
		"two ExecStart lines":   strings.Replace(good, "Restart=on-failure\n", "Restart=on-failure\nExecStart=/bin/sh\n", 1),
		"no User":               strings.Replace(good, "User=vectory\n", "", 1),
		"two User lines":        strings.Replace(good, "User=vectory\n", "User=vectory\nUser=root\n", 1),
		"no Group":              strings.Replace(good, "Group=998\n", "", 1),
		"an empty User":         strings.Replace(good, "User=vectory", "User=", 1),
		"an empty Group":        strings.Replace(good, "Group=998", "Group=", 1),
		"an unquoted ExecStart": strings.Replace(good, `ExecStart="/usr/local/bin/vectory" run --state-dir "/var/lib/vectory-agent"`, `ExecStart=/usr/local/bin/vectory run --state-dir /var/lib/vectory-agent`, 1),
		"another verb":          strings.Replace(good, " run --state-dir", " service --state-dir", 1),
		"another flag":          strings.Replace(good, " run --state-dir", " run --other-dir", 1),
		"a trailing argument":   strings.Replace(good, `"/var/lib/vectory-agent"`+"\n", `"/var/lib/vectory-agent" --extra`+"\n", 1),
		"a relative executable": strings.Replace(good, `"/usr/local/bin/vectory"`, `"vectory"`, 1),
		"a relative state dir":  strings.Replace(good, `"/var/lib/vectory-agent"`+"\n", `"state"`+"\n", 1),
		"a prefix on ExecStart": strings.Replace(good, "ExecStart=", "ExecStart=-", 1),
		"an empty unit":         "",
	} {
		if unit, err := parseAgentUnit(text); err == nil {
			t.Errorf("%s was read: %+v", name, unit)
		}
	}
	// Quoting setup does survives the reading.
	odd, err := parseAgentUnit(systemdUnitFile(`/opt/my "apps"/50%/vectory`, `/srv/a b/state`, "", "vectory", "998"))
	if err != nil || odd.Executable != `/opt/my "apps"/50%/vectory` || odd.StateDir != "/srv/a b/state" {
		t.Errorf("a unit with quotes, spaces and a percent sign: %+v, %v", odd, err)
	}
}

func TestTheRegisteredServiceIsTheOneSetupWroteForThisStateDirectoryAndAnAccountThatExists(t *testing.T) {
	nobody, err := user.Lookup("nobody")
	if err != nil {
		t.Skip("there is no account called nobody here")
	}
	gid, err := strconv.ParseUint(nobody.Gid, 10, 32)
	if err != nil {
		t.Skip("nobody has no numeric group")
	}
	host, _ := newTestLinuxHost(t)
	const exe, dir = "/usr/local/bin/vectory", "/var/lib/vectory-agent"
	write := func(text string) string {
		path := filepath.Join(host.unitDir, ServiceName)
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	unitFor := func(account, group string) string {
		return systemdUnitFile(exe, dir, "/etc/vectory/managed", account, group)
	}
	refusedWith := func(name, code string, err error) {
		t.Helper()
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != code {
			t.Errorf("%s: %v, want %s", name, err, code)
		}
	}

	if _, err := host.Registered(dir); err == nil {
		t.Error("a host with no unit has a registered service")
	} else {
		refusedWith("no unit", "NO_SERVICE", err)
	}

	write(unitFor("nobody", nobody.Gid))
	got, err := host.Registered(dir)
	if err != nil {
		t.Fatal(err)
	}
	uid, _ := strconv.ParseUint(nobody.Uid, 10, 32)
	if got.Executable != exe || got.StateDir != dir || got.Account != (updateAccount{Name: "nobody", UID: uint32(uid), GID: uint32(gid)}) {
		t.Errorf("the registered service: %+v", got)
	}
	// The same state directory written another way is the same.
	if _, err := host.Registered(dir + "/"); err != nil {
		t.Errorf("the state directory with a slash: %v", err)
	}

	_, err = host.Registered("/var/lib/another-agent")
	refusedWith("another state directory", "NO_SERVICE", err)
	write(unitFor("no-such-account-vectory", nobody.Gid))
	_, err = host.Registered(dir)
	refusedWith("no such account", "NO_SERVICE", err)
	write(unitFor("nobody", "vectory-group"))
	_, err = host.Registered(dir)
	refusedWith("a group that is not a number", "NO_SERVICE", err)
	write(strings.Replace(unitFor("nobody", nobody.Gid), `ExecStart="`, `ExecStart=-"`, 1))
	_, err = host.Registered(dir)
	refusedWith("an ExecStart that isn't setup's", "NO_SERVICE", err)

	// A unit the account could have changed is not read at all.
	path := write(unitFor("nobody", nobody.Gid))
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatal(err)
	}
	_, err = host.Registered(dir)
	refusedWith("a unit anyone can write", "UNTRUSTED_LOCATION", err)

	host.systemdRunning = func() bool { return false }
	write(unitFor("nobody", nobody.Gid))
	_, err = host.Registered(dir)
	refusedWith("no systemd", "NO_SERVICE", err)

	// root is an account that exists; the step's checks refuse it, one level up.
	host.systemdRunning = func() bool { return true }
	write(unitFor("root", "0"))
	if got, err := host.Registered(dir); err != nil || got.Account.UID != 0 {
		t.Errorf("a service that runs as root is reported as it is, for the step to refuse: %+v, %v", got, err)
	}
}

// ---------------------------------------------------------------- packages and the sandbox

func TestAnExecutableAPackageOwnsIsNotUpdatedBehindItsBack(t *testing.T) {
	host, _ := newTestLinuxHost(t)
	for _, executable := range []string{
		"/usr/bin/vectory", "/usr/sbin/vectory", "/bin/vectory", "/sbin/vectory", "/usr/lib/vectory/vectory",
		"/opt/homebrew/bin/vectory", "/usr/local/Cellar/vectory/0.1.0/bin/vectory", "/usr/bin/deeper/still/vectory",
	} {
		if reason, managed := host.PackageManaged(executable); !managed || reason == "" {
			t.Errorf("%s isn't taken for a package's", executable)
		}
	}
	for _, executable := range []string{
		"/usr/local/bin/vectory", "/opt/vectory/vectory", "/usr/binary/vectory", "/usr/libexec/vectory", "/binary/vectory",
		"/srv/usr/bin/vectory", "/usr/local/Cellar2/vectory", "/home/you/vectory", "/opt/localbin/vectory", "/opt/local2/bin/vectory",
		// MacPorts' prefix is a package manager's only on a Mac.
		"/opt/local/bin/vectory", "/opt/local/libexec/vectory/vectory",
	} {
		if reason, managed := host.PackageManaged(executable); managed {
			t.Errorf("%s is taken for a package's: %s", executable, reason)
		}
	}

	// A link to a file under a package directory is the package's file.
	if _, err := os.Stat("/usr/bin/env"); err == nil {
		link := filepath.Join(t.TempDir(), "vectory")
		if err := os.Symlink("/usr/bin/env", link); err != nil {
			t.Fatal(err)
		}
		if _, managed := host.PackageManaged(link); !managed {
			t.Error("a link to a package's file isn't one")
		}
	}

	// The vectory package's file list names the executable exactly.
	mkdirMode(t, filepath.Dir(host.dpkgList), 0o755)
	list := "/.\n/usr/local/share/doc/vectory\n  /srv/vectory/bin/vectory  \n/srv/vectory/bin/vectory-other\n"
	if err := os.WriteFile(host.dpkgList, []byte(list), 0o644); err != nil {
		t.Fatal(err)
	}
	if reason, managed := host.PackageManaged("/srv/vectory/bin/vectory"); !managed || !strings.Contains(reason, "package") {
		t.Errorf("an executable the package lists: %q, %v", reason, managed)
	}
	for _, executable := range []string{"/srv/vectory/bin", "/srv/vectory/bin/vect", "/usr/local/share/doc"} {
		if _, managed := host.PackageManaged(executable); managed {
			t.Errorf("%s is taken for the package's file", executable)
		}
	}
	// The list is read as a bounded file: one that is too large says nothing.
	if err := os.WriteFile(host.dpkgList, []byte(strings.Repeat("x", 5<<20)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, managed := host.PackageManaged("/srv/vectory/bin/vectory"); managed {
		t.Error("a list too large to read was taken for one that names the executable")
	}
}

// MacPorts installs into /opt/local, so an agent there is a package's on a Mac. On Linux
// the same path is a directory like any other: an agent installed with --install-dir
// /opt/local/bin belongs to nobody but its owner, and must not report PACKAGE_MANAGED.
// Every other package directory is one on both systems.
func TestTheMacPortsPrefixIsAPackageDirectoryOnAMacAndOnNoOtherSystem(t *testing.T) {
	mac, _, _ := newTestMacOSHost(t)
	linux, _ := newTestLinuxHost(t)
	for _, executable := range []string{"/opt/local/bin/vectory", "/opt/local/libexec/vectory/vectory"} {
		if reason, managed := mac.PackageManaged(executable); !managed || !strings.Contains(reason, "/opt/local") {
			t.Errorf("on a Mac, %s: %q, %v", executable, reason, managed)
		}
		if reason, managed := linux.PackageManaged(executable); managed {
			t.Errorf("on Linux, %s is taken for a package's: %s", executable, reason)
		}
	}
	for _, executable := range []string{"/usr/bin/vectory", "/opt/homebrew/bin/vectory", "/usr/local/Cellar/vectory/0.1.0/bin/vectory", "/usr/lib/vectory/vectory"} {
		if _, managed := mac.PackageManaged(executable); !managed {
			t.Errorf("on a Mac, %s isn't a package's", executable)
		}
		if _, managed := linux.PackageManaged(executable); !managed {
			t.Errorf("on Linux, %s isn't a package's", executable)
		}
	}
	// The Mac's list is the shared one and one more, and reading either changes neither.
	if len(macosPackageDirectories) != len(packageDirectories)+1 || macosPackageDirectories[len(macosPackageDirectories)-1] != "/opt/local" {
		t.Errorf("the Mac's package directories: %v, the shared ones: %v", macosPackageDirectories, packageDirectories)
	}
}

func TestWhatTheStepsSandboxHidesIsRefusedAsAnUntrustedLocationWithTheReason(t *testing.T) {
	host, _ := newTestLinuxHost(t)
	for path, hiddenBy := range map[string]string{
		"/home/you/vectory": "/home", "/home": "/home", "/root/bin/vectory": "/root", "/run/user/1000/x": "/run/user",
		"/tmp/vectory-state": "/tmp", "/var/tmp/x/y": "/var/tmp", "/home/../home/you/x": "/home",
	} {
		if directory, hidden := hiddenPath(path); !hidden || directory != hiddenBy {
			t.Errorf("%s: %q, %v", path, directory, hidden)
		}
		err := host.StateDirReachable(path)
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != "UNTRUSTED_LOCATION" || !strings.Contains(refusal.Detail, hiddenBy) {
			t.Errorf("the state directory %s: %v", path, err)
		}
		if install, err := host.OpenInstall(filepath.Join(path, "vectory")); err == nil {
			install.Close()
			t.Errorf("an executable under %s was opened", hiddenBy)
		}
	}
	for _, path := range []string{"/var/lib/vectory-agent", "/srv/vectory", "/homework/x", "/rootfs/x", "/run/users/1", "/tmpfiles/x", "/var/tmpx/y", "/opt/tmp/x"} {
		if directory, hidden := hiddenPath(path); hidden {
			t.Errorf("%s is hidden by %s", path, directory)
		}
		if err := host.StateDirReachable(path); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
}

func TestTheLinuxHostOfAShippedAgentIsTheSystemsOwn(t *testing.T) {
	host, ok := platformUpdateHost().(*linuxUpdateHost)
	if !ok || host.unitDir != "/etc/systemd/system" || host.dpkgList != "/var/lib/dpkg/info/vectory.list" || host.systemctl == nil || host.systemdRunning == nil {
		t.Fatalf("the platform's host: %+v", host)
	}
}
