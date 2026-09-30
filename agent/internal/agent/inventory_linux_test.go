//go:build linux

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// procTree is a process table (what /proc is) built in a temporary folder, so
// detection and the inventory are tested without depending on what runs on the
// machine. The agent reads it through procRoot.
type procTree struct {
	t    *testing.T
	root string
}

func newProcTree(t *testing.T) *procTree {
	t.Helper()
	tree := &procTree{t: t, root: t.TempDir()}
	previous, previousShow := procRoot, systemctlShow
	procRoot = tree.root
	systemctlShow = func(context.Context, string) string { return "" }
	t.Cleanup(func() { procRoot, systemctlShow = previous, previousShow })
	tree.link("self/ns/mnt", "mnt:[4026531841]")
	return tree
}

func (p *procTree) write(path, text string) {
	p.t.Helper()
	full := filepath.Join(p.root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		p.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(text), 0644); err != nil {
		p.t.Fatal(err)
	}
}

func (p *procTree) link(path, target string) {
	p.t.Helper()
	full := filepath.Join(p.root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		p.t.Fatal(err)
	}
	if err := os.Symlink(target, full); err != nil {
		p.t.Fatal(err)
	}
}

// process adds one entry the way the kernel shows it.
func (p *procTree) process(pid int, comm string, parent int, command ...string) string {
	p.t.Helper()
	dir := strconv.Itoa(pid)
	p.write(dir+"/comm", comm+"\n")
	p.write(dir+"/stat", fmt.Sprintf("%d (%s) S %d %d %d 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 1000 1000000 100 18446744073709551615\n", pid, comm, parent, pid, pid))
	if len(command) > 0 {
		p.write(dir+"/cmdline", strings.Join(command, "\x00")+"\x00")
	}
	return filepath.Join(p.root, dir)
}

func TestDetectRunningVectorInAFakeProcessTable(t *testing.T) {
	tree := newProcTree(t)
	tree.process(1, "systemd", 0, "/sbin/init")
	tree.process(812, "vector", 1, "/usr/bin/vector", "--config-dir", "/etc/vector/conf.d")
	tree.write("812/cgroup", "0::/system.slice/vector.service\n")
	tree.link("812/exe", "/usr/bin/vector")
	// An agent's own Vector: the child of `vectory __vector-host`.
	tree.process(850, "vectory", 1, "/usr/bin/vectory", "__vector-host", "/usr/bin/vector", "/var/lib/vectory/vector.json", "restricted")
	tree.process(900, "vector", 850, "/usr/bin/vector", "--config-json", "/var/lib/vectory/vector.json")
	// A one-shot subcommand is not a workload.
	tree.process(950, "vector", 1, "/usr/bin/vector", "validate", "/tmp/candidate.json")
	tree.process(1000, "bash", 1, "bash")
	tree.write("cpuinfo", "not a process")

	found, ok := DetectRunningVector(context.Background())
	if !ok || len(found) != 1 || found[0].PID != 812 || found[0].Service != "vector.service" || found[0].Binary != "/usr/bin/vector" {
		t.Fatalf("%+v %v", found, ok)
	}
	if got := found[0].Describe(); got != "vector.service (pid 812)" {
		t.Fatal(got)
	}
	if err := os.RemoveAll(tree.root); err != nil {
		t.Fatal(err)
	}
	if found, ok := DetectRunningVector(context.Background()); ok || found != nil {
		t.Fatalf("an unreadable process table must say so: %+v %v", found, ok)
	}
}

func TestCollectStartupReadsTheProcessAndItsUnit(t *testing.T) {
	tree := newProcTree(t)
	work := t.TempDir()
	dir := tree.process(812, "vector", 1, "/usr/bin/vector", "--config-dir", "/etc/vector/conf.d")
	tree.write("812/cgroup", "0::/system.slice/vector.service\n")
	tree.link("812/cwd", work)
	tree.link("812/ns/mnt", "mnt:[4026531841]")
	tree.write("812/environ", "PATH=/usr/bin\x00VECTOR_CONFIG_JSON=/etc/vector/extra.json\x00AWS_SECRET_ACCESS_KEY=hunter2\x00")
	shown := ""
	systemctlShow = func(_ context.Context, unit string) string { shown = unit; return systemctlVectorUnit }

	startup := collectStartup(context.Background(), RunningVector{PID: 812, Service: "vector.service"})
	if shown != "vector.service" {
		t.Fatalf("systemd was asked about %q", shown)
	}
	if !reflect.DeepEqual(startup.Command, []string{"/usr/bin/vector", "--config-dir", "/etc/vector/conf.d"}) || startup.Source != "process" || startup.Service != "vector.service" {
		t.Fatalf("%+v", startup)
	}
	if !reflect.DeepEqual(startup.ServiceCommand, startup.Command) {
		t.Fatalf("the unit's ExecStart: %q", startup.ServiceCommand)
	}
	if startup.WorkDir != work || !startup.EnvironmentKnown || !reflect.DeepEqual(startup.Environment, map[string]string{"VECTOR_CONFIG_JSON": "/etc/vector/extra.json"}) || startup.Root != "" {
		t.Fatalf("%+v", startup)
	}
	if strings.Contains(fmt.Sprintf("%+v", startup), "hunter2") {
		t.Fatal("a variable that doesn't select configuration was kept")
	}

	// The process lives in another mount namespace: a container. Its paths are
	// read through its root.
	if err := os.Remove(filepath.Join(dir, "ns", "mnt")); err != nil {
		t.Fatal(err)
	}
	tree.link("812/ns/mnt", "mnt:[4026532999]")
	if startup = collectStartup(context.Background(), RunningVector{PID: 812}); startup.Root != filepath.Join(dir, "root") {
		t.Fatalf("root %q", startup.Root)
	}
}

func TestCollectStartupWhenTheProcessHidesItself(t *testing.T) {
	tree := newProcTree(t)
	// No cmdline, no environ, no cwd: another user's process without root, or a
	// hidepid mount. Only the unit's own definition is left.
	tree.process(812, "vector", 1)
	envFile := filepath.Join(t.TempDir(), "vector")
	if err := os.WriteFile(envFile, []byte("# defaults\nVECTOR_CONFIG_DIR=/etc/vector/conf.d\n"), 0644); err != nil {
		t.Fatal(err)
	}
	show := "ExecStart={ path=/usr/bin/vector ; argv[]=/usr/bin/vector -c /etc/vector/vector.yaml ; ignore_errors=no }\nEnvironment=VECTOR_LOG=info\nEnvironmentFiles=" + envFile + " (ignore_errors=no)\nWorkingDirectory=/var/lib/vector\n"
	systemctlShow = func(context.Context, string) string { return show }

	startup := collectStartup(context.Background(), RunningVector{PID: 812, Service: "vector.service"})
	if !reflect.DeepEqual(startup.Command, []string{"/usr/bin/vector", "-c", "/etc/vector/vector.yaml"}) || startup.Source != "service" || startup.WorkDir != "/var/lib/vector" {
		t.Fatalf("the unit stands in for the process: %+v", startup)
	}
	if !startup.EnvironmentKnown || startup.Environment["VECTOR_CONFIG_DIR"] != "/etc/vector/conf.d" {
		t.Fatalf("the unit's environment file is read: %+v", startup)
	}

	// A file the unit requires and this account can't read leaves the
	// environment unknown; an optional one that isn't there does not.
	show = "ExecStart={ argv[]=/usr/bin/vector ; }\nEnvironmentFiles=/nonexistent/required (ignore_errors=no)\n"
	if startup = collectStartup(context.Background(), RunningVector{PID: 812, Service: "vector.service"}); startup.EnvironmentKnown {
		t.Fatalf("a required file that can't be read may set VECTOR_CONFIG: %+v", startup)
	}
	show = "ExecStart={ argv[]=/usr/bin/vector ; }\nEnvironmentFiles=/nonexistent/optional (ignore_errors=yes)\n"
	if startup = collectStartup(context.Background(), RunningVector{PID: 812, Service: "vector.service"}); !startup.EnvironmentKnown {
		t.Fatalf("an optional file that isn't there sets nothing: %+v", startup)
	}

	// Not a service and nothing readable: nothing is known.
	if startup = collectStartup(context.Background(), RunningVector{PID: 812}); len(startup.Command) != 0 || startup.EnvironmentKnown {
		t.Fatalf("%+v", startup)
	}
}

// From a process table to the inventory: a Vector started with a directory of
// two files, in a unit that names another file in its environment.
func TestInventoryFromAFakeProcessTable(t *testing.T) {
	tree := newProcTree(t)
	conf := t.TempDir()
	writeConfigFiles(t, conf, map[string]string{"10-sources.yaml": minimalYAML, "20-sinks.yaml": "sinks: {}\n"})
	extra := filepath.Join(t.TempDir(), "extra.toml")
	if err := os.WriteFile(extra, []byte("[sources]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	tree.process(812, "vector", 1, "/usr/bin/vector", "--config-dir", conf)
	tree.write("812/cgroup", "0::/system.slice/vector.service\n")
	tree.write("812/environ", "VECTOR_CONFIG_TOML="+extra+"\x00")
	tree.link("812/exe", "/usr/bin/vector")
	tree.link("812/cwd", "/")

	running, ok := DetectRunningVector(context.Background())
	if !ok || len(running) != 1 {
		t.Fatalf("%+v %v", running, ok)
	}
	inventory := InventoryVector(collectStartups(context.Background(), running))
	var paths []string
	for _, file := range inventory.Files {
		paths = append(paths, file.Path+" "+file.NamedBy)
	}
	want := []string{
		filepath.Join(conf, "10-sources.yaml") + " --config-dir",
		filepath.Join(conf, "20-sinks.yaml") + " --config-dir",
		extra + " VECTOR_CONFIG_TOML",
	}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("%q, want %q", paths, want)
	}
	if got := kinds(inventory); !reflect.DeepEqual(got, []string{"!several_files", "!environment_selected"}) {
		t.Fatalf("%q", got)
	}
	for _, file := range inventory.Files {
		if file.SHA256 == "" || file.Problem != "" {
			t.Fatalf("%+v", file)
		}
	}
}
