package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setup reads the allowance file before it changes anything, so a root that
// covers the directories it is about to create is refused in a dry run too, at
// the mode step, and nothing is created.
func TestSetupRefusesAFileRootThatCoversItsOwnDirectories(t *testing.T) {
	server := newSetupServer(t)
	for name, tc := range map[string]struct {
		root func(state, managed string) string
		want string
	}{
		"the state directory":      {func(state, _ string) string { return state }, "is the agent's state directory."},
		"the managed directory":    {func(_, managed string) string { return filepath.Dir(managed) }, "is the managed configuration directory."},
		"the directory above both": {func(state, _ string) string { return filepath.Dir(state) }, "contains the agent's state directory"},
	} {
		for _, dryRun := range []bool{true, false} {
			t.Run(name+map[bool]string{true: ", dry run", false: ""}[dryRun], func(t *testing.T) {
				options, dir, managed := setupFixture(t)
				options.Server, options.CASHA256, options.VectorBinary, options.DryRun = server.url, server.pin, fakeVector(t, VectorVersion), dryRun
				options.Token = func() (string, error) { t.Fatal("asked for the token before the checks passed"); return "", nil }
				root := tc.root(dir, managed)
				allowances, _ := json.Marshal(map[string][]string{"allowed_file_roots": {root}})
				options.CapabilityPolicy = filepath.Join(t.TempDir(), "allowances.json")
				if err := os.WriteFile(options.CapabilityPolicy, allowances, 0o600); err != nil {
					t.Fatal(err)
				}
				result, err := Setup(context.Background(), options)
				if err == nil || stepStatus(result, "mode") != "fail" || !strings.Contains(err.Error(), "File root "+root+" ") || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("%v %+v", err, result.Steps)
				}
				for _, path := range []string{dir, filepath.Dir(managed)} {
					if _, err := os.Stat(path); !os.IsNotExist(err) {
						t.Fatalf("setup created %s", path)
					}
				}
			})
		}
	}
}
