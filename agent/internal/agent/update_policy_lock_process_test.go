package agent

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// Separate agent processes must use the same policy lock. Holding it here
// keeps both child edits from reading an old basis; after release, each child
// reads the last committed policy and both edits survive.
func TestUpdatePolicyLockSerializesProcesses(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	unlock, err := lockUpdatePolicy(dir)
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(unlock)
	defer release()

	type child struct {
		mode   string
		ready  string
		cmd    *exec.Cmd
		done   chan error
		output bytes.Buffer
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	children := []*child{}
	t.Cleanup(func() {
		for _, c := range children {
			if c.cmd.Process != nil {
				_ = c.cmd.Process.Kill()
			}
		}
	})
	for _, mode := range []string{"pause", "pins"} {
		c := &child{mode: mode, ready: filepath.Join(t.TempDir(), "ready"), done: make(chan error, 1)}
		c.cmd = exec.Command(binary, "-test.run=^TestUpdatePolicyLockChild$")
		c.cmd.Env = append(os.Environ(),
			"VECTORY_TEST_POLICY_LOCK_CHILD=1",
			"VECTORY_TEST_POLICY_LOCK_ANCHOR="+rootOwnedTrust.anchor,
			"VECTORY_TEST_POLICY_LOCK_DIR="+paths.PolicyDir,
			"VECTORY_TEST_POLICY_LOCK_STEP="+paths.StepDir,
			"VECTORY_TEST_POLICY_LOCK_READY="+c.ready,
			"VECTORY_TEST_POLICY_LOCK_MODE="+mode,
		)
		c.cmd.Stdout, c.cmd.Stderr = &c.output, &c.output
		if err := c.cmd.Start(); err != nil {
			t.Fatal(err)
		}
		children = append(children, c)
		go func() { c.done <- c.cmd.Wait() }()
	}
	for _, c := range children {
		deadline := time.After(10 * time.Second)
		ticker := time.NewTicker(10 * time.Millisecond)
		for {
			if _, err := os.Stat(c.ready); err == nil {
				break
			}
			select {
			case err := <-c.done:
				t.Fatalf("%s child exited before calling ChangeUpdatePolicy: %v\n%s", c.mode, err, c.output.String())
			case <-deadline:
				t.Fatalf("%s child did not start its policy edit", c.mode)
			case <-ticker.C:
			}
		}
		ticker.Stop()
	}
	for _, c := range children {
		select {
		case err := <-c.done:
			t.Fatalf("%s child completed while the parent held the policy lock: %v\n%s", c.mode, err, c.output.String())
		case <-time.After(250 * time.Millisecond):
		}
	}
	release()
	for _, c := range children {
		if err := waitForPolicyWrite(t, c.done, c.mode+" child"); err != nil {
			t.Fatalf("%s child: %v\n%s", c.mode, err, c.output.String())
		}
	}
	got, err := ReadUpdatePolicy()
	if err != nil || !got.Paused || len(got.Keys) != 2 || got.Keys[1].Key.Fingerprint() != nextFingerprint {
		t.Errorf("both process edits must survive: %+v, %v", got, err)
	}
}

func TestUpdatePolicyLockChild(t *testing.T) {
	if os.Getenv("VECTORY_TEST_POLICY_LOCK_CHILD") != "1" {
		t.Skip("helper for TestUpdatePolicyLockSerializesProcesses")
	}
	trustTree(t, os.Getenv("VECTORY_TEST_POLICY_LOCK_ANCHOR"))
	paths := newUpdatePaths(os.Getenv("VECTORY_TEST_POLICY_LOCK_DIR"), os.Getenv("VECTORY_TEST_POLICY_LOCK_STEP"), runtime.GOOS == "windows")
	updateLocationsOverride = &paths
	if err := os.WriteFile(os.Getenv("VECTORY_TEST_POLICY_LOCK_READY"), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := ChangeUpdatePolicy(func(p *UpdatePolicy) error {
		switch os.Getenv("VECTORY_TEST_POLICY_LOCK_MODE") {
		case "pause":
			p.Paused = true
		case "pins":
			p.SetPinnedKeys([]ReleaseKey{p.Keys[0].Key, testKey(t, nextKeyLine)})
		default:
			return fmt.Errorf("unknown policy test edit")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
