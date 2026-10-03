//go:build !windows

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The real probe runner, on real processes: shell scripts stand in for builds. As
// root it switches to uid and gid 65534, which is what it does for the service
// account; as anyone else it runs as that account itself, which is all the account
// a test can be.

func probeAccount() updateAccount {
	if os.Geteuid() == 0 {
		return updateAccount{Name: "nobody", UID: 65534, GID: 65534}
	}
	return updateAccount{Name: "self", UID: uint32(os.Geteuid()), GID: uint32(os.Getegid())}
}

// scriptDir is a directory every account can enter and write, outside the test's
// private temporary directory (which only its owner may enter): the account the
// probe runs as must reach the script.
func scriptDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vectory-probe-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func probeScript(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "vectory")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTheProbeRunsAsTheServiceAccountWithNoOtherGroupAndNothingFromTheStepsEnvironment(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	t.Setenv("VECTORY_PROBE_LEAK", "a secret of the step")
	t.Setenv("VECTORY_TOKEN", "another")
	account := probeAccount()
	script := probeScript(t, scriptDir(t), `printf '{"version":"0.1.1","os":"%s","arch":"%s","uid":%s,"gid":%s,"groups":"%s","cwd":"%s","leak":"%s%s","args":"%s","stdin":"%s","stderr":"%s"}\n' `+
		runtime.GOOS+` `+runtime.GOARCH+` "$(id -u)" "$(id -g)" "$(id -G)" "$(pwd)" "$VECTORY_PROBE_LEAK" "$VECTORY_TOKEN" "$*" "$(readlink /proc/$$/fd/0)" "$(readlink /proc/$$/fd/2)"`)
	output, err := unixUpdateHost{}.RunProbe(context.Background(), script, account)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		UID, GID                uint32
		Groups, Cwd, Leak, Args string
		Stdin, Stderr           string
	}
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	if report.UID != account.UID || report.GID != account.GID {
		t.Errorf("the probe ran as %d:%d, not as %d:%d", report.UID, report.GID, account.UID, account.GID)
	}
	if os.Geteuid() == 0 && report.Groups != strconv.Itoa(int(account.GID)) {
		t.Errorf("the probe has the groups %q, and root's supplementary groups must not be among them", report.Groups)
	}
	if report.Cwd != "/" {
		t.Errorf("the probe ran from %q", report.Cwd)
	}
	if report.Leak != "" {
		t.Errorf("the probe saw the step's environment: %q", report.Leak)
	}
	if report.Args != "version --json" {
		t.Errorf("the probe was run with %q", report.Args)
	}
	if report.Stdin != "/dev/null" || report.Stderr != "/dev/null" {
		t.Errorf("standard input is %q and standard error %q", report.Stdin, report.Stderr)
	}
	if refusal := checkProbeOutput(output, "0.1.1"); refusal != nil {
		t.Errorf("what the script printed is a good probe answer: %v", refusal)
	}
}

func TestTheProbeNeverRunsAsRootAndStartsNothingForIt(t *testing.T) {
	dir := scriptDir(t)
	marker := filepath.Join(dir, "ran")
	script := probeScript(t, dir, `echo ran > `+marker)
	if _, err := (unixUpdateHost{}).RunProbe(context.Background(), script, updateAccount{Name: "root", UID: 0, GID: 0}); err == nil {
		t.Fatal("the probe ran as root")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("the build was started")
	}
}

// What the step holds open (its directories, its lock, a file it read) is opened
// close-on-exec, so none of it reaches a build that runs from the step.
func TestNoDescriptorOfTheStepReachesTheProbe(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	root := ownTree(t)
	mkdirMode(t, filepath.Join(root, "private"), 0o700)
	private, err := ensureRootOwnedDir(filepath.Join(root, "private"), rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	release, err := unixUpdateHost{}.Lock(private)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := (unixUpdateHost{}).CopyInto(private, "journal.json", rootPrivate, strings.NewReader("{}"), 2); err != nil {
		t.Fatal(err)
	}
	held, err := private.OpenAt("journal.json")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	script := probeScript(t, scriptDir(t), `printf '{"version":"0.1.1","os":"%s","arch":"%s","fds":"%s"}\n' `+runtime.GOOS+` `+runtime.GOARCH+` "$(for f in /proc/$$/fd/*; do readlink "$f"; done | tr '\n' ' ')"`)
	output, err := unixUpdateHost{}.RunProbe(context.Background(), script, probeAccount())
	if err != nil {
		t.Fatal(err)
	}
	var report struct{ Fds string }
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	for _, target := range strings.Fields(report.Fds) {
		if strings.Contains(target, root) || strings.Contains(target, "journal") || strings.Contains(target, "lock") {
			t.Errorf("the probe holds %s of the step", target)
		}
	}
	if report.Fds == "" {
		t.Error("the script listed no descriptor at all")
	}
}

// aliveAndRunning reports whether a process exists and hasn't ended (a process that
// has ended and is waiting to be collected doesn't count).
func aliveAndRunning(pid int) bool {
	if runtime.GOOS == "linux" {
		data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			return false
		}
		fields := strings.Fields(string(data[strings.LastIndexByte(string(data), ')')+1:]))
		return len(fields) > 0 && fields[0] != "Z" && fields[0] != "X"
	}
	return syscall.Kill(pid, 0) == nil
}

func waitUntilProcessEnds(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !aliveAndRunning(pid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("process %d is still running", pid)
	syscall.Kill(pid, syscall.SIGKILL)
}

// waitForPID reads the process id a script wrote, waiting for it.
func waitForPID(path string) (int, bool) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
				return pid, true
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return 0, false
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	pid, ok := waitForPID(path)
	if !ok {
		t.Fatalf("no process id in %s", path)
	}
	return pid
}

// A build that doesn't answer is ended with everything it started, at the time
// limit, and the step goes on with a refusal rather than a wait.
func TestAProbeThatNeverAnswersIsEndedWithEverythingItStartedAtTheTimeLimit(t *testing.T) {
	dir := scriptDir(t)
	child := filepath.Join(dir, "child.pid")
	script := probeScript(t, dir, `sleep 60 &
echo $! > `+child+`
sleep 60`)
	started := time.Now()
	_, err := runProbe(context.Background(), script, probeAccount(), 1500*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "didn't finish") {
		t.Fatalf("a probe that never answered: %v", err)
	}
	if took := time.Since(started); took > 6*time.Second {
		t.Errorf("the step waited %s for a probe limited to 1.5s", took)
	}
	waitUntilProcessEnds(t, readPID(t, child))
}

func TestAProbeThatPrintsMoreThanTheBoundIsRefusedAndNeverBlocked(t *testing.T) {
	script := probeScript(t, scriptDir(t), `head -c 1000000 /dev/zero | tr '\0' a`)
	started := time.Now()
	_, err := runProbe(context.Background(), script, probeAccount(), 5*time.Second)
	if !errors.Is(err, errProbeOutputTooLong) {
		t.Fatalf("a probe that printed a megabyte: %v", err)
	}
	if took := time.Since(started); took > 4*time.Second {
		t.Errorf("a probe that printed a megabyte took %s", took)
	}
}

func TestAProbeThatExitsWithAFailureIsAFailedProbeWhatEverItPrinted(t *testing.T) {
	script := probeScript(t, scriptDir(t), `printf '{"version":"0.1.1","os":"%s","arch":"%s"}\n' `+runtime.GOOS+` `+runtime.GOARCH+`
exit 3`)
	if output, err := runProbe(context.Background(), script, probeAccount(), 5*time.Second); err == nil {
		t.Fatalf("a probe that exited 3 passed: %s", output)
	}
	if _, err := runProbe(context.Background(), filepath.Join(scriptDir(t), "missing"), probeAccount(), 5*time.Second); err == nil {
		t.Error("a build that isn't there passed")
	}
	notExecutable := filepath.Join(scriptDir(t), "vectory")
	if err := os.WriteFile(notExecutable, []byte("#!/bin/sh\necho {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runProbe(context.Background(), notExecutable, probeAccount(), 5*time.Second); err == nil {
		t.Error("a file that isn't executable passed")
	}
}

// A step that is stopped while it waits for the probe ends the probe and says it
// was stopped; that is not a failed probe, and nothing is concluded about the build.
func TestAProbeIsEndedWhenTheStepIsStoppedAndThatIsNotAFailedProbe(t *testing.T) {
	dir := scriptDir(t)
	child := filepath.Join(dir, "child.pid")
	script := probeScript(t, dir, `echo $$ > `+child+`
sleep 60`)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		waitForPID(child)
		cancel()
	}()
	_, err := runProbe(ctx, script, probeAccount(), 30*time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("a probe whose step was stopped: %v", err)
	}
	waitUntilProcessEnds(t, readPID(t, child))
}

func TestTheProbesTimeLimitIsTheStepsTenSeconds(t *testing.T) {
	if updateProbeTimeout != 10*time.Second || updateProbeOutput != 4096 {
		t.Errorf("the probe is limited to %s and %d bytes", updateProbeTimeout, updateProbeOutput)
	}
}
