//go:build windows

package agent

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// What the Windows host says about who owns the agent: a package manager (the
// Windows Installer package, packaging/windows/vectory.wxs), and a state directory
// the step can reach. What else makes a host ineligible is asked of the same
// places on every platform (inspectHost): the service registered for this
// executable and this state directory (Registered), a root-owned install path
// (OpenInstall), and room (FreeSpace).

// installerUpgradeCodes is where Windows Installer lists, for each upgrade code, the
// products installed with it. Windows Installer's own keys are shared by the 32-bit
// and the 64-bit views of the registry, and the agent is a native program.
const installerUpgradeCodes = `SOFTWARE\Classes\Installer\UpgradeCodes`

// upgradeCodeRegistered reports whether Windows Installer has a product registered
// under upgradeCode: a key named for the packed code (packInstallerGUID) that lists at
// least one product, under the registry key base of root. Production asks
// HKEY_LOCAL_MACHINE; a test asks a key it made.
func upgradeCodeRegistered(root registry.Key, base, upgradeCode string) (bool, error) {
	packed, err := packInstallerGUID(upgradeCode)
	if err != nil {
		return false, err
	}
	key, err := registry.OpenKey(root, base+`\`+packed, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer key.Close()
	info, err := key.Stat()
	if err != nil {
		return false, err
	}
	return info.ValueCount > 0, nil
}

// PackageManaged says whether Windows Installer owns the agent: the package's upgrade
// code is registered, so that a repair or an upgrade would undo an update made behind
// its back. The registration is read the way every account may read it, and an
// account that can't read it is told the agent is not a package's, which the step
// (SYSTEM) corrects in the status it reports.
func (h *windowsUpdateHost) PackageManaged(executable string) (string, bool) {
	registered, err := upgradeCodeRegistered(registry.LOCAL_MACHINE, installerUpgradeCodes, vectoryUpgradeCode)
	if err != nil || !registered {
		return "", false
	}
	return "Windows Installer has the agent's package registered (upgrade code " + vectoryUpgradeCode + ")", true
}

// StateDirReachable refuses a state directory that isn't on a local drive: the
// step reads what the service account wrote there by walking its path from the root
// of the drive.
func (h *windowsUpdateHost) StateDirReachable(stateDir string) error {
	if err := adoptionLocalPath(stateDir); err != nil {
		return untrustedLocation(fmt.Sprintf("the agent's state directory %s isn't on a local drive, which is where the update step reads it", stateDir))
	}
	return nil
}
