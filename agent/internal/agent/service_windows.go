//go:build windows

package agent

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"os"
	"path/filepath"
	"time"
)

// ServiceName is how the Service Control Manager knows the agent.
const ServiceName = "Vectory"

// ServiceInstall registers the running executable.
func ServiceInstall(dir, user string) (ServiceRegistration, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return ServiceInstallFor(exe, dir, user)
}

// checkServiceConfig refuses a registration for another executable, state
// directory or account.
func checkServiceConfig(cfg mgr.Config, exe, dir string) error {
	if cfg.ServiceStartName != "NT SERVICE\\Vectory" || cfg.BinaryPathName != windows.EscapeArg(exe)+" service --state-dir "+windows.EscapeArg(dir) {
		return errors.New("the Vectory service is registered for another executable, state directory or account; review it (sc.exe qc Vectory), then remove it with `vectory service-stop` and `vectory service-uninstall` before registering again")
	}
	return nil
}

// serviceRegistrationCheck reports, reading only, whether the Vectory service
// is registered for another executable, state directory or account, which
// ServiceInstallFor refuses. Setup runs it before it stops a running service
// to replace the agent. Without access to the Service Control Manager it
// can't tell, and registration decides.
func serviceRegistrationCheck(exe, dir, account string) error {
	m, err := mgr.Connect()
	if err != nil {
		return nil
	}
	defer m.Disconnect()
	existing, err := m.OpenService(ServiceName)
	if err != nil {
		return nil
	}
	defer existing.Close()
	cfg, err := existing.Config()
	if err != nil {
		return err
	}
	return checkServiceConfig(cfg, exe, dir)
}

// ServiceInstallFor registers exe. Service installation is a local
// administrator action and never a wire capability. Registration does not
// start the workload or imply verified service operation.
func ServiceInstallFor(exe, dir, user string) (ServiceRegistration, error) {
	releaseLifecycle, err := lockLifecycle(dir)
	if err != nil {
		return "", err
	}
	defer releaseLifecycle()
	if err := checkNoPendingPurge(dir); err != nil {
		return "", err
	}
	s, err := LoadSettings(dir)
	if err != nil {
		return "", err
	}
	if err = CheckManagedDirectory(s.ManagedConfig, dir); err != nil {
		return "", err
	}
	m, err := mgr.Connect()
	if err != nil {
		return "", errors.New("SCM registration requires an administrator")
	}
	defer m.Disconnect()
	if existing, e := m.OpenService("Vectory"); e == nil {
		defer existing.Close()
		cfg, e := existing.Config()
		if e != nil {
			return "", e
		}
		if e = checkServiceConfig(cfg, exe, dir); e != nil {
			return "", e
		}
		// Creation may have succeeded before an ACL grant or recovery setup
		// failed. Reconcile both before reporting success on a retry.
		if e = grantWindowsServiceAccess(dir, s.ManagedConfig); e != nil {
			return "", e
		}
		return finishWindowsServiceRegistration(existing, ServiceUnchanged)
	}
	if user != "" && user != "NT SERVICE\\Vectory" {
		return "", errors.New("native SCM adapter uses the dedicated NT SERVICE\\Vectory virtual account; configure other identities explicitly through SCM")
	}
	service, err := m.CreateService("Vectory", exe, mgr.Config{DisplayName: "Vectory agent", Description: "Outbound-only Vector configuration management", StartType: mgr.StartAutomatic, DelayedAutoStart: true, ServiceStartName: "NT SERVICE\\Vectory", SidType: windows.SERVICE_SID_TYPE_UNRESTRICTED}, "service", "--state-dir", dir)
	if err != nil {
		return "", err
	}
	defer service.Close()
	if err = grantWindowsServiceAccess(dir, s.ManagedConfig); err != nil {
		_ = service.Delete()
		return "", err
	}
	return finishWindowsServiceRegistration(service, ServiceCreated)
}

func grantWindowsServiceAccess(dir, managedConfig string) error {
	sid, _, _, err := windows.LookupSID("", "NT SERVICE\\Vectory")
	if err != nil {
		return err
	}
	grant := func(path string, directory bool) error {
		if err := SafePath(path); err != nil {
			return err
		}
		token, err := windows.OpenCurrentProcessToken()
		if err != nil {
			return err
		}
		defer token.Close()
		u, err := token.GetTokenUser()
		if err != nil {
			return err
		}
		inherit := ""
		if directory {
			inherit = "OICI"
		}
		sd, err := windows.SecurityDescriptorFromString("D:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)(A;" + inherit + ";FA;;;" + u.User.Sid.String() + ")(A;" + inherit + ";FA;;;" + sid.String() + ")")
		if err != nil {
			return err
		}
		acl, _, err := sd.DACL()
		if err != nil {
			return err
		}
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, u.User.Sid, nil, acl, nil)
	}
	return grantWindowsServiceFiles(dir, managedConfig, grant)
}

// A matching SCM registration is not proof that the service account can read
// its state or managed configuration. Repeat the grants after an interrupted
// first installation, including files added before a later setup retry.
func grantWindowsServiceFiles(dir, managedConfig string, grant func(path string, directory bool) error) error {
	if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		return grant(path, entry.IsDir())
	}); err != nil {
		return err
	}
	if err := grant(filepath.Dir(managedConfig), true); err != nil {
		return err
	}
	if _, err := os.Stat(managedConfig); err == nil {
		if err := grant(managedConfig, false); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}

type windowsRecoveryService interface {
	SetRecoveryActions([]mgr.RecoveryAction, uint32) error
}

// A newly created service can remain registered when this last SCM call
// fails. A matching registration takes this same path on the next setup, so
// success always means its recovery policy was installed.
func finishWindowsServiceRegistration(service windowsRecoveryService, registration ServiceRegistration) (ServiceRegistration, error) {
	actions := make([]mgr.RecoveryAction, len(agentServiceRestartDelays))
	for i, delay := range agentServiceRestartDelays {
		actions[i] = mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: delay}
	}
	if err := service.SetRecoveryActions(actions, 24*60*60); err != nil {
		return "", err
	}
	return registration, nil
}

func ServiceControl(action string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService("Vectory")
	if err != nil {
		return err
	}
	defer s.Close()
	switch action {
	case "start":
		return startService(s)
	case "stop":
		return stopService(s)
	case "restart":
		if err = stopService(s); err != nil {
			return err
		}
		return startService(s)
	case "uninstall":
		// The update step goes first, and is refused while it is trying a build: the
		// agent's service must not be removed under it.
		if err := RemoveUpdateHelper(); err != nil {
			return err
		}
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Stopped {
			return errors.New("stop Vectory service before removing its registration")
		}
		return s.Delete()
	}
	return errors.New("invalid service operation")
}

// startService starts the service unless it already runs, so setup can be run
// again on a working host.
func startService(s *mgr.Service) error {
	status, err := s.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Running || status.State == svc.StartPending {
		return nil
	}
	if err = s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return err
	}
	return nil
}

// stopService asks the service to stop and waits until it has: the agent
// first stops Vector, and the executable can only be replaced afterwards.
func stopService(s *mgr.Service) error {
	return stopServiceContext(context.Background(), s)
}

// serviceController is what stopping a service needs of it: a *mgr.Service, or a
// test's stand-in.
type serviceController interface {
	Query() (svc.Status, error)
	Control(svc.Cmd) (svc.Status, error)
}

// stopServiceContext is stopService that gives up waiting when ctx ends, which the
// update step needs: its own service is stopped while it waits.
func stopServiceContext(ctx context.Context, s *mgr.Service) error {
	return stopController(ctx, s.Name, s, serviceStopLimit, 250*time.Millisecond)
}

// stopController asks a service to stop, once, and waits until it has, for at most
// limit, looking every so often. A service that is starting takes no control until it
// reports that it is running (the manager answers ERROR_INVALID_SERVICE_CONTROL), so a
// stop that finds one starting waits for that and asks again; one that runs and
// doesn't accept a stop is an error at once.
func stopController(ctx context.Context, name string, s serviceController, limit, every time.Duration) error {
	deadline := time.Now().Add(limit)
	asked := false
	for {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == svc.Stopped {
			return nil
		}
		if !asked && status.State != svc.StopPending {
			_, err := s.Control(svc.Stop)
			switch {
			case err == nil, errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE):
				asked = true
			case errors.Is(err, windows.ERROR_INVALID_SERVICE_CONTROL) && status.State == svc.StartPending:
				// Not asked yet: the service takes no control while it starts.
			default:
				return err
			}
		}
		if time.Now().After(deadline) {
			return errors.New("the " + name + " service didn't stop in time")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
}

// ServiceStatus asks the Service Control Manager about the agent service.
func ServiceStatus(ctx context.Context) ServiceInfo {
	info := ServiceInfo{Manager: "Windows services", Name: ServiceName}
	m, err := mgr.Connect()
	if err != nil {
		return info
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return info
	}
	defer s.Close()
	info.Installed = true
	if status, err := s.Query(); err == nil {
		switch status.State {
		case svc.Running:
			info.State = "running"
		case svc.Stopped:
			info.State = "stopped"
		case svc.StartPending:
			info.State = "starting"
		case svc.StopPending:
			info.State = "stopping"
		default:
			info.State = "paused"
		}
		info.PID = int(status.ProcessId)
	}
	if cfg, err := s.Config(); err == nil {
		info = windowsServiceConfig(info, cfg)
	}
	return info
}

// Read the directory from the same registration format service-install writes.
// Status can then distinguish this global Windows service from another local
// agent installation selected with --state-dir.
func windowsServiceConfig(info ServiceInfo, cfg mgr.Config) ServiceInfo {
	info.Enabled = cfg.StartType == mgr.StartAutomatic
	if _, dir, err := agentServiceCommand(cfg.BinaryPathName); err == nil {
		info.StateDir = dir
	}
	return info
}
