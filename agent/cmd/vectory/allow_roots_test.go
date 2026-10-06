package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

// `vectory allow --file-root` refuses a root that covers a filesystem root, the
// agent's state directory, the managed configuration directory or a file bound
// to a device secret, names the root and what it overlaps, says what to allow
// instead, and leaves the host's settings as they were.
func TestAllowRefusesAFileRootThatCoversWhatTheAgentKeepsPrivate(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state, managedDir, secretDir, logs := filepath.Join(base, "state"), filepath.Join(base, "managed"), filepath.Join(base, "secrets"), filepath.Join(base, "logs")
	for _, dir := range []string{state, managedDir, secretDir, logs} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	secret := filepath.Join(secretDir, "token")
	settings := agent.Settings{VectorBinary: "fixed-vector", ManagedConfig: filepath.Join(managedDir, "vector.json"), SecretFiles: map[string]string{"TOKEN": secret}}
	if err := agent.WriteJSON(filepath.Join(state, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	if err := agent.SaveState(state, agent.State{ApplyState: "unmanaged", Policy: agent.Policy{HeartbeatSeconds: 60, TelemetryEnabled: true}}); err != nil {
		t.Fatal(err)
	}
	read := func() []byte {
		data, err := os.ReadFile(filepath.Join(state, "settings.json"))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	before := read()

	for name, tc := range map[string]struct{ root, thing string }{
		"the filesystem root":    {filepath.VolumeName(base) + string(filepath.Separator), "so pipelines could read and write every file on it"},
		"the state directory":    {state, "is the agent's state directory."},
		"below the state":        {filepath.Join(state, "assets"), "lies inside the agent's state directory"},
		"above the state":        {base, "contains the agent's state directory"},
		"the managed directory":  {managedDir, "is the managed configuration directory."},
		"the secret's directory": {secretDir, `contains the file bound to secret "TOKEN"`},
		"the secret file itself": {secret, `is the file bound to secret "TOKEN".`},
	} {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := invoke("allow", "--state-dir", state, "--network", "logs.example.test:443", "--file-root", logs, "--file-root", tc.root)
			if code != 1 || stdout != "" {
				t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
			}
			for _, want := range []string{"vectory: File root " + tc.root + " ", tc.thing, "Allow the directory that holds the files pipelines need, such as /var/log/app."} {
				if runtime.GOOS == "windows" {
					want = strings.ReplaceAll(want, "/var/log/app", `C:\Logs\app`)
				}
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr lacks %q:\n%s", want, stderr)
				}
			}
			// Nothing else in the same command was applied either.
			if !bytes.Equal(read(), before) {
				t.Fatal("a refused command changed the host's settings")
			}
		})
	}

	// A root of its own is allowed, and the command says what the host allows now.
	code, stdout, stderr := invoke("allow", "--state-dir", state, "--file-root", logs)
	if code != 0 || !strings.Contains(stdout, "Allowed files under "+logs+".") {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	saved, err := agent.LoadSettings(state)
	if err != nil || len(saved.CapabilityPolicy.AllowedFileRoots) != 1 || saved.CapabilityPolicy.AllowedFileRoots[0] != logs {
		t.Fatalf("the allowed root was not saved: %+v %v", saved.CapabilityPolicy, err)
	}
}
