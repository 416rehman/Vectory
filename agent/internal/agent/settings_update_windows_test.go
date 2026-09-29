//go:build windows

package agent

import (
	"bytes"
	"context"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func maintenanceAccess(t *testing.T, path string, grant bool) string {
	t.Helper()
	if grant {
		token, err := windows.OpenCurrentProcessToken()
		if err != nil {
			t.Fatal(err)
		}
		defer token.Close()
		user, err := token.GetTokenUser()
		if err != nil {
			t.Fatal(err)
		}
		sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;SY)(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;BA)")
		if err != nil {
			t.Fatal(err)
		}
		acl, _, err := sd.DACL()
		if err != nil {
			t.Fatal(err)
		}
		if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatal(err)
		}
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION)
	if err != nil || sd.String() == "" {
		t.Fatal("cannot inspect maintenance descriptor", err)
	}
	return sd.String()
}

func TestSettingsMaintenancePreservesCurrentWindowsAccess(t *testing.T) {
	f := maintenanceFixture(t)
	doc, err := loadSettingsDocument(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	next := doc.value
	next.MetricsURL = "http://127.0.0.1:9600/metrics"
	prepared, err := doc.prepare(next)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.close()
	// Change access after initial preparation without changing source bytes.
	expected := maintenanceAccess(t, doc.path, true)
	if err = prepared.commit(); err != nil {
		t.Fatal(err)
	}
	if maintenanceAccess(t, doc.path, false) != expected {
		t.Fatal("commit overwrote an intervening access-policy change")
	}
	unlock, err := Lock(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{f.dir, filepath.Join(f.dir, "agent.lock"), doc.path, filepath.Join(f.dir, "state.json")}
	descriptors := map[string]string{}
	for _, path := range paths {
		descriptors[path] = maintenanceAccess(t, path, true)
	}
	if Install(context.Background(), f.dir, "", "", false, nil) == nil {
		t.Fatal("existing install ignored daemon lock")
	}
	unlock()
	for _, operation := range []func() error{
		func() error { return Install(context.Background(), f.dir, "", "", false, nil) },
		func() error { return ConfigureFullVector(f.dir, false) },
		func() error { return ConfigureFullVector(f.dir, true) },
	} {
		if err = operation(); err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			if maintenanceAccess(t, path, false) != descriptors[path] {
				t.Fatalf("maintenance changed access for %s", filepath.Base(path))
			}
		}
	}
}

func TestSettingsMaintenancePartialCommitIsExplicit(t *testing.T) {
	for _, heldFile := range []string{"settings.json", "state.json"} {
		t.Run(heldFile, func(t *testing.T) {
			f := maintenanceFixture(t)
			settingsPath, statePath := filepath.Join(f.dir, "settings.json"), filepath.Join(f.dir, "state.json")
			stateAccess := maintenanceAccess(t, statePath, true)
			ptr, err := windows.UTF16PtrFromString(filepath.Join(f.dir, heldFile))
			if err != nil {
				t.Fatal(err)
			}
			handle, err := windows.CreateFile(ptr, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			err = ConfigureFullVector(f.dir, true)
			_ = windows.CloseHandle(handle)
			if err == nil {
				t.Fatal("held replacement reported success")
			}
			state, _ := os.ReadFile(statePath)
			if !bytes.Equal(state, f.files[statePath]) || maintenanceAccess(t, statePath, false) != stateAccess {
				t.Fatal("failed state replacement lost suppression or permissions")
			}
			if heldFile == "settings.json" {
				settings, _ := os.ReadFile(settingsPath)
				if !bytes.Equal(settings, f.files[settingsPath]) {
					t.Fatal("refused settings replacement changed contents")
				}
			} else {
				settings, _ := LoadSettings(f.dir)
				if !settings.CapabilityPolicy.FullVectorConfig || !strings.Contains(err.Error(), "settings were saved, but retry-suppression reset is incomplete") {
					t.Fatal("partial maintenance result was misleading", err)
				}
				if err = Retry(f.dir); err != nil {
					t.Fatal(err)
				}
				if maintenanceAccess(t, statePath, false) != stateAccess {
					t.Fatal("explicit retry lost service access")
				}
				current := maintenanceFields(t, statePath)
				before, _ := adoptionObject(f.files[statePath])
				if !equalRawJSON(current["future_extension"], before["future_extension"]) {
					t.Fatal("retry dropped unknown state")
				}
			}
		})
	}
}
