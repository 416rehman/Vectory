package agent

import (
	"strings"
	"testing"
)

func TestUpdateLocationsOnEachOperatingSystem(t *testing.T) {
	for _, tc := range []struct {
		name        string
		goos        string
		programData string
		want        UpdatePaths
	}{
		{"Linux", "linux", "", UpdatePaths{
			PolicyDir: "/etc/vectory/updates", Policy: "/etc/vectory/updates/policy.json",
			StepDir: "/var/lib/vectory-update", Status: "/var/lib/vectory-update/status.json",
			Probe: "/var/lib/vectory-update/probe", Private: "/var/lib/vectory-update/private",
			Journal: "/var/lib/vectory-update/private/journal.json", Counters: "/var/lib/vectory-update/private/counters.json",
			Installed: "/var/lib/vectory-update/private/installed.json", Staging: "/var/lib/vectory-update/private/staging",
			Helper: "/var/lib/vectory-update/private/helper", HelperExecutable: "/var/lib/vectory-update/private/helper/vectory",
		}},
		{"macOS", "darwin", "", UpdatePaths{
			PolicyDir: "/Library/Application Support/Vectory/updates", Policy: "/Library/Application Support/Vectory/updates/policy.json",
			StepDir: "/Library/Application Support/Vectory/update-state", Status: "/Library/Application Support/Vectory/update-state/status.json",
			Probe: "/Library/Application Support/Vectory/update-state/probe", Private: "/Library/Application Support/Vectory/update-state/private",
			Journal: "/Library/Application Support/Vectory/update-state/private/journal.json", Counters: "/Library/Application Support/Vectory/update-state/private/counters.json",
			Installed: "/Library/Application Support/Vectory/update-state/private/installed.json", Staging: "/Library/Application Support/Vectory/update-state/private/staging",
			Helper: "/Library/Application Support/Vectory/update-state/private/helper", HelperExecutable: "/Library/Application Support/Vectory/update-state/private/helper/vectory",
		}},
		{"Windows", "windows", `C:\ProgramData`, UpdatePaths{
			PolicyDir: `C:\ProgramData\Vectory\updates`, Policy: `C:\ProgramData\Vectory\updates\policy.json`,
			StepDir: `C:\ProgramData\Vectory\update-state`, Status: `C:\ProgramData\Vectory\update-state\status.json`,
			Probe: `C:\ProgramData\Vectory\update-state\probe`, Private: `C:\ProgramData\Vectory\update-state\private`,
			Journal: `C:\ProgramData\Vectory\update-state\private\journal.json`, Counters: `C:\ProgramData\Vectory\update-state\private\counters.json`,
			Installed: `C:\ProgramData\Vectory\update-state\private\installed.json`, Staging: `C:\ProgramData\Vectory\update-state\private\staging`,
			Helper: `C:\ProgramData\Vectory\update-state\private\helper`, HelperExecutable: `C:\ProgramData\Vectory\update-state\private\helper\vectory.exe`,
		}},
		{"Windows with ProgramData elsewhere", "windows", `D:\Data\`, UpdatePaths{
			PolicyDir: `D:\Data\Vectory\updates`, Policy: `D:\Data\Vectory\updates\policy.json`,
			StepDir: `D:\Data\Vectory\update-state`, Status: `D:\Data\Vectory\update-state\status.json`,
			Probe: `D:\Data\Vectory\update-state\probe`, Private: `D:\Data\Vectory\update-state\private`,
			Journal: `D:\Data\Vectory\update-state\private\journal.json`, Counters: `D:\Data\Vectory\update-state\private\counters.json`,
			Installed: `D:\Data\Vectory\update-state\private\installed.json`, Staging: `D:\Data\Vectory\update-state\private\staging`,
			Helper: `D:\Data\Vectory\update-state\private\helper`, HelperExecutable: `D:\Data\Vectory\update-state\private\helper\vectory.exe`,
		}},
		{"Windows with no ProgramData", "windows", "", UpdatePaths{
			PolicyDir: `C:\ProgramData\Vectory\updates`, Policy: `C:\ProgramData\Vectory\updates\policy.json`,
			StepDir: `C:\ProgramData\Vectory\update-state`, Status: `C:\ProgramData\Vectory\update-state\status.json`,
			Probe: `C:\ProgramData\Vectory\update-state\probe`, Private: `C:\ProgramData\Vectory\update-state\private`,
			Journal: `C:\ProgramData\Vectory\update-state\private\journal.json`, Counters: `C:\ProgramData\Vectory\update-state\private\counters.json`,
			Installed: `C:\ProgramData\Vectory\update-state\private\installed.json`, Staging: `C:\ProgramData\Vectory\update-state\private\staging`,
			Helper: `C:\ProgramData\Vectory\update-state\private\helper`, HelperExecutable: `C:\ProgramData\Vectory\update-state\private\helper\vectory.exe`,
		}},
	} {
		if got := updateLocationsFor(tc.goos, tc.programData); got != tc.want {
			t.Errorf("%s:\n got %+v\nwant %+v", tc.name, got, tc.want)
		}
	}
	// Any other Unix has the Linux layout, as DefaultPaths does.
	if updateLocationsFor("freebsd", "") != updateLocationsFor("linux", "") {
		t.Error("another Unix doesn't have the Linux layout")
	}
}

// The contract fixes where each file is, and where it differs from this code the
// contract is right: it names the policy and the step's directory for each
// operating system.
func TestUpdateLocationsAreWhereTheContractPutsThem(t *testing.T) {
	contract := string(repoFile(t, "contracts/CONTRACT.md"))
	for _, tc := range []struct {
		goos      string
		separator string
	}{{"linux", "/"}, {"darwin", "/"}, {"windows", `\`}} {
		paths := updateLocationsFor(tc.goos, `C:\ProgramData`)
		for what, path := range map[string]string{"the policy": paths.Policy, "the step's directory": paths.StepDir + tc.separator} {
			// The contract writes ProgramData as %ProgramData%.
			written := strings.Replace(path, `C:\ProgramData`, `%ProgramData%`, 1)
			if !strings.Contains(contract, "`"+written+"`") {
				t.Errorf("%s: the contract doesn't name %s as %s", tc.goos, what, written)
			}
		}
	}
	for _, name := range []string{updateStatusFile, updateJournalFile, updateCountersFile, updateInstalledFile} {
		if !strings.Contains(contract, "`"+name+"`") {
			t.Errorf("the contract doesn't name %s", name)
		}
	}
	for _, name := range []string{updateProbeDir, updatePrivateDir, updateStagingDir, updateHelperDir} {
		if !strings.Contains(contract, "`"+name+"/`") {
			t.Errorf("the contract doesn't name the directory %s/", name)
		}
	}
	if !strings.Contains(contract, updatePolicyFile) {
		t.Errorf("the contract doesn't name %s", updatePolicyFile)
	}
}

func TestEveryUpdatePathIsInsideItsDirectory(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		p := updateLocationsFor(goos, "")
		separator := "/"
		if goos == "windows" {
			separator = `\`
		}
		inside := func(path, dir string) bool {
			return strings.HasPrefix(path, dir+separator) && !strings.Contains(path[len(dir)+1:], separator)
		}
		for name, pair := range map[string][2]string{
			"policy": {p.Policy, p.PolicyDir}, "status": {p.Status, p.StepDir}, "probe": {p.Probe, p.StepDir}, "private": {p.Private, p.StepDir},
			"journal": {p.Journal, p.Private}, "counters": {p.Counters, p.Private}, "installed": {p.Installed, p.Private},
			"staging": {p.Staging, p.Private}, "helper": {p.Helper, p.Private}, "helper executable": {p.HelperExecutable, p.Helper},
		} {
			if !inside(pair[0], pair[1]) {
				t.Errorf("%s: the %s path %q isn't directly in %q", goos, name, pair[0], pair[1])
			}
		}
		if strings.HasPrefix(p.PolicyDir, p.StepDir) || strings.HasPrefix(p.StepDir, p.PolicyDir) {
			t.Errorf("%s: the policy directory and the step's directory are nested", goos)
		}
	}
}

func TestUpdateLocationsCanBeMovedByATest(t *testing.T) {
	if got := UpdateLocations(); got.Policy == "" {
		t.Fatal("no policy path")
	}
	moved := newUpdatePaths("/tmp/x/policy", "/tmp/x/step", false)
	old := updateLocationsOverride
	updateLocationsOverride = &moved
	defer func() { updateLocationsOverride = old }()
	if UpdateLocations() != moved {
		t.Error("the override wasn't returned")
	}
}
