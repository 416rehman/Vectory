package agent

import (
	"os"
	"runtime"
	"strings"
)

// UpdatePaths are the places the update feature keeps what only root may change
// (the contract's table of the privileged step and its files). Everything here
// is outside the agent's state directory, which belongs to the service account;
// the agent's own files for an update are in <state>/updates (UpdateExchangeFor).
type UpdatePaths struct {
	// PolicyDir holds the host's consent and its pinned keys, written by root;
	// Policy is the file in it.
	PolicyDir string
	Policy    string
	// StepDir is the privileged step's own directory. Status is what the agent
	// reads in it (world readable); Probe is the one place the service account
	// runs a verified build from; Private holds everything else and is closed to
	// everyone but root.
	StepDir string
	Status  string
	Probe   string
	Private string
	// The files and directories of Private.
	Journal   string
	Counters  string
	Installed string
	Staging   string
	Helper    string
	// HelperExecutable is the copy of the last build that was proven on this
	// host, which the step runs from.
	HelperExecutable string
}

// Names inside the directories above, and the policy's own.
const (
	updatePolicyFile    = "policy.json"
	updateStatusFile    = "status.json"
	updateProbeDir      = "probe"
	updatePrivateDir    = "private"
	updateJournalFile   = "journal.json"
	updateCountersFile  = "counters.json"
	updateInstalledFile = "installed.json"
	updateStagingDir    = "staging"
	updateHelperDir     = "helper"
)

// updateLocationsOverride moves every update path, for a test that builds the
// tree it needs under a temporary directory. It is a seam like rootOwnedTrust:
// tests assign it, and nothing else does.
var updateLocationsOverride *UpdatePaths

// UpdateLocations returns the update paths of the running operating system.
func UpdateLocations() UpdatePaths {
	if updateLocationsOverride != nil {
		return *updateLocationsOverride
	}
	return updateLocationsFor(runtime.GOOS, os.Getenv("ProgramData"))
}

// updateLocationsFor is UpdateLocations for any operating system, so that the
// table of every one can be tested anywhere. Windows paths are written with the
// separator Windows uses whatever the host that builds them.
func updateLocationsFor(goos, programData string) UpdatePaths {
	switch goos {
	case "windows":
		if programData == "" {
			programData = `C:\ProgramData`
		}
		base := strings.TrimRight(programData, `\/`) + `\Vectory`
		return newUpdatePaths(base+`\updates`, base+`\update-state`, true)
	case "darwin":
		return newUpdatePaths("/Library/Application Support/Vectory/updates", "/Library/Application Support/Vectory/update-state", false)
	default:
		return newUpdatePaths("/etc/vectory/updates", "/var/lib/vectory-update", false)
	}
}

// newUpdatePaths derives every path from the policy directory and the step's
// directory.
func newUpdatePaths(policyDir, stepDir string, windows bool) UpdatePaths {
	separator, executable := "/", "vectory"
	if windows {
		separator, executable = `\`, "vectory.exe"
	}
	join := func(dir, name string) string { return dir + separator + name }
	paths := UpdatePaths{
		PolicyDir: policyDir,
		Policy:    join(policyDir, updatePolicyFile),
		StepDir:   stepDir,
		Status:    join(stepDir, updateStatusFile),
		Probe:     join(stepDir, updateProbeDir),
		Private:   join(stepDir, updatePrivateDir),
	}
	paths.Journal = join(paths.Private, updateJournalFile)
	paths.Counters = join(paths.Private, updateCountersFile)
	paths.Installed = join(paths.Private, updateInstalledFile)
	paths.Staging = join(paths.Private, updateStagingDir)
	paths.Helper = join(paths.Private, updateHelperDir)
	paths.HelperExecutable = join(paths.Helper, executable)
	return paths
}
