package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestHostDataDirPrecedence(t *testing.T) {
	previous := vectorDefaultDataDirProbe
	defer func() { vectorDefaultDataDirProbe = previous }()
	vectorDefaultDataDirProbe = filepath.Join(t.TempDir(), "absent")
	dir := t.TempDir()
	if path, source := hostDataDir(Settings{}, dir); path != agentDataDir(dir) || source != dataDirAgentDefault {
		t.Fatalf("default = %s (%s)", path, source)
	}
	if runtime.GOOS != "windows" {
		vectorDefaultDataDirProbe = t.TempDir()
		if path, source := hostDataDir(Settings{}, dir); path != vectorDefaultDataDir || source != dataDirVectorDefault {
			t.Fatalf("existing writable Vector default = %s (%s)", path, source)
		}
	}
	adopted := filepath.Join(t.TempDir(), "adopted-data")
	backup, _ := json.Marshal(map[string]any{"data_dir": adopted, "sources": map[string]any{}})
	if err := AtomicWrite(filepath.Join(dir, "adoption-backup.json"), backup); err != nil {
		t.Fatal(err)
	}
	if path, source := hostDataDir(Settings{}, dir); path != adopted || source != dataDirAdopted {
		t.Fatalf("adopted = %s (%s)", path, source)
	}
	explicit := filepath.Join(t.TempDir(), "explicit")
	if path, source := hostDataDir(Settings{VectorDataDir: explicit}, dir); path != explicit || source != dataDirHost {
		t.Fatalf("explicit = %s (%s)", path, source)
	}
}

// Checkpoints and disk buffers live in the data directory: once an
// activation used a derived directory, it must not move when Vector's own
// default appears or becomes writable later.
func TestDerivedDataDirStaysAfterFirstActivation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Vector's default data directory is not probed on Windows")
	}
	previous := vectorDefaultDataDirProbe
	defer func() { vectorDefaultDataDirProbe = previous }()
	vectorDefaultDataDirProbe = filepath.Join(t.TempDir(), "absent")
	dir := t.TempDir()
	h := hostRuntimeFor(Settings{}, dir, []byte(`{"sources":{}}`))
	if h.DataDirSource != dataDirAgentDefault {
		t.Fatalf("first choice = %+v", h)
	}
	if err := rememberHostDataDir(dir, h); err != nil {
		t.Fatal(err)
	}
	vectorDefaultDataDirProbe = t.TempDir()
	if path, source := hostDataDir(Settings{}, dir); path != agentDataDir(dir) || source != dataDirAgentDefault {
		t.Fatalf("data_dir moved to %s (%s)", path, source)
	}
	explicit := filepath.Join(t.TempDir(), "explicit")
	if path, source := hostDataDir(Settings{VectorDataDir: explicit}, dir); path != explicit || source != dataDirHost {
		t.Fatalf("an explicit --vector-data-dir must still win: %s (%s)", path, source)
	}
	if err := rememberHostDataDir(dir, HostRuntime{DataDir: "/elsewhere", DataDirSource: dataDirVectorDefault}); err != nil {
		t.Fatal(err)
	}
	if path, _ := hostDataDir(Settings{}, dir); path != agentDataDir(dir) {
		t.Fatalf("the first choice was overwritten: %s", path)
	}
}

func TestRuntimeOverlayOnlyFillsAnOmittedDataDir(t *testing.T) {
	previous := vectorDefaultDataDirProbe
	defer func() { vectorDefaultDataDirProbe = previous }()
	vectorDefaultDataDirProbe = filepath.Join(t.TempDir(), "absent")
	dir := t.TempDir()
	settings := Settings{GracefulShutdownSeconds: 1000}
	overlay, host, err := runtimeOverlay(settings, dir, []byte(`{"sources":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]string
	if json.Unmarshal(overlay, &fields) != nil || fields["data_dir"] != agentDataDir(dir) || host.DataDirSource != dataDirAgentDefault || host.GracefulShutdownSeconds != maxGracefulShutdownSeconds {
		t.Fatalf("overlay %s host %+v", overlay, host)
	}
	info, err := os.Stat(agentDataDir(dir))
	if err != nil || !info.IsDir() || runtime.GOOS != "windows" && info.Mode().Perm() != 0700 {
		t.Fatalf("agent data directory not created privately: %v %v", info, err)
	}
	overlay, host, err = runtimeOverlay(settings, dir, []byte(`{"data_dir":"/srv/pipeline","sources":{}}`))
	if err != nil || string(overlay) != "{}" || host.DataDir != "/srv/pipeline" || host.DataDirSource != dataDirPipeline {
		t.Fatalf("a pipeline data_dir must never be overridden: %s %+v %v", overlay, host, err)
	}
	blocked := filepath.Join(t.TempDir(), "file")
	if err = os.WriteFile(blocked, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = runtimeOverlay(Settings{VectorDataDir: blocked}, dir, []byte(`{}`)); err == nil {
		t.Fatal("a file accepted as the data directory")
	}
	for _, n := range []int{0, 1, 60, 301} {
		if got := (Settings{GracefulShutdownSeconds: n}).gracefulShutdownSeconds(); got < minGracefulShutdownSeconds || got > maxGracefulShutdownSeconds {
			t.Fatalf("graceful %d -> %d out of bounds", n, got)
		}
	}
}

func TestValidateVectorDataDir(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0600)
	for _, bad := range []string{"", "relative/dir", file, "/tmp/with\x00nul"} {
		if validateVectorDataDir(bad) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if err := validateVectorDataDir(filepath.Join(t.TempDir(), "new")); err != nil {
		t.Fatal(err)
	}
}
