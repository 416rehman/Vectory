//go:build windows

package agent

import (
	"errors"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"os"
	"path/filepath"
	"time"
)

// Service installation is a local administrator action and never a wire capability.
// Registration does not start the workload or imply verified service operation.
func ServiceInstall(dir, user string) error {
	s, err := LoadSettings(dir)
	if err != nil {
		return err
	}
	if err = CheckManagedDirectory(s.ManagedConfig, dir); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return errors.New("SCM registration requires an administrator")
	}
	defer m.Disconnect()
	if existing, e := m.OpenService("Vectory"); e == nil {
		defer existing.Close()
		cfg, e := existing.Config()
		if e != nil {
			return e
		}
		if cfg.ServiceStartName != "NT SERVICE\\Vectory" || cfg.BinaryPathName != windows.EscapeArg(exe)+" service --state-dir "+windows.EscapeArg(dir) {
			return errors.New("existing Vectory service uses another binary, state directory or account; preserve and inspect it locally")
		}
		return nil
	}
	if user != "" && user != "NT SERVICE\\Vectory" {
		return errors.New("native SCM adapter uses the dedicated NT SERVICE\\Vectory virtual account; configure other identities explicitly through SCM")
	}
	service, err := m.CreateService("Vectory", exe, mgr.Config{DisplayName: "Vectory agent", Description: "Outbound-only Vector configuration management", StartType: mgr.StartAutomatic, DelayedAutoStart: true, ServiceStartName: "NT SERVICE\\Vectory", SidType: windows.SERVICE_SID_TYPE_UNRESTRICTED}, "service", "--state-dir", dir)
	if err != nil {
		return err
	}
	defer service.Close()
	sid, _, _, err := windows.LookupSID("", "NT SERVICE\\Vectory")
	if err != nil {
		_ = service.Delete()
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
		sd, err := windows.SecurityDescriptorFromString("D:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;" + u.User.Sid.String() + ")(A;" + inherit + ";FA;;;" + sid.String() + ")")
		if err != nil {
			return err
		}
		acl, _, err := sd.DACL()
		if err != nil {
			return err
		}
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, u.User.Sid, nil, acl, nil)
	}
	for _, root := range []string{dir} {
		if err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			return grant(path, entry.IsDir())
		}); err != nil {
			_ = service.Delete()
			return err
		}
	}
	if err = grant(filepath.Dir(s.ManagedConfig), true); err != nil {
		_ = service.Delete()
		return err
	}
	if _, err = os.Stat(s.ManagedConfig); err == nil {
		if err = grant(s.ManagedConfig, false); err != nil {
			_ = service.Delete()
			return err
		}
	} else if !os.IsNotExist(err) {
		_ = service.Delete()
		return err
	}
	return service.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}, {Type: mgr.ServiceRestart, Delay: 30 * time.Second}, {Type: mgr.ServiceRestart, Delay: time.Minute}}, 24*60*60)
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
		return s.Start()
	case "stop":
		_, err = s.Control(svc.Stop)
		return err
	case "uninstall":
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
