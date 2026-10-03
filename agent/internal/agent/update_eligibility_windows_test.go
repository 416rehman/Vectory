//go:build windows

package agent

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/windows/registry"
)

// What the Windows host says about who owns the agent and where its state is.

// installerKeys makes the keys Windows Installer keeps its upgrade codes in, under a
// key of the current user's that the test removes, and returns the base the lookup is
// given and the key of one upgrade code.
func installerKeys(t *testing.T, upgradeCode string) (base string, code registry.Key) {
	t.Helper()
	suffix, err := randomSuffix(4)
	if err != nil {
		t.Fatal(err)
	}
	top := `Software\VectoryUpdateTest` + suffix
	base = top + `\UpgradeCodes`
	packed, err := packInstallerGUID(upgradeCode)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, path := range []string{base + `\` + packed, base, top} {
			_ = registry.DeleteKey(registry.CURRENT_USER, path)
		}
	})
	code, _, err = registry.CreateKey(registry.CURRENT_USER, base+`\`+packed, registry.ALL_ACCESS)
	if err != nil {
		t.Fatalf("making a key under HKEY_CURRENT_USER: %v", err)
	}
	t.Cleanup(func() { _ = code.Close() })
	return base, code
}

func TestAnUpgradeCodeIsRegisteredWhenWindowsInstallerListsAProductUnderIt(t *testing.T) {
	base, code := installerKeys(t, vectoryUpgradeCode)
	registered := func(upgradeCode string) bool {
		t.Helper()
		ok, err := upgradeCodeRegistered(registry.CURRENT_USER, base, upgradeCode)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	// A key with no product under it is a code whose product was removed.
	if registered(vectoryUpgradeCode) {
		t.Error("an upgrade code with no product listed counts as registered")
	}
	// Windows Installer lists a product by its packed code, as the name of a value.
	if err := code.SetStringValue("0123456789ABCDEF0123456789ABCDEF", ""); err != nil {
		t.Fatal(err)
	}
	if !registered(vectoryUpgradeCode) {
		t.Error("an upgrade code with a product listed isn't registered")
	}
	if registered("{00000000-0000-0000-0000-000000000001}") {
		t.Error("another upgrade code is registered")
	}
	if _, err := upgradeCodeRegistered(registry.CURRENT_USER, base, "not a code"); err == nil {
		t.Error("a code that isn't a GUID was looked up")
	}
	// Where nothing is registered at all, nothing is.
	if ok, err := upgradeCodeRegistered(registry.CURRENT_USER, `Software\VectoryUpdateTestNoSuchKey\UpgradeCodes`, vectoryUpgradeCode); err != nil || ok {
		t.Errorf("a base that isn't there: %v, %v", ok, err)
	}
}

// The package's registration is read from the one place Windows Installer keeps it;
// a host that has installed the package says so, and a host that hasn't says nothing.
func TestPackageManagedReadsWhatWindowsInstallerRegisteredForTheRealCode(t *testing.T) {
	registered, err := upgradeCodeRegistered(registry.LOCAL_MACHINE, installerUpgradeCodes, vectoryUpgradeCode)
	if err != nil {
		t.Fatalf("reading Windows Installer's registrations: %v", err)
	}
	reason, managed := newWindowsUpdateHost().PackageManaged(`C:\Program Files\Vectory\vectory.exe`)
	if managed != registered {
		t.Errorf("PackageManaged says %v, and the registry says %v", managed, registered)
	}
	if managed && !strings.Contains(reason, vectoryUpgradeCode) {
		t.Errorf("the reason doesn't name the package: %q", reason)
	}
	if !managed && reason != "" {
		t.Errorf("a host that isn't managed gave the reason %q", reason)
	}
	t.Logf("package-managed on this host: %v", managed)
}

func TestTheStateDirectoryMustBeOnALocalDrive(t *testing.T) {
	host := newWindowsUpdateHost()
	for _, dir := range []string{`C:\ProgramData\Vectory`, `D:\state`} {
		if err := host.StateDirReachable(dir); err != nil {
			t.Errorf("%s: %v", dir, err)
		}
	}
	for _, dir := range []string{`\\server\share\Vectory`, `\\?\C:\ProgramData\Vectory`, `relative\path`, `C:relative`, `C:\a:stream`, ``} {
		err := host.StateDirReachable(dir)
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != "UNTRUSTED_LOCATION" {
			t.Errorf("%q: %v, want UNTRUSTED_LOCATION", dir, err)
		}
	}
}

// A host with the step's gate open and no agent service registered says why it
// can't be updated, with the code the contract has for it, and any account can ask.
func TestAWindowsHostWithNoAgentServiceIsNotEligible(t *testing.T) {
	old := updateHostOverride
	updateHostOverride = newWindowsUpdateHost()
	t.Cleanup(func() { updateHostOverride = old })
	if got := UpdateEligibility(`C:\no such state directory`); got != "NO_SERVICE" {
		t.Errorf("UpdateEligibility: %q, want NO_SERVICE", got)
	}
}
