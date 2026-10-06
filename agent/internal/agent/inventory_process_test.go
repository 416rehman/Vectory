package agent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// samePath compares two paths the way the platform does: through symbolic
// links, and ignoring case where the file system does.
func samePath(a, b string) bool {
	resolve := func(path string) string {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		return filepath.Clean(path)
	}
	a, b = resolve(a), resolve(b)
	return a == b || runtime.GOOS == "windows" && strings.EqualFold(a, b)
}

// startStandInVector starts the stand-in for Vector as a running Vector with
// the given arguments and extra environment, in its own working directory. The
// environment never carries the machine's own VECTOR_CONFIG variables.
func startStandInVector(t *testing.T, work string, environment []string, args ...string) (*exec.Cmd, string) {
	t.Helper()
	binary := standInVector(t, fakeVectorConfig{})
	cmd := exec.Command(binary, args...)
	cmd.Dir = work
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "VECTOR_CONFIG") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, environment...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd, binary
}

// findRunning waits for detection to list the process: the stand-in is a
// Vector that no agent supervises, among whatever else runs on the machine.
func findRunning(t *testing.T, pid int) RunningVector {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		found, ok := DetectRunningVector(context.Background())
		if !ok {
			t.Fatal("this host couldn't list its processes")
		}
		for _, v := range found {
			if v.PID == pid {
				return v
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("a running Vector (pid %d) wasn't detected among %+v", pid, found)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A real process, read the way the host's own tools read it: /proc on Linux,
// kern.procargs2 on macOS, the process parameters on Windows. Its arguments
// (one with a space), working directory and the variable that selects a
// configuration file all come back, and the inventory follows them to the
// files.
func TestInventoryOfARunningVectorProcess(t *testing.T) {
	conf := t.TempDir()
	writeConfigFiles(t, conf, map[string]string{"sources.yaml": minimalYAML, "sinks.yaml": "sinks: {}\n"})
	extra := filepath.Join(t.TempDir(), "extra.json")
	if err := os.WriteFile(extra, []byte(`{"sources":{}}`), 0644); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	cmd, binary := startStandInVector(t, work, []string{"VECTOR_CONFIG_JSON=" + extra, "VECTOR_LOG=info", "AWS_SECRET_ACCESS_KEY=must-not-be-kept"}, "--config-dir", conf, "--watch-config", "--label", "two words")

	running := findRunning(t, cmd.Process.Pid)
	startup := collectStartup(context.Background(), running)
	want := []string{binary, "--config-dir", conf, "--watch-config", "--label", "two words"}
	if !reflect.DeepEqual(startup.Command, want) || startup.Source != "process" {
		t.Fatalf("command %q (%s), want %q", startup.Command, startup.Source, want)
	}
	if !samePath(startup.WorkDir, work) {
		t.Fatalf("working directory %q, want %q", startup.WorkDir, work)
	}
	if !startup.EnvironmentKnown || !reflect.DeepEqual(startup.Environment, map[string]string{"VECTOR_CONFIG_JSON": extra}) {
		t.Fatalf("environment %+v known %v", startup.Environment, startup.EnvironmentKnown)
	}
	if strings.Contains(strings.Join(startup.Command, " ")+startup.WorkDir+startup.Service, "must-not-be-kept") {
		t.Fatal("a variable that doesn't select configuration was recorded")
	}

	inventory := InventoryVector([]VectorStartup{startup})
	got := map[string]string{}
	for _, file := range inventory.Files {
		got[filepath.Base(file.Path)] = file.NamedBy + " " + file.SHA256
	}
	want2 := map[string]string{
		"sources.yaml": "--config-dir " + Digest([]byte(minimalYAML)),
		"sinks.yaml":   "--config-dir " + Digest([]byte("sinks: {}\n")),
		"extra.json":   "VECTOR_CONFIG_JSON " + Digest([]byte(`{"sources":{}}`)),
	}
	if !reflect.DeepEqual(got, want2) {
		t.Fatalf("files %v, want %v", got, want2)
	}
	if kinds := kinds(inventory); !reflect.DeepEqual(kinds, []string{"!several_files", "!environment_selected"}) {
		t.Fatalf("concerns %q", kinds)
	}
}

// A Vector started with no options at all loads the default path, which the
// inventory names even when nothing is there.
func TestInventoryOfARunningVectorWithTheDefaultConfiguration(t *testing.T) {
	cmd, _ := startStandInVector(t, t.TempDir(), nil, "-q")
	startup := collectStartup(context.Background(), findRunning(t, cmd.Process.Pid))
	if len(startup.Command) != 2 || startup.Command[1] != "-q" || !startup.EnvironmentKnown {
		t.Fatalf("%+v", startup)
	}
	inventory := InventoryVector([]VectorStartup{startup})
	if _, err := os.Stat(defaultVectorConfig()); err == nil {
		t.Skip("this machine has a Vector configuration at the default path")
	}
	if got := kinds(inventory); !reflect.DeepEqual(got, []string{"missing"}) || !strings.Contains(inventory.Concerns[0].Detail, defaultVectorConfig()) || !strings.Contains(inventory.Concerns[0].Detail, "the default path") {
		t.Fatalf("%q %+v", got, inventory.Concerns)
	}
}
