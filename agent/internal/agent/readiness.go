package agent

import (
	"os"
	"path/filepath"
)

// Readiness is what the heartbeat tells a server that lists "validation" about
// this host, beyond what it already reports: a boolean and a count, nothing
// else. The configuration mode and the Vector version already ride the
// heartbeat.
type Readiness struct {
	// DataDirWritable says that an apply could use the data directory it would
	// choose for the running configuration: the directory exists and takes new
	// files, or it is one the agent creates itself and its nearest existing
	// parent takes new entries. It is probed without creating or leaving
	// anything behind.
	DataDirWritable bool `json:"data_dir_writable"`
	// AllowedListenerCount is how many listen addresses this host's allowances
	// approve. The addresses stay on the device.
	AllowedListenerCount int `json:"allowed_listener_count"`
}

// readiness describes this host for a configuration like the one that runs
// (effective is its text, or nil when nothing runs yet).
func (e *Engine) readiness(effective []byte) *Readiness {
	h := e.hostRuntime(effective)
	return &Readiness{
		DataDirWritable:      dataDirUsable(h.DataDir, h.DataDirSource),
		AllowedListenerCount: len(e.Settings.CapabilityPolicy.AllowedListenAddresses),
	}
}

// dataDirUsable reports whether Vector could use the data directory at path,
// chosen by source (see hostDataDir), without creating anything to find out.
func dataDirUsable(path, source string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	// A pipeline's own data_dir is Vector's business, and a link in it can be
	// fine; the agent refuses links only in the directories it prepares itself.
	if source != dataDirPipeline && SafePath(path) != nil {
		return false
	}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		return info.IsDir() && directoryAcceptsFiles(path)
	case !os.IsNotExist(err):
		return false
	case source == dataDirPipeline || source == dataDirVectorDefault:
		// Neither Vector nor the agent creates these: a missing one is not usable.
		return false
	}
	// The agent creates the directory it chose, so the nearest parent that
	// exists has to take a new entry.
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		info, err := os.Stat(parent)
		if err == nil {
			return info.IsDir() && directoryAcceptsFiles(parent)
		}
		if !os.IsNotExist(err) || filepath.Dir(parent) == parent {
			return false
		}
	}
}
