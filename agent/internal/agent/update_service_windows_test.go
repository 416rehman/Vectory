//go:build windows

package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// The Windows step's services: what the agent's registration says (the step reads it
// to find the executable and the account), what the manager reports (the step
// watches the trial through it), and the step's own service, registered, started and
// stopped for real by the Service Control Manager under a name of its own, so that
// the host the tests run on keeps its services as they were.

func requireElevated(t *testing.T) {
	t.Helper()
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("registering a service needs an elevated process: this test runs elevated, as the Windows job does")
	}
}

const agentAccount = `NT SERVICE\Vectory`

func agentRegistration(executable, stateDir string) mgr.Config {
	return mgr.Config{
		ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, StartType: mgr.StartAutomatic, DelayedAutoStart: true,
		ServiceStartName: agentAccount,
		BinaryPathName:   windows.EscapeArg(executable) + " service --state-dir " + windows.EscapeArg(stateDir),
	}
}

func TestTheAgentServiceCommandIsWhatServiceInstallWrites(t *testing.T) {
	for _, tc := range []struct{ executable, stateDir string }{
		{`C:\Program Files\Vectory\vectory.exe`, `C:\ProgramData\Vectory`},
		{`C:\Vectory\vectory.exe`, `D:\state with "quotes" and spaces`},
		{`C:\Users\a b\vectory.exe`, `C:\x\`},
	} {
		executable, stateDir, err := agentServiceCommand(agentRegistration(tc.executable, tc.stateDir).BinaryPathName)
		if err != nil || executable != tc.executable || stateDir != tc.stateDir {
			t.Errorf("%+v: read %q, %q, %v", tc, executable, stateDir, err)
		}
	}
	for name, command := range map[string]string{
		"nothing":                    ``,
		"the executable alone":       `C:\Vectory\vectory.exe`,
		"another command":            `C:\Vectory\vectory.exe run --state-dir C:\x`,
		"another flag":               `C:\Vectory\vectory.exe service --dir C:\x`,
		"an argument more":           `C:\Vectory\vectory.exe service --state-dir C:\x extra`,
		"a relative executable":      `vectory.exe service --state-dir C:\x`,
		"a relative state directory": `C:\Vectory\vectory.exe service --state-dir x`,
	} {
		if _, _, err := agentServiceCommand(command); err == nil {
			t.Errorf("%s: %q was read as a registration", name, command)
		}
	}
}

func TestTheRegistrationOfTheAgentIsEitherExactlyWhatSetupWritesOrNoService(t *testing.T) {
	exe, dir := `C:\Program Files\Vectory\vectory.exe`, `C:\ProgramData\Vectory`
	good := agentRegistration(exe, dir)
	got, err := registeredFromConfig(good, dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Executable != exe || got.StateDir != dir || got.Account.Name != agentAccount || got.Account.UID == 0 {
		t.Errorf("registered %+v", got)
	}
	// The same directory by another spelling is the same directory.
	if _, err := registeredFromConfig(good, strings.ToLower(dir)); err != nil {
		t.Errorf("the state directory in lower case: %v", err)
	}

	for name, mutate := range map[string]func(*mgr.Config){
		"it runs as LocalSystem":        func(c *mgr.Config) { c.ServiceStartName = "LocalSystem" },
		"it runs as another account":    func(c *mgr.Config) { c.ServiceStartName = `.\someone` },
		"it has another command":        func(c *mgr.Config) { c.BinaryPathName = `C:\x\vectory.exe run` },
		"it has an argument more":       func(c *mgr.Config) { c.BinaryPathName += " --debug" },
		"it names no state directory":   func(c *mgr.Config) { c.BinaryPathName = windows.EscapeArg(exe) + " service" },
		"its executable isn't absolute": func(c *mgr.Config) { c.BinaryPathName = `vectory.exe service --state-dir ` + dir },
	} {
		cfg := good
		mutate(&cfg)
		_, err := registeredFromConfig(cfg, dir)
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != "NO_SERVICE" {
			t.Errorf("%s: %v, want NO_SERVICE", name, err)
		}
	}
	// A registration for another state directory is not this agent's.
	_, err = registeredFromConfig(good, `C:\Other`)
	var refusal *UpdateRefusal
	if !errors.As(err, &refusal) || refusal.Code != "NO_SERVICE" || !strings.Contains(refusal.Detail, `C:\Other`) {
		t.Errorf("another state directory: %v", err)
	}
}

func TestWhatTheManagerReportsIsWhatTheWatchIsGiven(t *testing.T) {
	for name, tc := range map[string]struct {
		status svc.Status
		want   observedService
	}{
		"running":              {svc.Status{State: svc.Running, ProcessId: 7}, observedService{State: "running", PID: 7}},
		"starting":             {svc.Status{State: svc.StartPending, ProcessId: 8}, observedService{State: "starting", PID: 8}},
		"continuing":           {svc.Status{State: svc.ContinuePending}, observedService{State: "starting"}},
		"paused":               {svc.Status{State: svc.Paused}, observedService{State: "starting"}},
		"stopping":             {svc.Status{State: svc.StopPending, ProcessId: 9}, observedService{State: "stopping", PID: 9}},
		"stopped cleanly":      {svc.Status{State: svc.Stopped}, observedService{State: "stopped"}},
		"stopped with error 1": {svc.Status{State: svc.Stopped, Win32ExitCode: 1}, observedService{State: "stopped", Failed: true}},
		// 1067: the process ended without the service reporting that it stopped, which
		// is what the manager restarts it for.
		"stopped because it crashed": {svc.Status{State: svc.Stopped, Win32ExitCode: uint32(windows.ERROR_PROCESS_ABORTED)}, observedService{State: "stopped", Failed: true, Crashed: true}},
	} {
		if got := observeStatus(tc.status); got != tc.want {
			t.Errorf("%s: %+v, want %+v", name, got, tc.want)
		}
	}
}

func TestTheStepServiceCommandIsTheHelperCopyToldTheStateDirectory(t *testing.T) {
	for _, tc := range []struct{ helper, stateDir string }{
		{`C:\ProgramData\Vectory\update-state\private\helper\vectory.exe`, `C:\ProgramData\Vectory`},
		{`C:\Program Files\Vectory\helper copy\vectory.exe`, `D:\state "dir"`},
	} {
		arguments, err := windows.DecomposeCommandLine(updateServiceCommand(tc.helper, tc.stateDir))
		if err != nil || len(arguments) != 4 || arguments[0] != tc.helper || arguments[1] != "update-helper" || arguments[2] != "--state-dir" || arguments[3] != tc.stateDir {
			t.Errorf("%+v: %q, %v", tc, arguments, err)
		}
	}
}

// isolatedStepLocations moves every path of the step into a directory of the test
// and gives it no host, so that a step that runs in this process finds nothing of
// the machine's own.
func isolatedStepLocations(t *testing.T) UpdatePaths {
	t.Helper()
	dir := t.TempDir()
	paths := newUpdatePaths(filepath.Join(dir, "policy"), filepath.Join(dir, "step"), true)
	if err := os.MkdirAll(paths.Private, 0o755); err != nil {
		t.Fatal(err)
	}
	oldLocations, oldHost := updateLocationsOverride, updateHostOverride
	updateLocationsOverride, updateHostOverride = &paths, noUpdateHost{}
	t.Cleanup(func() { updateLocationsOverride, updateHostOverride = oldLocations, oldHost })
	return paths
}

// The step's service tells the manager when it is starting, running and stopping,
// answers a question about its state, and ends the run in progress and returns when
// it is told to stop.
func TestTheStepServiceTellsTheManagerWhatItIsDoingAndStopsWhenAsked(t *testing.T) {
	paths := isolatedStepLocations(t)
	requests := make(chan svc.ChangeRequest)
	status := make(chan svc.Status, 32)
	type result struct {
		specific bool
		code     uint32
	}
	done := make(chan result, 1)
	go func() {
		specific, code := updateServiceHandler{dir: t.TempDir()}.Execute(nil, requests, status)
		done <- result{specific, code}
	}()
	next := func(what string) svc.Status {
		t.Helper()
		select {
		case s := <-status:
			return s
		case <-time.After(15 * time.Second):
			t.Fatalf("no status for %s", what)
			return svc.Status{}
		}
	}
	if s := next("the start"); s.State != svc.StartPending {
		t.Fatalf("the first status is %+v, want StartPending", s)
	}
	running := next("running")
	if running.State != svc.Running || running.Accepts&svc.AcceptStop == 0 || running.Accepts&svc.AcceptShutdown == 0 {
		t.Fatalf("the second status is %+v, want Running that accepts stop and shutdown", running)
	}
	requests <- svc.ChangeRequest{Cmd: svc.Interrogate, CurrentStatus: svc.Status{State: svc.Running, ProcessId: 77}}
	if s := next("an interrogation"); s.State != svc.Running || s.ProcessId != 77 {
		t.Errorf("the answer to an interrogation is %+v", s)
	}
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	if s := next("the stop"); s.State != svc.StopPending || s.CheckPoint != 1 || s.WaitHint == 0 {
		t.Errorf("the status after a stop is %+v, want StopPending with a checkpoint and a wait hint", s)
	}
	select {
	case r := <-done:
		if r.specific || r.code != 0 {
			t.Errorf("the service ended with (%v, %d), want a clean stop", r.specific, r.code)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the service didn't return after it was stopped")
	}
	// What the run said went to the step's log, which the person who looks for the
	// reason an update didn't happen reads.
	log, err := os.ReadFile(filepath.Join(paths.Private, updateStepLogFile))
	if err != nil || !strings.Contains(string(log), "update step: ") || !strings.Contains(string(log), errUpdateStepUnavailable.Error()) {
		t.Errorf("the step's log is %q, %v", log, err)
	}
}

// The step replaces the helper copy when a build commits, by renaming the running
// copy aside, and the process goes on running from the file it has. Left like that it
// would run the step of the build that was the helper when it started for as long as
// the host stays up, and the old copy could never be removed, so the service ends with
// an error of its own for the manager to start it again from the new copy.
func TestAHelperWatchSaysWhenTheHelperCopyIsNoLongerTheProgramThatRuns(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "vectory.exe")
	copyTestBinary(t, helper)
	watch := newHelperWatch(helper)
	if watch.replaced() {
		t.Error("the helper copy that is this program was taken for a replacement")
	}
	writeText(t, helper, "the helper copy of the build that committed")
	if !watch.replaced() {
		t.Error("a helper copy that is another program wasn't noticed")
	}
	if err := os.Remove(helper); err != nil {
		t.Fatal(err)
	}
	if watch.replaced() {
		t.Error("a helper copy that can't be read counts as a replacement")
	}
	if (helperWatch{}).replaced() || newHelperWatch(filepath.Join(t.TempDir(), "nothing.exe")).replaced() {
		t.Error("a watch with nothing to compare says the helper was replaced")
	}
}

func TestTheStepServiceEndsWithAnErrorOfItsOwnWhenItsHelperCopyWasReplaced(t *testing.T) {
	paths := isolatedStepLocations(t)
	mkdirAll(t, filepath.Dir(paths.HelperExecutable))
	writeText(t, paths.HelperExecutable, "the helper copy of another build")
	requests := make(chan svc.ChangeRequest)
	status := make(chan svc.Status, 32)
	type result struct {
		specific bool
		code     uint32
	}
	done := make(chan result, 1)
	go func() {
		specific, code := updateServiceHandler{dir: t.TempDir()}.Execute(nil, requests, status)
		done <- result{specific, code}
	}()
	<-status // StartPending
	<-status // Running
	select {
	case r := <-done:
		if !r.specific || r.code != updateServiceRestartCode {
			t.Errorf("the service ended with (%v, %d), want its own error %d", r.specific, r.code, updateServiceRestartCode)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the service didn't end after its helper copy was replaced")
	}
	log, err := os.ReadFile(filepath.Join(paths.Private, updateStepLogFile))
	if err != nil || !strings.Contains(string(log), "the helper copy was replaced") {
		t.Errorf("the step's log is %q, %v", log, err)
	}
}

// A helper copy that is the program the service runs from is no reason to end: the
// service goes on until it is stopped.
func TestTheStepServiceStaysUpWhileItsHelperCopyIsTheProgramItRuns(t *testing.T) {
	paths := isolatedStepLocations(t)
	mkdirAll(t, filepath.Dir(paths.HelperExecutable))
	copyTestBinary(t, paths.HelperExecutable)
	requests := make(chan svc.ChangeRequest)
	status := make(chan svc.Status, 32)
	done := make(chan struct{})
	go func() {
		updateServiceHandler{dir: t.TempDir()}.Execute(nil, requests, status)
		close(done)
	}()
	<-status // StartPending
	<-status // Running
	select {
	case <-done:
		t.Fatal("the service ended with no reason")
	case <-time.After(3 * time.Second):
	}
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the service didn't return after it was stopped")
	}
}

func TestAShutdownStopsTheStepServiceToo(t *testing.T) {
	isolatedStepLocations(t)
	requests := make(chan svc.ChangeRequest)
	status := make(chan svc.Status, 32)
	done := make(chan struct{})
	go func() {
		updateServiceHandler{dir: t.TempDir()}.Execute(nil, requests, status)
		close(done)
	}()
	<-status // StartPending
	<-status // Running
	requests <- svc.ChangeRequest{Cmd: svc.Shutdown}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the service didn't return after a shutdown")
	}
}

// uniqueServiceName is a name no service has: the tests that register a service use
// one, and remove it.
func uniqueServiceName(t *testing.T) string {
	t.Helper()
	suffix, err := randomSuffix(4)
	if err != nil {
		t.Fatal(err)
	}
	return "VectoryUpdateTest" + suffix
}

// forgetService removes a service when the test ends, whatever state it is in.
func forgetService(t *testing.T, name string) {
	t.Helper()
	t.Cleanup(func() {
		manager, err := mgr.Connect()
		if err != nil {
			return
		}
		defer manager.Disconnect()
		service, err := manager.OpenService(name)
		if err != nil {
			return
		}
		defer service.Close()
		_ = stopServiceContext(context.Background(), service)
		_ = service.Delete()
	})
}

// queryService reads the state of a service by name, opening it and letting go of it
// again: a service that is deleted stays until every handle to it is closed.
func queryService(name string) (svc.Status, error) {
	service, err := openService(name, serviceQueryRights)
	if err != nil {
		return svc.Status{}, err
	}
	defer service.Close()
	return service.Query()
}

func serviceRegistered(name string) bool {
	_, err := queryService(name)
	return err == nil
}

func connectManager(t *testing.T) *mgr.Mgr {
	t.Helper()
	manager, err := mgr.Connect()
	if err != nil {
		t.Fatalf("connecting to the Service Control Manager: %v", err)
	}
	t.Cleanup(func() { _ = manager.Disconnect() })
	return manager
}

func TestTheStepServiceIsRegisteredAsTheDesignSaysAndTheRegistrationIsMended(t *testing.T) {
	requireElevated(t)
	manager := connectManager(t)
	name := uniqueServiceName(t)
	forgetService(t, name)
	spec := updateUnitSpec{StateDir: `C:\state dir`, InstallDir: `C:\Program Files\Vectory`, Helper: `C:\Program Files\Vectory\helper copy\vectory.exe`}

	check := func(when string, service *mgr.Service) {
		t.Helper()
		cfg, err := service.Config()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.BinaryPathName != updateServiceCommand(spec.Helper, spec.StateDir) {
			t.Errorf("%s: the program is %q, want %q", when, cfg.BinaryPathName, updateServiceCommand(spec.Helper, spec.StateDir))
		}
		if cfg.ServiceStartName != "LocalSystem" || cfg.StartType != mgr.StartAutomatic || !cfg.DelayedAutoStart || cfg.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS {
			t.Errorf("%s: account %q, start type %d, delayed %v, service type %#x", when, cfg.ServiceStartName, cfg.StartType, cfg.DelayedAutoStart, cfg.ServiceType)
		}
		actions, err := service.RecoveryActions()
		if err != nil {
			t.Fatal(err)
		}
		if len(actions) != len(updateServiceRecovery) {
			t.Fatalf("%s: recovery actions %+v", when, actions)
		}
		for i, want := range updateServiceRecovery {
			if actions[i].Type != want.Type || actions[i].Delay != want.Delay {
				t.Errorf("%s: recovery action %d is %+v, want %+v", when, i+1, actions[i], want)
			}
		}
		if period, err := service.ResetPeriod(); err != nil || period != 24*60*60 {
			t.Errorf("%s: the failure count resets after %d s (%v)", when, period, err)
		}
		// The step's service ends with an error of its own to be started again.
		if nonCrash, err := service.RecoveryActionsOnNonCrashFailures(); err != nil || !nonCrash {
			t.Errorf("%s: the recovery actions don't apply to a service that stops with an error (%v, %v)", when, nonCrash, err)
		}
	}

	service, err := registerUpdateService(manager, name, spec)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	check("after the first registration", service)

	// Registering again leaves what is there.
	again, err := registerUpdateService(manager, name, spec)
	if err != nil {
		t.Fatal(err)
	}
	check("after a second registration", again)
	again.Close()

	// A registration somebody changed is made what it should be, in place.
	cfg, err := service.Config()
	if err != nil {
		t.Fatal(err)
	}
	cfg.BinaryPathName, cfg.StartType, cfg.DelayedAutoStart = `C:\elsewhere\vectory.exe update-helper`, mgr.StartManual, false
	if err := service.UpdateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if err := service.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.NoAction}}, 60); err != nil {
		t.Fatal(err)
	}
	if err := service.SetRecoveryActionsOnNonCrashFailures(false); err != nil {
		t.Fatal(err)
	}
	mended, err := registerUpdateService(manager, name, spec)
	if err != nil {
		t.Fatal(err)
	}
	defer mended.Close()
	check("after the registration was changed and mended", mended)
}

// The step's service for real: the Service Control Manager starts the helper copy as
// LocalSystem, the copy runs as the service and not as a console program, and a stop
// ends it with a clean exit. InstallUnits and RemoveUnits are the ones the step's
// own setup and removal call.
func TestInstallUnitsStartsTheStepServiceAndRemoveUnitsStopsAndDeletesIt(t *testing.T) {
	requireElevated(t)
	name := uniqueServiceName(t)
	forgetService(t, name)
	dir, err := finalDirectoryPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(dir, "state")
	paths := newUpdatePaths(filepath.Join(stateDir, "policy"), filepath.Join(stateDir, "step"), true)
	if err := os.MkdirAll(paths.Private, 0o755); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(dir, "step-service.exe")
	copyTestBinary(t, helper)

	host := &windowsUpdateHost{stepService: name}
	if err := host.InstallUnits(updateUnitSpec{StateDir: stateDir, InstallDir: dir, Helper: helper}); err != nil {
		t.Fatalf("InstallUnits: %v", err)
	}
	var pid uint32
	if !becomes(30*time.Second, func() bool {
		status, err := queryService(name)
		pid = status.ProcessId
		return err == nil && status.State == svc.Running
	}) {
		status, err := queryService(name)
		t.Fatalf("the step's service isn't running after InstallUnits: %+v, %v", status, err)
	}
	if pid == 0 {
		t.Error("the running service has no process")
	}
	// It ran the step, which said there is no step on this build, in the log.
	if !becomes(15*time.Second, func() bool {
		log, err := os.ReadFile(filepath.Join(paths.Private, updateStepLogFile))
		return err == nil && strings.Contains(string(log), errUpdateStepUnavailable.Error())
	}) {
		t.Error("the service didn't run the step: its log says nothing")
	}

	// Installing again is a restart of the same registration, not an error.
	if err := host.InstallUnits(updateUnitSpec{StateDir: stateDir, InstallDir: dir, Helper: helper}); err != nil {
		t.Errorf("InstallUnits again: %v", err)
	}

	installDir, removed, err := host.RemoveUnits()
	if err != nil || !removed {
		t.Fatalf("RemoveUnits: %q, %v, %v", installDir, removed, err)
	}
	if !becomes(15*time.Second, func() bool { return !serviceRegistered(name) }) {
		t.Error("the step's service is still registered after RemoveUnits")
	}
	if _, removed, err := host.RemoveUnits(); err != nil || removed {
		t.Errorf("RemoveUnits with no service: removed %v, %v", removed, err)
	}
	// The process is gone, and its program can be removed.
	if !becomes(10*time.Second, func() bool { return os.Remove(helper) == nil }) {
		t.Error("the helper copy can't be removed after the service ended")
	}
}

func TestRemoveUnitsOfAHostWithoutTheStepServiceSaysThereWasNone(t *testing.T) {
	requireElevated(t)
	host := &windowsUpdateHost{stepService: uniqueServiceName(t)}
	installDir, removed, err := host.RemoveUnits()
	if err != nil || removed || installDir != "" {
		t.Errorf("RemoveUnits: %q, %v, %v", installDir, removed, err)
	}
}

func TestTheAgentServiceIsReadByTheHostThatHasNone(t *testing.T) {
	// Nothing in this test registers the agent's service: a host the tests run on
	// has none, or has the one of an earlier job, and the answer is NO_SERVICE or a
	// registration for another state directory; never an error that isn't a refusal.
	_, err := newWindowsUpdateHost().Registered(`C:\no such state directory`)
	var refusal *UpdateRefusal
	if !errors.As(err, &refusal) || refusal.Code != "NO_SERVICE" {
		t.Errorf("Registered: %v, want a NO_SERVICE refusal", err)
	}
}
