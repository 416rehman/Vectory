//go:build windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// The privileged step on Windows: a service of its own, VectoryUpdate, that runs
// as LocalSystem from the helper copy of the agent and runs the step every 30
// seconds, starting at boot; and the Service Control Manager calls the step makes
// on the agent's own service. The agent's service gets no new right: it polls the
// step's status file, and the step is what starts and stops the agent.

const (
	// updateServiceName is how the Service Control Manager knows the step.
	updateServiceName = "VectoryUpdate"

	// windowsServiceIdentity stands for the numeric identity of the agent's service
	// account, which Windows doesn't have: the step only refuses an identity of 0
	// (root), and tells the account apart by its SID wherever it matters.
	windowsServiceIdentity = 1

	// What the step may do with a service: read its registration and state, which
	// every authenticated account may, and start and stop it.
	serviceQueryRights   = windows.SERVICE_QUERY_CONFIG | windows.SERVICE_QUERY_STATUS
	serviceControlRights = serviceQueryRights | windows.SERVICE_START | windows.SERVICE_STOP
)

// openService opens a service with no more access than is asked for.
func openService(name string, access uint32) (*mgr.Service, error) {
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, err
	}
	defer windows.CloseServiceHandle(manager)
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.OpenService(manager, pointer, access)
	if err != nil {
		return nil, err
	}
	return &mgr.Service{Name: name, Handle: handle}, nil
}

var _ updateHost = (*windowsUpdateHost)(nil)

// ---------------------------------------------------------------- the agent's service

// agentServiceCommand reads the command line the agent's service is registered
// with, which `vectory service-install` writes as `<exe> service --state-dir <dir>`,
// each argument quoted as Windows quotes it, and returns the executable and the state
// directory. Anything else isn't the registration setup makes.
func agentServiceCommand(commandLine string) (executable, stateDir string, err error) {
	arguments, err := windows.DecomposeCommandLine(commandLine)
	if err != nil || len(arguments) != 4 || arguments[1] != "service" || arguments[2] != "--state-dir" {
		return "", "", errors.New("its command line isn't `<executable> service --state-dir <directory>`")
	}
	if !filepath.IsAbs(arguments[0]) || !filepath.IsAbs(arguments[3]) {
		return "", "", errors.New("its executable and its state directory aren't absolute paths")
	}
	return arguments[0], arguments[3], nil
}

// registeredFromConfig is what the registration of the agent's service says: the
// executable it runs for the state directory, and the account. The registration
// must be exactly the one `vectory service-install` writes for that executable
// and directory (checkServiceConfig), and for this state directory.
func registeredFromConfig(cfg mgr.Config, stateDir string) (registeredService, error) {
	executable, directory, err := agentServiceCommand(cfg.BinaryPathName)
	if err != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the %s service isn't one this step can update: %v", ServiceName, err)
	}
	if err := checkServiceConfig(cfg, executable, directory); err != nil {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the %s service isn't one this step can update: %v", ServiceName, err)
	}
	if !strings.EqualFold(filepath.Clean(directory), filepath.Clean(stateDir)) {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "the registered service runs the state directory %s, not %s", directory, stateDir)
	}
	return registeredService{
		Executable: executable, StateDir: directory,
		Account: updateAccount{Name: cfg.ServiceStartName, UID: windowsServiceIdentity, GID: windowsServiceIdentity},
	}, nil
}

// Registered reads the registration of the agent's service from the Service
// Control Manager and says what it runs and as whom.
func (h *windowsUpdateHost) Registered(stateDir string) (registeredService, error) {
	service, err := openService(ServiceName, serviceQueryRights)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return registeredService{}, newUpdateRefusal("NO_SERVICE", "no agent service is registered (there is no Windows service called %s)", ServiceName)
	}
	if err != nil {
		return registeredService{}, fmt.Errorf("couldn't read the registration of the %s service: %w", ServiceName, err)
	}
	defer service.Close()
	cfg, err := service.Config()
	if err != nil {
		return registeredService{}, fmt.Errorf("couldn't read the registration of the %s service: %w", ServiceName, err)
	}
	return registeredFromConfig(cfg, stateDir)
}

// observeStatus is what the Service Control Manager reports, as the step's watch
// reads it.
func observeStatus(status svc.Status) observedService {
	observed := observedService{PID: status.ProcessId}
	switch status.State {
	case svc.Running:
		observed.State = "running"
	case svc.StartPending, svc.ContinuePending, svc.PausePending, svc.Paused:
		observed.State = "starting"
	case svc.StopPending:
		observed.State = "stopping"
	default:
		observed.State = "stopped"
		observed.Failed = status.Win32ExitCode != 0
		observed.Crashed = status.Win32ExitCode == uint32(windows.ERROR_PROCESS_ABORTED)
	}
	return observed
}

// ServiceState reads the agent service's state from the Service Control Manager,
// which keeps no count of restarts: the host counts the changes of process and the
// crashes it sees since it started the service (serviceWatch).
func (h *windowsUpdateHost) ServiceState(ctx context.Context) (updateServiceState, error) {
	service, err := openService(ServiceName, serviceQueryRights)
	if err != nil {
		return updateServiceState{}, err
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return updateServiceState{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.watch.observe(observeStatus(status)), nil
}

// StopService stops the agent service, which waits for Vector's graceful drain.
func (h *windowsUpdateHost) StopService(ctx context.Context) error {
	service, err := openService(ServiceName, serviceQueryRights|windows.SERVICE_STOP)
	if err != nil {
		return err
	}
	defer service.Close()
	return stopServiceContext(ctx, service)
}

// StartService starts the agent service, and begins the count of its restarts at
// the process that runs it.
func (h *windowsUpdateHost) StartService(ctx context.Context) error {
	service, err := openService(ServiceName, serviceControlRights)
	if err != nil {
		return err
	}
	defer service.Close()
	if err := startService(service); err != nil {
		return err
	}
	if status, err := service.Query(); err == nil {
		h.mu.Lock()
		h.watch.begin(status.ProcessId)
		h.mu.Unlock()
	}
	return nil
}

// ---------------------------------------------------------------- the step's own service

// updateServiceCommand is the command line the step's service is registered with:
// the helper copy, told the agent's state directory.
func updateServiceCommand(helper, stateDir string) string {
	return windows.EscapeArg(helper) + " update-helper --state-dir " + windows.EscapeArg(stateDir)
}

// updateServiceRecovery is what the Service Control Manager does when the step's
// process ends without a word, as it does for the agent's: restart it after 5
// seconds, 30 seconds, a minute, and then every minute.
var updateServiceRecovery = []mgr.RecoveryAction{
	{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	{Type: mgr.ServiceRestart, Delay: time.Minute},
}

// InstallUnits registers the step's service (LocalSystem, automatic start, delayed
// as the agent's is, the helper copy as its program) or makes the registration there
// what it should be, and starts it. A service that is running runs the helper copy it
// was started from, which may not be the one that is there now, so it is restarted:
// nothing is in progress, or the install would have been refused.
func (h *windowsUpdateHost) InstallUnits(spec updateUnitSpec) error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("registering the update step's service needs an administrator: %w", err)
	}
	defer manager.Disconnect()
	service, err := registerUpdateService(manager, h.stepServiceName(), spec)
	if err != nil {
		return err
	}
	defer service.Close()
	if err := stopServiceContext(context.Background(), service); err != nil {
		return err
	}
	return startService(service)
}

// registerUpdateService makes the registration of the step's service called name
// what it should be and returns the service, open: LocalSystem, automatic start,
// delayed, running the helper copy told the state directory, with the recovery
// actions of the agent's own service. A registration that is there and is already
// that is left alone; one that differs is changed in place, never deleted, because a
// service that is marked for deletion can't be registered again until its handles
// close.
func registerUpdateService(manager *mgr.Mgr, name string, spec updateUnitSpec) (*mgr.Service, error) {
	command := updateServiceCommand(spec.Helper, spec.StateDir)
	service, err := manager.OpenService(name)
	switch {
	case err == nil:
		cfg, err := service.Config()
		if err != nil {
			service.Close()
			return nil, err
		}
		if cfg.BinaryPathName != command || cfg.ServiceStartName != "LocalSystem" || cfg.StartType != mgr.StartAutomatic || !cfg.DelayedAutoStart {
			cfg.BinaryPathName, cfg.ServiceStartName, cfg.Password = command, "LocalSystem", ""
			cfg.StartType, cfg.DelayedAutoStart = mgr.StartAutomatic, true
			if err := service.UpdateConfig(cfg); err != nil {
				service.Close()
				return nil, err
			}
		}
	case errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST):
		service, err = manager.CreateService(name, spec.Helper, mgr.Config{
			DisplayName: "Vectory agent update step", Description: "Applies signed Vectory agent updates that this host agreed to",
			StartType: mgr.StartAutomatic, DelayedAutoStart: true, ServiceStartName: "LocalSystem",
		}, "update-helper", "--state-dir", spec.StateDir)
		if err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	if err := service.SetRecoveryActions(updateServiceRecovery, 24*60*60); err != nil {
		service.Close()
		return nil, err
	}
	return service, nil
}

// agentInstallDirectory is the directory that holds the agent's executable, from the
// registration of its service, or "" when there is none to read.
func agentInstallDirectory(manager *mgr.Mgr) string {
	service, err := manager.OpenService(ServiceName)
	if err != nil {
		return ""
	}
	defer service.Close()
	cfg, err := service.Config()
	if err != nil {
		return ""
	}
	executable, _, err := agentServiceCommand(cfg.BinaryPathName)
	if err != nil {
		return ""
	}
	return filepath.Dir(executable)
}

// waitForProcessExit waits until the process pid has ended, for at most limit: a
// service that has reported itself stopped may not have let go of its executable
// yet, and the step's directory can't be removed while it holds it.
func waitForProcessExit(pid uint32, limit time.Duration) {
	if pid == 0 {
		return
	}
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return
	}
	defer windows.CloseHandle(process)
	_, _ = windows.WaitForSingleObject(process, uint32(limit/time.Millisecond))
}

// RemoveUnits stops the step's service, waits for its process to end, and removes
// it. It reports whether there was a service to remove, and the directory that holds
// the agent's executable, where the step leaves the previous build.
func (h *windowsUpdateHost) RemoveUnits() (string, bool, error) {
	manager, err := mgr.Connect()
	if err != nil {
		return "", false, fmt.Errorf("removing the update step's service needs an administrator: %w", err)
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(h.stepServiceName())
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	defer service.Close()
	installDir := agentInstallDirectory(manager)
	var pid uint32
	if status, err := service.Query(); err == nil {
		pid = status.ProcessId
	}
	if err := stopServiceContext(context.Background(), service); err != nil {
		return installDir, true, err
	}
	waitForProcessExit(pid, 30*time.Second)
	if err := service.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return installDir, true, err
	}
	return installDir, true, nil
}

// ---------------------------------------------------------------- the step's service runs

// updateStepLog is where the step's service writes what the step logs, in its
// private directory: a service has no standard error, and the log is what a person
// looks at when an update did not go as it should. It starts again when it grows past
// a megabyte.
const (
	updateStepLogFile = "update-step.log"
	maxUpdateStepLog  = 1 << 20
)

// redirectStepLog points the step's log at its file and returns what undoes it.
func redirectStepLog() func() {
	path := filepath.Join(UpdateLocations().Private, updateStepLogFile)
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if info, err := os.Stat(path); err == nil && info.Size() > maxUpdateStepLog {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return func() {}
	}
	previous := os.Stderr
	os.Stderr = file
	return func() {
		os.Stderr = previous
		_ = file.Close()
	}
}

// updateServiceHandler is the step's service for the Service Control Manager: it
// runs the step every 30 seconds until it is told to stop, and a run that is under way
// is ended at its next look (the trial polls every two seconds), leaving its journal
// for the next run, as a crash would.
type updateServiceHandler struct{ dir string }

func (h updateServiceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	defer redirectStepLog()()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		runUpdateLoop(ctx, currentUpdateClock(), updateRunInterval,
			func(ctx context.Context) error { return RunUpdateHelper(ctx, h.dir) },
			func(err error) { fmt.Fprintf(os.Stderr, "update step: %v\n", err) })
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-finished:
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				cancel()
				// The manager is told the service is stopping, and again every few seconds
				// while the run in progress ends.
				for checkpoint := uint32(1); checkpoint <= 12; checkpoint++ {
					status <- svc.Status{State: svc.StopPending, CheckPoint: checkpoint, WaitHint: 10000}
					select {
					case <-finished:
						return false, 0
					case <-time.After(5 * time.Second):
					}
				}
				return false, 0
			}
		}
	}
}

// runUpdateService runs the step as the service the Service Control Manager
// started this process as. Anywhere else (a person running `vectory update-helper`
// in a console) it does nothing and says so, and the caller makes the one run.
func runUpdateService(ctx context.Context, dir string) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, nil
	}
	return true, svc.Run(updateServiceName, updateServiceHandler{dir: dir})
}
