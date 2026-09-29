package agent

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func installedPurgeFixture(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	settings := Settings{
		VectorBinary:       filepath.Join(filepath.Dir(dir), "vector"),
		VectorBinarySHA256: Digest([]byte("fixture vector")),
		ManagedConfig:      filepath.Join(filepath.Dir(dir), "config", "managed.json"),
		Adopted:            true,
		ValidationSeconds:  30,
		StartupSeconds:     20,
	}
	if err := WriteJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPurgeRejectsForeignSettingsBeforeWritingMarker(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "foreign")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"theme":"dark","adopted":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "valuable-data")
	if err := os.WriteFile(other, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := PurgeState(dir); err == nil {
		t.Fatal("foreign settings were accepted as an installation")
	}
	for _, path := range []string{settings, other} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("foreign directory was modified: %v", err)
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, purgeMarkerName)); !os.IsNotExist(err) {
		t.Fatalf("foreign directory acquired a purge marker: %v", err)
	}
}

func TestPurgeHoldsLifecycleFenceThroughRemoval(t *testing.T) {
	dir := installedPurgeFixture(t)
	entered := make(chan struct{})
	continueRemoval := make(chan struct{})
	done := make(chan error, 1)
	var first sync.Once
	go func() {
		done <- purgeState(dir, func(path string) error {
			first.Do(func() {
				close(entered)
				<-continueRemoval
			})
			return os.RemoveAll(path)
		})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("purge did not reach removal")
	}
	if unlock, err := Lock(dir); err == nil {
		unlock()
		t.Fatal("operation entered while purge was in progress")
	}
	if err := SetPause(dir, true); err == nil {
		t.Fatal("pause wrote state while purge was in progress")
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err != nil {
		t.Fatalf("state changed before purge removal resumed: %v", err)
	}
	close(continueRemoval)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatalf("purge left state directory: %v", err)
	}
	if err := SetPause(dir, true); err == nil {
		t.Fatal("pause succeeded after purge")
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatalf("pause recreated purged state directory: %v", err)
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if unlock, err := Lock(dir); err != nil {
		t.Fatalf("fresh operation could not enter after purge: %v", err)
	} else {
		unlock()
	}
}

func TestFreshInstallCannotRecreateStateDuringPurgeFence(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	release, err := lockLifecycle(dir)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- createFreshStateDirectory(dir) }()
	if err := <-done; err == nil {
		release()
		t.Fatal("fresh install entered while purge held lifecycle fence")
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		release()
		t.Fatalf("fresh install created state during purge fence: %v", err)
	}
	release()
	if err := createFreshStateDirectory(dir); err != nil {
		t.Fatalf("fresh install could not create state after fence released: %v", err)
	}
}

func TestPurgeRefusesActiveAgentAndReleasesAfterInterruptedRemoval(t *testing.T) {
	dir := installedPurgeFixture(t)
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := PurgeState(dir); err == nil {
		t.Fatal("purge succeeded despite active agent operation")
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err != nil {
		t.Fatalf("busy purge removed state: %v", err)
	}
	unlock()
	marker := filepath.Join(dir, "interrupted")
	if err := os.WriteFile(marker, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("simulated interrupted removal")
	err = purgeState(dir, func(path string) error {
		if err := os.Remove(marker); err != nil {
			return err
		}
		return interrupted
	})
	if !errors.Is(err, interrupted) {
		t.Fatalf("partial removal reported %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err != nil {
		t.Fatalf("remaining state was unexpectedly removed: %v", err)
	}
	if err := PurgeState(dir); err != nil {
		t.Fatalf("retry after interruption could not acquire released fence: %v", err)
	}
}

func TestLifecycleGuardHelper(t *testing.T) {
	if dir := os.Getenv("VECTORY_TEST_PURGE_DIR"); dir != "" {
		err := purgeState(dir, func(path string) error {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
			if filepath.Base(path) == "settings.json" {
				fmt.Println("settings-removed")
				time.Sleep(30 * time.Second)
			}
			return nil
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(3)
		}
		return
	}
	dir := os.Getenv("VECTORY_TEST_LIFECYCLE_DIR")
	if dir == "" {
		return
	}
	release, err := lockLifecycle(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	defer release()
	fmt.Println("lifecycle-ready")
	time.Sleep(30 * time.Second)
}

func TestPurgeResumesAfterProcessDiesWithoutSettings(t *testing.T) {
	dir := installedPurgeFixture(t)
	secret := filepath.Join(dir, "z-credential")
	if err := os.WriteFile(secret, []byte("fixture-only"), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestLifecycleGuardHelper$")
	cmd.Env = append(os.Environ(), "VECTORY_TEST_PURGE_DIR="+dir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- strings.TrimSpace(line)
	}()
	select {
	case line := <-ready:
		if line != "settings-removed" {
			t.Fatalf("helper did not reach partial purge: %q; %s", line, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper did not reach partial purge")
	}
	if _, err := os.Lstat(filepath.Join(dir, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("settings survived interrupted purge: %v", err)
	}
	if _, err := os.Stat(secret); err != nil {
		t.Fatalf("remaining fixture state disappeared before interruption: %v", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	if unlock, err := Lock(dir); err == nil {
		unlock()
		t.Fatal("operation entered partially purged state")
	}
	if err := SetPause(dir, true); err == nil {
		t.Fatal("pause modified partially purged state")
	}
	if err := PurgeState(dir); err != nil {
		t.Fatalf("interrupted purge could not resume without settings: %v", err)
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatalf("retried purge left state directory: %v", err)
	}
}

func TestPurgeFinalBoundaryAndMarkerPreflight(t *testing.T) {
	dir := installedPurgeFixture(t)
	markerPath := filepath.Join(dir, purgeMarkerName)
	if err := os.Mkdir(markerPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := PurgeState(dir); err == nil {
		t.Fatal("malformed in-state marker did not refuse purge")
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err != nil {
		t.Fatalf("marker preflight removed state: %v", err)
	}
	if err := os.Remove(markerPath); err != nil {
		t.Fatal(err)
	}
	identity, err := purgeMarkerIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	directoryID, err := stateDirectoryIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	marker := purgeMarker{Kind: "vectory-agent-state-purge-v1", StateDir: identity, DirectoryID: directoryID}
	if err := WriteJSON(markerPath, marker); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "settings.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(markerPath); err != nil {
		t.Fatal(err)
	}
	if err := PurgeState(dir); err == nil {
		t.Fatal("final-gap empty directory was silently accepted as installed state")
	}
	if err := SetPause(dir, true); err == nil {
		t.Fatal("pause repopulated final-gap empty directory")
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Fatalf("final-gap residue should be empty for manual cleanup: %v, %v", entries, err)
	}
}

func TestPurgeMarkerRejectsReplacementDirectory(t *testing.T) {
	dir := installedPurgeFixture(t)
	identity, err := purgeMarkerIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	directoryID, err := stateDirectoryIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	marker := purgeMarker{Kind: "vectory-agent-state-purge-v1", StateDir: identity, DirectoryID: directoryID}
	if err := WriteJSON(filepath.Join(dir, purgeMarkerName), marker); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if replacementID, err := stateDirectoryIdentity(dir); err != nil {
		t.Fatal(err)
	} else if replacementID == directoryID {
		t.Skip("filesystem immediately reused the deleted directory identity")
	}
	if err := WriteJSON(filepath.Join(dir, purgeMarkerName), marker); err != nil {
		t.Fatal(err)
	}
	newFile := filepath.Join(dir, "unrelated")
	if err := os.WriteFile(newFile, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := PurgeState(dir); err == nil {
		t.Fatal("purge deleted a replacement directory")
	}
	if _, err := os.Stat(newFile); err != nil {
		t.Fatalf("replacement directory was changed: %v", err)
	}
}

func TestLifecycleFenceIsReleasedWhenProcessDies(t *testing.T) {
	dir := installedPurgeFixture(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestLifecycleGuardHelper$")
	cmd.Env = append(os.Environ(), "VECTORY_TEST_LIFECYCLE_DIR="+dir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- strings.TrimSpace(line)
	}()
	select {
	case line := <-ready:
		if line != "lifecycle-ready" {
			t.Fatalf("helper did not acquire guard: %q; %s", line, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper did not acquire lifecycle guard")
	}
	if unlock, err := Lock(dir); err == nil {
		unlock()
		t.Fatal("cross-process guard did not block lock acquisition")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	if err := PurgeState(dir); err != nil {
		t.Fatalf("abandoned lifecycle guard prevented safe retry: %v", err)
	}
}
