package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// The data directory probe answers without creating or leaving anything: not
// the directory it asks about, not a missing parent, not a probe file.
func TestReadinessProbesTheDataDirectoryWithoutLeavingAnything(t *testing.T) {
	root := privateTempDir(t)
	writable := filepath.Join(root, "writable")
	if err := os.Mkdir(writable, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "a-file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Log("no symbolic links here:", err)
		link = ""
	}
	cases := []struct {
		name         string
		path, source string
		want         bool
	}{
		{"a directory that exists, chosen by the host", writable, dataDirHost, true},
		{"one chosen by the agent's default", writable, dataDirAgentDefault, true},
		{"one a pipeline sets", writable, dataDirPipeline, true},
		{"Vector's default, when it exists", writable, dataDirVectorDefault, true},
		{"a missing directory the agent would create", filepath.Join(writable, "a", "b", "c"), dataDirHost, true},
		{"a missing directory under the agent's own state", filepath.Join(writable, "vector-data"), dataDirAgentDefault, true},
		{"a missing directory taken from the adopted configuration", filepath.Join(writable, "adopted"), dataDirAdopted, true},
		{"a missing directory a pipeline sets", filepath.Join(writable, "missing"), dataDirPipeline, false},
		{"a missing Vector default", filepath.Join(writable, "missing"), dataDirVectorDefault, false},
		{"a file", file, dataDirHost, false},
		{"a path below a file", filepath.Join(file, "data"), dataDirHost, false},
		{"a relative path", "data", dataDirHost, false},
		{"no path", "", dataDirHost, false},
	}
	if link != "" {
		cases = append(cases,
			struct {
				name         string
				path, source string
				want         bool
			}{"a link, in a directory the agent prepares", link, dataDirHost, false},
			struct {
				name         string
				path, source string
				want         bool
			}{"a link a pipeline sets", link, dataDirPipeline, true})
	}
	before := tree(t, root)
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := dataDirUsable(c.path, c.source); got != c.want {
				t.Fatalf("usable = %v, want %v", got, c.want)
			}
		})
	}
	if after := tree(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("the probes changed what is on disk:\n%v\n%v", before, after)
	}
}

// A directory the account may not write to is not writable (permission bits
// don't restrict root, so this one is for ordinary accounts).
func TestReadinessSeesAReadOnlyDirectory(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("permission bits don't apply to this account")
	}
	dir := filepath.Join(privateTempDir(t), "readonly")
	if err := os.Mkdir(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	if dataDirUsable(dir, dataDirHost) || dataDirUsable(filepath.Join(dir, "new"), dataDirHost) {
		t.Fatal("a read-only directory is writable")
	}
}

func tree(t *testing.T, root string) []string {
	t.Helper()
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return paths
}

// What the heartbeat reports is a boolean and a count: the number of approved
// listen addresses, never the addresses; and the directory is the one the next
// apply would use for the configuration that runs, so a pipeline's own
// data_dir counts, and a missing one fails.
func TestReadinessReportsTheEffectiveDataDirectoryAndOnlyACount(t *testing.T) {
	d := newCheckDevice(t)
	d.e.Settings.CapabilityPolicy.AllowedListenAddresses = []string{"0.0.0.0:514", "127.0.0.1:9598", "10.1.2.3:8080"}
	got := d.e.readiness(nil)
	if !got.DataDirWritable || got.AllowedListenerCount != 3 {
		t.Fatalf("readiness %+v", got)
	}
	encoded, _ := json.Marshal(got)
	if string(encoded) != `{"data_dir_writable":true,"allowed_listener_count":3}` {
		t.Fatalf("readiness is %s", encoded)
	}
	for _, address := range d.e.Settings.CapabilityPolicy.AllowedListenAddresses {
		if strings.Contains(string(encoded), address) {
			t.Fatalf("readiness names %s", address)
		}
	}
	present := mustJSONFor(map[string]any{"data_dir": d.root})
	missing := mustJSONFor(map[string]any{"data_dir": filepath.Join(d.root, "no", "such", "directory")})
	if !d.e.readiness(present).DataDirWritable || d.e.readiness(missing).DataDirWritable {
		t.Fatal("a pipeline's own data_dir isn't what readiness probes")
	}
	// The host's own choice wins when the pipeline sets none.
	d.e.Settings.VectorDataDir = filepath.Join(d.root, "host", "data")
	if !d.e.readiness(nil).DataDirWritable {
		t.Fatal("a host data directory the agent would create isn't usable")
	}
	if _, err := os.Stat(filepath.Join(d.root, "host")); !os.IsNotExist(err) {
		t.Fatal("readiness created the host's data directory")
	}
}
