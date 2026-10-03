//go:build !windows

package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Turning updates off deletes what the agent staged, as root, from a directory the
// service account owns. Root deletes through the path to it only when the
// directory that holds the state directory is root's alone (the root-owned path
// check, with the account of the test standing in for root): otherwise the account
// could put a link in the state directory's place and have root delete what the
// link names. These tests build the state directory under a tree the test owns,
// where one of its directories is what the service account might own.

// withdrawalTree is the tree the test owns, which the path check trusts this
// account in, and the update paths in it: the way to a host whose agent took
// updates.
func withdrawalTree(t *testing.T) (root string, paths UpdatePaths) {
	t.Helper()
	requireRootOwnedWriter(t)
	paths = useUpdateRoots(t)
	root = filepath.Dir(filepath.Dir(filepath.Dir(paths.PolicyDir)))
	if err := WriteUpdatePolicy(viewPolicy(t, UpdateConsentAuto)); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.StepDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return root, paths
}

// stagedIn makes what the agent keeps in the updates directory of a state
// directory, and returns the file that stands for a staged build.
func stagedIn(t *testing.T, state string) string {
	t.Helper()
	incoming := filepath.Join(UpdateExchangeFor(state).Incoming, strings.Repeat("a", 64))
	if err := os.MkdirAll(incoming, 0o700); err != nil {
		t.Fatal(err)
	}
	build := filepath.Join(incoming, "build")
	if err := os.WriteFile(build, []byte("a staged build"), 0o600); err != nil {
		t.Fatal(err)
	}
	return build
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// leftMessage is what a person reads when the staged files were left.
func leftMessage(dir string) string {
	return "The staged files in " + dir + " were not deleted: the directory above the agent's state isn't owned by root, so root won't delete through it. Delete them yourself."
}

// Where the way to the state directory is root's alone, as /var/lib is, what the
// agent staged is deleted, and the state directory itself stays.
func TestWithdrawingUpdatesDeletesWhatTheAgentStagedWhereRootAloneHoldsTheStateDirectory(t *testing.T) {
	root, _ := withdrawalTree(t)
	state := filepath.Join(root, "var", "lib", "vectory-agent")
	build := stagedIn(t, state)
	for _, dir := range []string{filepath.Join(root, "var"), filepath.Join(root, "var", "lib")} {
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	removed := 0
	done, err := withdrawUpdates(state, func() error { removed++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !done.PolicyOff || !done.Discarded || done.StagedLeft != nil || !done.StepRemoved || removed != 1 || done.KeysKept != 1 {
		t.Fatalf("%+v, step removed %d times", done, removed)
	}
	if exists(build) || exists(UpdateExchangeFor(state).Dir) {
		t.Fatal("what the agent staged was kept")
	}
	if !exists(state) {
		t.Fatal("the state directory was deleted with what was staged in it")
	}
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentOff || len(policy.Keys) != 1 {
		t.Fatalf("%+v %v", policy, err)
	}
}

// Where the directory above the state directory can be changed by another account
// (or is a link), nothing is deleted. Consent is withdrawn and the step removed
// all the same, and the answer says what was left.
func TestWithdrawingUpdatesLeavesTheStagedFilesWhereAnotherAccountCouldSwapTheStateDirectory(t *testing.T) {
	for name, tc := range map[string]struct {
		// build makes the state directory with what the agent staged in it, and returns
		// the state directory, the directory the check refuses, what the check says
		// about it, and the files that must still be there.
		build func(t *testing.T, root string) (state, refused, why string, survivors []string)
	}{
		"the directory above is writable by everyone": {func(t *testing.T, root string) (string, string, string, []string) {
			state := filepath.Join(root, "srv", "agent")
			build := stagedIn(t, state)
			mkdirMode(t, filepath.Join(root, "srv"), 0o777)
			return state, filepath.Join(root, "srv"), "is writable by its group and by everyone (mode 0777)", []string{build}
		}},
		"the directory above is writable by its group": {func(t *testing.T, root string) (string, string, string, []string) {
			state := filepath.Join(root, "srv", "agent")
			build := stagedIn(t, state)
			mkdirMode(t, filepath.Join(root, "srv"), 0o775)
			return state, filepath.Join(root, "srv"), "is writable by its group (mode 0775)", []string{build}
		}},
		"a directory further above is writable by its group": {func(t *testing.T, root string) (string, string, string, []string) {
			state := filepath.Join(root, "var", "lib", "agent")
			build := stagedIn(t, state)
			mkdirMode(t, filepath.Join(root, "var", "lib"), 0o755)
			mkdirMode(t, filepath.Join(root, "var"), 0o775)
			return state, filepath.Join(root, "var"), "is writable by its group (mode 0775)", []string{build}
		}},
		"the directory above is a link": {func(t *testing.T, root string) (string, string, string, []string) {
			build := stagedIn(t, filepath.Join(root, "real", "agent"))
			if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "srv")); err != nil {
				t.Skipf("no symbolic links here: %v", err)
			}
			return filepath.Join(root, "srv", "agent"), filepath.Join(root, "srv"), "is a symbolic link", []string{build}
		}},
		// The attack the check is for: the account that owns the state directory, in a
		// directory it can write, puts a link in its place that names something root
		// holds dear.
		"the state directory was swapped for a link": {func(t *testing.T, root string) (string, string, string, []string) {
			precious := stagedIn(t, filepath.Join(root, "victim"))
			mkdirMode(t, filepath.Join(root, "srv"), 0o777)
			if err := os.Symlink(filepath.Join(root, "victim"), filepath.Join(root, "srv", "agent")); err != nil {
				t.Skipf("no symbolic links here: %v", err)
			}
			return filepath.Join(root, "srv", "agent"), filepath.Join(root, "srv"), "is writable by its group and by everyone (mode 0777)", []string{precious}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			root, _ := withdrawalTree(t)
			state, refused, why, survivors := tc.build(t, root)
			removed := 0
			done, err := withdrawUpdates(state, func() error { removed++; return nil })
			if err != nil {
				t.Fatal(err)
			}
			left := UpdateExchangeFor(state).Dir
			if done.StagedLeft == nil || done.Discarded || done.StagedLeft.Code != "UNTRUSTED_LOCATION" || done.StagedLeft.Path != left {
				t.Fatalf("%+v", done)
			}
			if want := refused + " " + why; done.StagedLeft.Detail != want {
				t.Fatalf("the check found %q, want %q", done.StagedLeft.Detail, want)
			}
			if got := done.StagedLeft.Message(); got != leftMessage(left) {
				t.Fatalf("%q", got)
			}
			for _, file := range survivors {
				if !exists(file) {
					t.Fatalf("%s was deleted through a path another account could change", file)
				}
			}
			// What the withdrawal is for happened all the same.
			if !done.PolicyOff || !done.StepRemoved || removed != 1 || done.KeysKept != 1 {
				t.Fatalf("%+v, step removed %d times", done, removed)
			}
			if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentOff || len(policy.Keys) != 1 {
				t.Fatalf("%+v %v", policy, err)
			}
			// It reads as it should in JSON.
			raw, err := json.Marshal(done.StagedLeft)
			var decoded map[string]string
			if err != nil || json.Unmarshal(raw, &decoded) != nil || decoded["code"] != "UNTRUSTED_LOCATION" || decoded["path"] != left || decoded["detail"] != done.StagedLeft.Detail || decoded["message"] != leftMessage(left) || len(decoded) != 4 {
				t.Fatalf("%s %v", raw, err)
			}
		})
	}
}

// With nothing staged there is nothing to say, whatever the directory above the
// state directory is.
func TestWithdrawingUpdatesSaysNothingAboutFilesThatAreNotThere(t *testing.T) {
	for name, build := range map[string]func(t *testing.T, root string) string{
		"no updates directory, above a directory others can write": func(t *testing.T, root string) string {
			mkdirMode(t, filepath.Join(root, "srv", "agent"), 0o700)
			mkdirMode(t, filepath.Join(root, "srv"), 0o777)
			return filepath.Join(root, "srv", "agent")
		},
		"no state directory": func(t *testing.T, root string) string { return filepath.Join(root, "nowhere", "agent") },
		"no state directory above one others can write": func(t *testing.T, root string) string {
			mkdirMode(t, filepath.Join(root, "srv"), 0o777)
			return filepath.Join(root, "srv", "agent")
		},
	} {
		t.Run(name, func(t *testing.T) {
			root, _ := withdrawalTree(t)
			state := build(t, root)
			done, err := withdrawUpdates(state, func() error { return nil })
			if err != nil || done.StagedLeft != nil || done.Discarded || !done.PolicyOff || !done.StepRemoved {
				t.Fatalf("%+v %v", done, err)
			}
		})
	}
}

// Where root may delete, a link in the place of the staged files is removed and
// never followed.
func TestWithdrawingUpdatesRemovesALinkInPlaceOfTheStagedFilesAndDoesNotFollowIt(t *testing.T) {
	root, _ := withdrawalTree(t)
	state := filepath.Join(root, "var", "lib", "agent")
	precious := filepath.Join(root, "elsewhere", "precious")
	if err := os.MkdirAll(filepath.Dir(precious), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(precious, []byte("not for deleting"), 0o600); err != nil {
		t.Fatal(err)
	}
	mkdirMode(t, state, 0o700)
	mkdirMode(t, filepath.Join(root, "var", "lib"), 0o755)
	if err := os.Symlink(filepath.Dir(precious), UpdateExchangeFor(state).Dir); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	done, err := withdrawUpdates(state, func() error { return nil })
	if err != nil || !done.Discarded || done.StagedLeft != nil {
		t.Fatalf("%+v %v", done, err)
	}
	if exists(UpdateExchangeFor(state).Dir) {
		t.Fatal("the link was kept")
	}
	if !exists(precious) {
		t.Fatal("the link was followed")
	}
}

// ---------------------------------------------------------------- setup --updates off

// Setup says it in its own steps and in its JSON: updates are off, and the files
// the agent staged were left, with the sentence a person needs.
func TestSetupOffLeavesTheStagedFilesWhereTheDirectoryAboveTheStateDirectoryIsNotRoots(t *testing.T) {
	f := newConsentFixture(t)
	f.turnedOn()
	if err := os.MkdirAll(f.paths.StepDir, 0o755); err != nil {
		t.Fatal(err)
	}
	build := stagedIn(t, f.dir)
	holder := filepath.Dir(f.dir)
	if err := os.Chmod(holder, 0o777); err != nil {
		t.Fatal(err)
	}
	f.options.Updates, f.options.UpdateKeys = UpdateConsentOff, nil
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	left := UpdateExchangeFor(f.dir).Dir
	if !exists(build) {
		t.Fatal("what the agent staged was deleted through a directory others could change")
	}
	if want := "off · the policy says off · the update step is removed · the pinned key is kept"; lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q, want %q", lastUpdatesStep(t, result).Detail, want)
	}
	var staged []SetupStep
	for _, step := range result.Steps {
		if step.ID == "updates-staged" {
			staged = append(staged, step)
		}
	}
	if len(staged) != 1 || staged[0].Status != "warn" || staged[0].Label != "Updates" || staged[0].Detail != leftMessage(left) || staged[0].Fix != "" {
		t.Fatalf("%+v", staged)
	}
	if got := result.Updates; got == nil || got.Consent != UpdateConsentOff || got.StagedLeft == nil || got.StagedLeft.Code != "UNTRUSTED_LOCATION" || got.StagedLeft.Path != left {
		t.Fatalf("%+v", got)
	}
	raw, err := json.Marshal(result)
	var decoded struct {
		Updates struct {
			Consent    string            `json:"consent"`
			StagedLeft map[string]string `json:"staged_left"`
		} `json:"updates"`
	}
	if err != nil || json.Unmarshal(raw, &decoded) != nil || decoded.Updates.Consent != "off" || decoded.Updates.StagedLeft["code"] != "UNTRUSTED_LOCATION" || decoded.Updates.StagedLeft["path"] != left || decoded.Updates.StagedLeft["message"] != leftMessage(left) {
		t.Fatalf("%s %v", raw, err)
	}
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentOff || len(policy.Keys) != 1 {
		t.Fatalf("%+v %v", policy, err)
	}
	if events := strings.Join(f.events, ","); !strings.Contains(events, "remove-step") {
		t.Fatalf("the step wasn't removed: %s", events)
	}
	// With the directory put right, the same command deletes them, and says nothing.
	if err := os.Chmod(holder, 0o755); err != nil {
		t.Fatal(err)
	}
	f.events = nil
	again, err := f.run()
	if err != nil || !again.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(again))
	}
	if exists(build) || exists(left) || again.Updates == nil || again.Updates.StagedLeft != nil || stepStatus(again, "updates-staged") != "" {
		t.Fatalf("%+v %+v", again.Updates, again.Steps)
	}
}
