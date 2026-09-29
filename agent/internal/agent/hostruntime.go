package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
)

// HostRuntime is what this host contributes to Vector's runtime beyond the
// signed artifact. It is reported on every heartbeat so the dashboard can show
// exactly where Vector keeps its state and how metrics are collected.
type HostRuntime struct {
	DataDir                 string `json:"data_dir,omitempty"`
	DataDirSource           string `json:"data_dir_source,omitempty"`
	GracefulShutdownSeconds int    `json:"graceful_shutdown_seconds,omitempty"`
	MetricsSource           string `json:"metrics_source,omitempty"`
	MetricsAddress          string `json:"metrics_address,omitempty"`
	Activation              string `json:"activation,omitempty"`
}

// Data directory sources, in precedence order after the pipeline's own value.
const (
	dataDirPipeline      = "pipeline"       // the published configuration sets data_dir
	dataDirHost          = "host"           // install --vector-data-dir
	dataDirAdopted       = "adopted"        // data_dir of the configuration adopted at install
	dataDirVectorDefault = "vector_default" // Vector's own default exists and is writable here
	dataDirAgentDefault  = "agent_default"  // <state-dir>/vector-data, created by the agent
)

const (
	defaultGracefulShutdownSeconds = 60
	minGracefulShutdownSeconds     = 5
	maxGracefulShutdownSeconds     = 300
)

// vectorDefaultDataDirProbe is where Vector's default data_dir is checked;
// tests point it elsewhere.
var vectorDefaultDataDirProbe = vectorDefaultDataDir

func hostRuntimePath(dir string) string { return filepath.Join(dir, "host-runtime.json") }
func hostDataDirPath(dir string) string { return filepath.Join(dir, "vector-data-dir.json") }
func agentDataDir(dir string) string    { return filepath.Join(dir, "vector-data") }

// gracefulShutdownSeconds bounds the local drain limit passed to Vector.
func (s Settings) gracefulShutdownSeconds() int {
	switch n := s.GracefulShutdownSeconds; {
	case n == 0:
		return defaultGracefulShutdownSeconds
	case n < minGracefulShutdownSeconds:
		return minGracefulShutdownSeconds
	case n > maxGracefulShutdownSeconds:
		return maxGracefulShutdownSeconds
	default:
		return n
	}
}

// validateVectorDataDir accepts an absolute local path without links or NUL.
func validateVectorDataDir(path string) error {
	if path == "" || !utf8.ValidString(path) || strings.ContainsRune(path, 0) || adoptionLocalPath(path) != nil {
		return errors.New("--vector-data-dir must be an absolute local path")
	}
	if err := SafePath(path); err != nil {
		return errors.New("--vector-data-dir must not traverse links")
	}
	if info, err := os.Lstat(path); err == nil && !info.IsDir() {
		return errors.New("--vector-data-dir must name a directory")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ensureDataDir creates a missing host data directory for the service
// account. Existing operator-chosen directories keep their permissions.
func ensureDataDir(path string, private bool) error {
	if err := SafePath(path); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() {
			return errors.New("Vector data directory is not a directory")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if private {
		return PrivateDir(path)
	}
	return os.MkdirAll(path, 0700)
}

func topLevelString(data []byte, key string) (string, bool) {
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil {
		return "", false
	}
	raw, ok := root[key]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", true
	}
	return value, true
}

// hostDataDirChoice is the derived data directory, remembered at the first
// activation that uses it.
type hostDataDirChoice struct {
	DataDir string `json:"data_dir"`
	Source  string `json:"source"`
}

// hostDataDir is the directory this device offers to a pipeline that does not
// set data_dir. An explicit host setting wins. Otherwise the directory chosen
// at the first activation stays: checkpoints and disk buffers live there, so
// it must not move because /var/lib/vector appears or becomes writable later.
// The first choice is the adopted configuration's data_dir, then Vector's own
// default when it already exists and is writable, then a private directory in
// the agent state directory.
func hostDataDir(s Settings, dir string) (string, string) {
	if s.VectorDataDir != "" {
		return s.VectorDataDir, dataDirHost
	}
	if data, err := readArtifact(hostDataDirPath(dir)); err == nil {
		var choice hostDataDirChoice
		if json.Unmarshal(data, &choice) == nil && filepath.IsAbs(choice.DataDir) &&
			(choice.Source == dataDirAdopted || choice.Source == dataDirVectorDefault || choice.Source == dataDirAgentDefault) {
			return choice.DataDir, choice.Source
		}
	}
	if backup, err := readArtifact(filepath.Join(dir, "adoption-backup.json")); err == nil {
		if value, ok := topLevelString(backup, "data_dir"); ok && filepath.IsAbs(value) {
			return value, dataDirAdopted
		}
	}
	if runtime.GOOS != "windows" && directoryWritable(vectorDefaultDataDirProbe) {
		return vectorDefaultDataDir, dataDirVectorDefault
	}
	return agentDataDir(dir), dataDirAgentDefault
}

// hostRuntime describes the effective runtime for one configuration.
func hostRuntimeFor(s Settings, dir string, effective []byte) HostRuntime {
	h := HostRuntime{GracefulShutdownSeconds: s.gracefulShutdownSeconds()}
	if value, ok := topLevelString(effective, "data_dir"); ok {
		h.DataDir, h.DataDirSource = value, dataDirPipeline
	} else {
		h.DataDir, h.DataDirSource = hostDataDir(s, dir)
	}
	return h
}

func (e *Engine) hostRuntime(effective []byte) HostRuntime {
	return hostRuntimeFor(e.Settings, e.Dir, effective)
}

// runtimeOverlay is the second configuration file Vector loads next to the
// managed artifact. It holds only host-owned values, so the managed file
// stays byte-identical to the verified artifact and digest evidence is
// unchanged. Vector rejects conflicting global values, so data_dir is added
// only when the configuration omits it.
func runtimeOverlay(s Settings, dir string, effective []byte) ([]byte, HostRuntime, error) {
	h := hostRuntimeFor(s, dir, effective)
	overlay := map[string]string{}
	if h.DataDirSource != dataDirPipeline && h.DataDirSource != dataDirVectorDefault {
		if err := ensureDataDir(h.DataDir, h.DataDirSource == dataDirAgentDefault); err != nil {
			return nil, h, errors.New("cannot prepare the device's Vector data directory")
		}
		overlay["data_dir"] = h.DataDir
	}
	data, err := json.Marshal(overlay)
	return data, h, err
}

// rememberHostDataDir keeps a derived data directory for later activations.
func rememberHostDataDir(dir string, h HostRuntime) error {
	if dir == "" || h.DataDirSource == dataDirPipeline || h.DataDirSource == dataDirHost {
		return nil
	}
	if _, err := os.Lstat(hostDataDirPath(dir)); err == nil {
		return nil
	}
	data, err := json.Marshal(hostDataDirChoice{DataDir: h.DataDir, Source: h.DataDirSource})
	if err != nil {
		return err
	}
	return AtomicWrite(hostDataDirPath(dir), data)
}

// writeRuntimeOverlay persists the overlay the running Vector process uses.
func writeRuntimeOverlay(path string, data []byte) error {
	if current, err := readArtifact(path); err == nil && bytes.Equal(current, data) {
		return nil
	}
	return AtomicWrite(path, data)
}
