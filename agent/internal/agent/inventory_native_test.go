package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// nativeVectorBinary is the pinned Vector these tests run, or a skip when the
// environment doesn't name one.
func nativeVectorBinary(t *testing.T) string {
	t.Helper()
	binary := os.Getenv("VECTOR_TEST_BINARY")
	if binary == "" {
		t.Skip("set VECTOR_TEST_BINARY for the native inventory tests")
	}
	return binary
}

// namedVector is a path to the binary whose file name is what detection looks
// for: the processes of a Vector called anything else aren't found by name.
func namedVector(t *testing.T, binary string) string {
	t.Helper()
	want := "vector"
	if runtime.GOOS == "windows" {
		want += ".exe"
	}
	if filepath.Base(binary) == want {
		return binary
	}
	link := filepath.Join(t.TempDir(), want)
	if err := os.Symlink(binary, link); err != nil {
		t.Skipf("the pinned Vector isn't named %s and can't be linked to under that name: %v", want, err)
	}
	return link
}

// vectorEnvironment is the machine's environment without its Vector
// configuration variables, plus the given ones.
func nativeEnvironment(extra ...string) []string {
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "VECTOR_CONFIG") {
			env = append(env, entry)
		}
	}
	return append(env, extra...)
}

var loadingConfigs = regexp.MustCompile(`Loading configs\. paths=(\[.*\])`)

// vectorLoads starts the pinned Vector with these arguments and environment
// and returns the paths its own log says it loads ("Loading configs.
// paths=[...]"), then stops it. It is the ground truth for which files the
// options and variables name.
func vectorLoads(t *testing.T, binary, work string, environment []string, args ...string) []string {
	t.Helper()
	cmd := exec.Command(binary, append([]string{"--color", "never"}, args...)...)
	cmd.Dir = work
	cmd.Env = nativeEnvironment(environment...)
	reader, writer := io.Pipe()
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := time.AfterFunc(20*time.Second, func() { _ = cmd.Process.Kill() })
	defer stop.Stop()
	go func() { _ = cmd.Wait(); _ = writer.Close() }()
	defer func() { _ = cmd.Process.Kill() }()
	scanner := bufio.NewScanner(reader)
	var log strings.Builder
	for scanner.Scan() {
		log.WriteString(scanner.Text() + "\n")
		if match := loadingConfigs.FindStringSubmatch(scanner.Text()); match != nil {
			var paths []string
			if err := json.Unmarshal([]byte(match[1]), &paths); err != nil {
				t.Fatalf("Vector's list of configuration paths isn't JSON-shaped: %s", match[1])
			}
			return paths
		}
	}
	t.Fatalf("Vector never said which configuration it loads:\n%s", log.String())
	return nil
}

// absolutePaths makes paths absolute against work, cleaned and sorted.
func absolutePaths(paths []string, work string) []string {
	out := make([]string, len(paths))
	for i, path := range paths {
		if !filepath.IsAbs(path) {
			path = filepath.Join(work, path)
		}
		out[i] = filepath.Clean(path)
	}
	sort.Strings(out)
	return out
}

// The inventory reads the options and environment variables that name
// configuration the way Vector does. This checks it against Vector itself:
// for each way of naming files, the paths the real process says it loads are
// the paths the inventory resolves.
func TestNativeInventoryFollowsHowVectorLoadsConfiguration(t *testing.T) {
	binary := nativeVectorBinary(t)
	work := t.TempDir()
	data := t.TempDir()
	pipeline := func(sink string) string {
		return `{"data_dir":` + jsonString(data) + `,"sources":{"in":{"type":"demo_logs","format":"json","interval":1}},"sinks":{"` + sink + `":{"type":"blackhole","inputs":["in"]}}}`
	}
	writeConfigFiles(t, work, map[string]string{
		"ok.yaml":            pipeline("out"),
		"more.yaml":          `{"sinks":{"more":{"type":"blackhole","inputs":["in"]}}}`,
		"third.yml":          `{"sinks":{"third":{"type":"blackhole","inputs":["in"]}}}`,
		"other.json":         `{"sinks":{"other":{"type":"blackhole","inputs":["in"]}}}`,
		"extra.toml":         "[sinks.extra]\ntype = \"blackhole\"\ninputs = [\"in\"]\n",
		"conf/10-part.yaml":  `{"sinks":{"part":{"type":"blackhole","inputs":["in"]}}}`,
		"conf2/10-part.yaml": `{"sinks":{"part2":{"type":"blackhole","inputs":["in"]}}}`,
	})
	at := func(name string) string { return filepath.Join(work, name) }
	cases := []struct {
		name string
		args []string
		env  []string
	}{
		{"one file", []string{"-c", at("ok.yaml")}, nil},
		{"--config twice", []string{"--config", at("ok.yaml"), "--config", at("more.yaml")}, nil},
		{"commas", []string{"-c", at("ok.yaml") + "," + at("more.yaml")}, nil},
		{"--config=", []string{"--config=" + at("ok.yaml")}, nil},
		{"-c attached to its value", []string{"-c" + at("ok.yaml")}, nil},
		{"-c= ", []string{"-c=" + at("ok.yaml")}, nil},
		{"a cluster of short options", []string{"-wc", at("ok.yaml")}, nil},
		{"a glob", []string{"-c", at("*.y*ml")}, nil},
		{"the format options", []string{"--config-yaml", at("ok.yaml"), "--config-json", at("other.json"), "--config-toml", at("extra.toml")}, nil},
		{"a configuration directory", []string{"-c", at("ok.yaml"), "-C", at("conf")}, nil},
		{"two configuration directories", []string{"-c", at("ok.yaml"), "--config-dir", at("conf") + "," + at("conf2")}, nil},
		{"the environment names a file", nil, []string{"VECTOR_CONFIG=" + at("ok.yaml")}},
		{"the environment names a directory beside a file", []string{"-c", at("ok.yaml")}, []string{"VECTOR_CONFIG_DIR=" + at("conf")}},
		{"an argument beats the environment for the same option", []string{"-c", at("ok.yaml")}, []string{"VECTOR_CONFIG=" + at("more.yaml")}},
		{"the environment supplies an option the arguments leave out", []string{"-C", at("conf")}, []string{"VECTOR_CONFIG=" + at("ok.yaml")}},
		{"an environment variable with commas", nil, []string{"VECTOR_CONFIG=" + at("ok.yaml") + "," + at("third.yml")}},
		{"a relative path", []string{"-c", "ok.yaml", "-c", filepath.Join("conf", "10-part.yaml")}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			environment := map[string]string{}
			for _, entry := range c.env {
				name, value, _ := strings.Cut(entry, "=")
				environment[name] = value
			}
			process := VectorStartup{PID: 1, Command: append([]string{"vector"}, c.args...), WorkDir: work, Environment: environment, EnvironmentKnown: true}
			var model []string
			for _, source := range vectorConfigSources(c.args, environment) {
				found, problem := resolveSource(source, process)
				if problem != nil {
					t.Fatalf("the inventory can't resolve %s: %s", source.pattern, problem.text)
				}
				for _, place := range found {
					model = append(model, place.host)
				}
			}
			sort.Strings(model)
			if actual := absolutePaths(vectorLoads(t, binary, work, c.env, c.args...), work); !reflect.DeepEqual(model, actual) {
				t.Fatalf("Vector loads %q, the inventory resolves %q", actual, model)
			}
		})
	}
}

func jsonString(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

// vectorStarts runs the pinned Vector with these arguments and says whether it
// gets as far as "Vector has started" or stops on a configuration error, with
// its log.
func vectorStarts(t *testing.T, binary, work string, args ...string) (bool, string) {
	t.Helper()
	cmd := exec.Command(binary, append([]string{"--color", "never"}, args...)...)
	cmd.Dir = work
	cmd.Env = nativeEnvironment()
	reader, writer := io.Pipe()
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := time.AfterFunc(20*time.Second, func() { _ = cmd.Process.Kill() })
	defer stop.Stop()
	go func() { _ = cmd.Wait(); _ = writer.Close() }()
	defer func() { _ = cmd.Process.Kill() }()
	scanner := bufio.NewScanner(reader)
	var log strings.Builder
	for scanner.Scan() {
		log.WriteString(scanner.Text() + "\n")
		if strings.Contains(scanner.Text(), "Vector has started") {
			return true, log.String()
		}
	}
	return false, log.String()
}

// A file named directly, whose extension Vector doesn't know, is read as TOML:
// the inventory scans it as TOML, not by guessing from its content.
func TestNativeAFileWithAnUnknownExtensionIsReadAsTOML(t *testing.T) {
	binary := nativeVectorBinary(t)
	dir, data := t.TempDir(), t.TempDir()
	toml := "data_dir = " + jsonString(data) + "\n[sources.in]\ntype = \"demo_logs\"\nformat = \"json\"\n[sinks.out]\ntype = \"blackhole\"\ninputs = [\"in\"]\n"
	yaml := "data_dir: '" + strings.ReplaceAll(data, "'", "''") + "'\nsources:\n  in:\n    type: demo_logs\n    format: json\nsinks:\n  out:\n    type: blackhole\n    inputs: [in]\n"
	writeConfigFiles(t, dir, map[string]string{"vector.conf": toml, "noextension": yaml})
	if started, log := vectorStarts(t, binary, dir, "-c", filepath.Join(dir, "vector.conf")); !started {
		t.Fatalf("TOML in a file Vector doesn't know the extension of didn't start:\n%s", log)
	}
	if started, log := vectorStarts(t, binary, dir, "-c", filepath.Join(dir, "noextension")); started || !strings.Contains(log, "TOML parse error") {
		t.Fatalf("YAML in a file with no extension was read as YAML:\n%s", log)
	}
	if started, log := vectorStarts(t, binary, dir, "--config-yaml", filepath.Join(dir, "noextension")); !started {
		t.Fatalf("--config-yaml didn't make Vector read the file as YAML:\n%s", log)
	}
	for _, c := range []struct{ option, name, format string }{{"-c", "vector.conf", "toml"}, {"-c", "noextension", "toml"}, {"--config-yaml", "noextension", "yaml"}} {
		inventory := InventoryVector([]VectorStartup{{PID: 1, Command: []string{"vector", c.option, filepath.Join(dir, c.name)}, EnvironmentKnown: true}})
		if len(inventory.Files) != 1 || inventory.Files[0].Format != c.format {
			t.Errorf("%s %s: the inventory reads it as %+v, Vector as %s", c.option, c.name, inventory.Files, c.format)
		}
	}
}

// Which files of a configuration directory Vector reads is decided by names:
// extensions (case-sensitive), hidden files, and the sub-directories it looks
// into. Each name is put in a directory as a file that Vector can't parse; if
// the real Vector fails to load the directory, it read that file, and the
// inventory must have listed it.
func TestNativeInventoryListsTheFilesOfAConfigDirectoryVectorReads(t *testing.T) {
	binary := nativeVectorBinary(t)
	data := t.TempDir()
	base := `{"data_dir":` + jsonString(data) + `,"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}`
	names := []string{
		"probe.yaml", "probe.yml", "probe.json", "probe.toml",
		".hidden.yaml", "PROBE.YAML", "probe.Yaml", "probe.txt", "probe", "probe.yaml.bak", "probe.yaml~",
		"sources/probe.yaml", "transforms/probe.yaml", "sinks/probe.yaml", "enrichment_tables/probe.yaml", "tests/probe.yaml",
		"other/probe.yaml", "sinks/deep/probe.yaml", "Sources/probe.yaml",
	}
	sort.Strings(names)
	for _, name := range names {
		dir := t.TempDir()
		writeConfigFiles(t, dir, map[string]string{"10-base.json": base, filepath.FromSlash(name): "{{{ this is not configuration"})
		process := VectorStartup{PID: 1, Command: []string{"vector", "-C", dir}, EnvironmentKnown: true}
		listed := false
		for _, file := range InventoryVector([]VectorStartup{process}).Files {
			if filepath.Base(file.Path) != "10-base.json" {
				rel, _ := filepath.Rel(dir, file.Path)
				listed = listed || filepath.ToSlash(rel) == name
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		cmd := exec.CommandContext(ctx, binary, "validate", "--no-environment", "-C", dir)
		cmd.Env = nativeEnvironment()
		out, err := cmd.CombinedOutput()
		timedOut := ctx.Err() != nil
		cancel()
		if timedOut {
			t.Fatalf("%s: vector validate didn't finish", name)
		}
		if _, isExit := err.(*exec.ExitError); err != nil && !isExit {
			t.Fatal(err)
		}
		read := err != nil
		if read != listed {
			t.Errorf("%s: Vector reads it: %v; the inventory lists it: %v\n%s", name, read, listed, out)
		}
	}
}

// A real Vector, started the way a host starts it with a directory of two
// files, is found among the processes, read, inventoried and copied by setup,
// which stops for it and names both files. Once that Vector is stopped, setup
// goes ahead only with --adopt-existing, and the agent installs beside the
// copies.
func TestNativeSetupInventoriesARunningVectorAndAdoptsItsConfigDirectory(t *testing.T) {
	binary := nativeVectorBinary(t)
	conf, work, data := t.TempDir(), t.TempDir(), t.TempDir()
	sources := "data_dir: '" + strings.ReplaceAll(data, "'", "''") + "'\nsources:\n  in:\n    type: demo_logs\n    format: json\n    interval: 1\n"
	sinks := `{"sinks":{"out":{"type":"blackhole","inputs":["in"],"print_interval_secs":0}}}`
	writeConfigFiles(t, conf, map[string]string{"10-sources.yaml": sources, "20-sinks.json": sinks})

	cmd := exec.Command(namedVector(t, binary), "--config-dir", conf, "--color", "never")
	cmd.Dir = work
	cmd.Env = nativeEnvironment()
	logs, err := os.Create(filepath.Join(work, "vector.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer logs.Close()
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	stop := func() {
		if !stopped {
			stopped = true
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}
	t.Cleanup(stop)
	deadline := time.Now().Add(20 * time.Second)
	for {
		if text, _ := os.ReadFile(logs.Name()); strings.Contains(string(text), "Vector has started") {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("Vector never started:\n%s", text)
		}
		time.Sleep(50 * time.Millisecond)
	}

	server := newSetupServer(t)
	options, dir, managed := setupFixture(t)
	options.KeepExistingVector = false
	options.Server, options.CASHA256, options.VectorBinary = server.url, server.pin, binary
	tokens := 0
	options.Token = func() (string, error) { tokens++; return "synthetic-setup-token", nil }
	host := nativeServiceHost
	host.settle = 300 * time.Millisecond

	result, err := setupWith(context.Background(), options, nativeService, host)
	if err == nil || result.OK || stepStatus(result, "existing") != "fail" || tokens != 0 {
		t.Fatalf("setup went ahead beside a running Vector: %+v %v", result.Steps, err)
	}
	var ours *VectorStartup
	if result.Adoption != nil {
		for i, process := range result.Adoption.Processes {
			if process.PID == cmd.Process.Pid {
				ours = &result.Adoption.Processes[i]
			}
		}
	}
	if ours == nil {
		t.Fatalf("the running Vector (pid %d) isn't in the inventory: %+v", cmd.Process.Pid, result.Adoption)
	}
	if len(ours.Command) != 5 || ours.Command[1] != "--config-dir" || !samePath(ours.Command[2], conf) || !ours.EnvironmentKnown || ours.Source != "process" {
		t.Fatalf("how it was started: %+v", ours)
	}
	want := map[string]string{"10-sources.yaml": sources, "20-sinks.json": sinks}
	found := map[string]bool{}
	for _, file := range result.Adoption.Files {
		if !samePath(filepath.Dir(file.Path), conf) {
			continue
		}
		original := want[filepath.Base(file.Path)]
		copied, err := os.ReadFile(filepath.Join(result.Adoption.BackupDir, file.Backup))
		if file.Backup == "" || err != nil || string(copied) != original || file.SHA256 != Digest([]byte(original)) || file.NamedBy != "--config-dir" {
			t.Fatalf("%+v %v", file, err)
		}
		found[filepath.Base(file.Path)] = true
	}
	if len(found) != 2 {
		t.Fatalf("both files must be inventoried and copied: %+v", result.Adoption.Files)
	}
	for _, name := range []string{"10-sources.yaml", "20-sinks.json", "--adopt-existing"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the refusal doesn't say %q:\n%s", name, err)
		}
	}
	if _, statErr := os.Stat(filepath.Join(dir, "settings.json")); !os.IsNotExist(statErr) {
		t.Fatal("setup installed the agent beside a running Vector")
	}

	// Vector stops; what was recorded still needs an explicit adoption.
	stop()
	logs.Close()
	if result, err = setupWith(context.Background(), options, nativeService, host); err == nil || tokens != 0 || !strings.Contains(err.Error(), "--adopt-existing") {
		t.Fatalf("setup forgot the topology once Vector stopped: %+v %v", result.Steps, err)
	}
	options.AdoptExisting = true
	result, err = setupWith(context.Background(), options, nativeService, host)
	if err != nil || !result.OK || tokens != 1 || result.Adoption == nil || !result.Adoption.Acknowledged {
		t.Fatalf("%+v %v", result.Steps, err)
	}
	if settings, err := LoadSettings(dir); err != nil || settings.VectorBinary != binary && !samePath(settings.VectorBinary, binary) || settings.ManagedConfig != managed {
		t.Fatalf("the agent isn't installed with the pinned Vector: %+v %v", settings, err)
	}
	for _, file := range result.Adoption.Files {
		if copied, err := os.ReadFile(filepath.Join(result.Adoption.BackupDir, file.Backup)); err != nil || Digest(copied) != file.SHA256 {
			t.Fatalf("the copy of %s changed: %v", file.Path, err)
		}
	}
	for name, body := range want {
		if got, err := os.ReadFile(filepath.Join(conf, name)); err != nil || string(got) != body {
			t.Fatalf("setup changed %s: %v", name, err)
		}
	}
}
