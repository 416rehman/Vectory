//go:build !windows

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// What the probe tests need to know about the host they run on, and what they print
// when a script can't be started there. The log of a machine nobody can sign in to
// has to say why: who runs the script and as whom, the script and every directory
// above it with what the file system keeps besides the mode (owner, flags, access
// lists, extended attributes), the file system that holds it and how it is mounted,
// and the script started in each way the probe's own start differs from a plain one.

// startAsProbeAccount makes cmd run as the account the probe runs as, unless this
// process already is that account (only root can switch).
func startAsProbeAccount(cmd *exec.Cmd, account updateAccount) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	if os.Geteuid() != int(account.UID) || os.Getegid() != int(account.GID) {
		cmd.SysProcAttr.Credential = &syscall.Credential{Uid: account.UID, Gid: account.GID}
	}
}

// probeAccountIDs is the account as the access checks of the agent see it.
func probeAccountIDs(account updateAccount) accountIDs {
	return accountIDs{uid: int(account.UID), gid: int(account.GID), groups: map[int]bool{int(account.GID): true}}
}

// probeScriptStarts writes a script that does nothing into dir and starts it as the
// probe's account, the one thing the probe tests need from the directory they put
// their scripts in. It returns the script's path, which it leaves there.
func probeScriptStarts(dir string, account updateAccount) (string, error) {
	path := filepath.Join(dir, "starts")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		return path, err
	}
	if err := os.Chmod(path, 0o755); err != nil {
		return path, err
	}
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		cmd := exec.Command(path)
		cmd.Dir = "/"
		cmd.Env = cleanEnvironment()
		startAsProbeAccount(cmd, account)
		// A script that was written a moment ago can be busy while a process that
		// was forked meanwhile holds a copy of the descriptor it was written with.
		if err = cmd.Run(); !errors.Is(err, syscall.ETXTBSY) {
			return path, err
		}
		time.Sleep(20 * time.Millisecond)
	}
	return path, err
}

// diagnosticOutput runs a program for a report and returns what it printed, and why
// it failed when it did. It runs as the account when one is given.
func diagnosticOutput(account *updateAccount, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = "/"
	cmd.WaitDelay = time.Second
	if account != nil {
		startAsProbeAccount(cmd, *account)
	}
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if len(text) > 6000 {
		text = text[:6000] + "\n[cut]"
	}
	return text, err
}

// diagnosticCommand is diagnosticOutput as lines of a report: the command, then what
// it printed or the reason it couldn't run.
func diagnosticCommand(account *updateAccount, name string, args ...string) string {
	text, err := diagnosticOutput(account, name, args...)
	header := "$ " + strings.Join(append([]string{name}, args...), " ")
	if account != nil {
		header += fmt.Sprintf("   (as %d:%d)", account.UID, account.GID)
	}
	if err != nil {
		text = strings.TrimSpace(text + "\n[" + err.Error() + "]")
	}
	return header + "\n" + text
}

// ancestorsOf lists a path and every directory above it, the root first.
func ancestorsOf(path string) []string {
	var chain []string
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		chain = append([]string{p}, chain...)
		if filepath.Dir(p) == p {
			return chain
		}
	}
}

// holdingFileSystem says which file system holds path and how it is mounted: the
// line of df for it and the lines of mount for the same device and mount point. The
// mount point isn't a prefix of the path on a Mac, where the data volume is joined
// to the system volume below /System/Volumes, so df names it.
func holdingFileSystem(path string) string {
	report := diagnosticCommand(nil, "df", "-P", path)
	df, err := diagnosticOutput(nil, "df", "-P", path)
	lines := strings.Split(df, "\n")
	if err != nil || len(lines) < 2 {
		return report
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 6 {
		return report
	}
	device, point := fields[0], strings.Join(fields[5:], " ")
	mounts, _ := diagnosticOutput(nil, "mount")
	var matching []string
	for _, line := range strings.Split(mounts, "\n") {
		if strings.HasPrefix(line, device+" on "+point+" ") {
			matching = append(matching, line)
		}
	}
	if len(matching) == 0 {
		return report + "\n$ mount\nno line of it says " + device + " on " + point
	}
	return report + "\n$ mount | grep '^" + device + " on " + point + " '\n" + strings.Join(matching, "\n")
}

// startingAScript starts a script in dir as the probe's account in each way the
// probe's own start differs from a plain one (the directory, the environment, the
// process group), then through the shell, then with runProbe itself, and says for
// each whether it started. The script is one of its own, which does nothing, so that
// the answer doesn't wait for whatever the test's script does.
func startingAScript(dir string, account updateAccount) string {
	check := filepath.Join(dir, "diagnostic-probe")
	if err := os.WriteFile(check, []byte("#!/bin/sh\necho started\n"), 0o755); err != nil {
		return "couldn't write " + check + ": " + err.Error()
	}
	defer os.Remove(check)
	if err := os.Chmod(check, 0o755); err != nil {
		return "couldn't make " + check + " executable: " + err.Error()
	}
	var lines []string
	result := func(label string, out []byte, err error) {
		said := "started"
		if err != nil {
			said = "failed: " + err.Error()
		}
		if text := strings.TrimSpace(string(out)); text != "" && text != "started" {
			said += fmt.Sprintf(" (it printed %q)", text)
		}
		lines = append(lines, fmt.Sprintf("%-31s %s", label+":", said))
	}
	args := []string{"version", "--json"}
	try := func(label, name string, args []string, apply func(*exec.Cmd)) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, name, args...)
		cmd.WaitDelay = time.Second
		startAsProbeAccount(cmd, account)
		if apply != nil {
			apply(cmd)
		}
		out, err := cmd.CombinedOutput()
		result(label, out, err)
	}
	try("plain", check, args, nil)
	try("from the directory /", check, args, func(c *exec.Cmd) { c.Dir = "/" })
	try("in a process group of its own", check, args, func(c *exec.Cmd) { c.SysProcAttr.Setpgid = true })
	try("with the probe's environment", check, args, func(c *exec.Cmd) { c.Env = cleanEnvironment() })
	try("all three, as the probe does", check, args, func(c *exec.Cmd) {
		c.Dir, c.Env = "/", cleanEnvironment()
		c.SysProcAttr.Setpgid = true
	})
	try("through /bin/sh", "/bin/sh", append([]string{check}, args...), nil)
	out, err := runProbe(context.Background(), check, account, 5*time.Second)
	result("runProbe itself", out, err)
	return strings.Join(lines, "\n")
}

// probeDiagnostics is the report a failing probe test prints about script, which is
// started as account.
func probeDiagnostics(script string, account updateAccount) string {
	var report strings.Builder
	section := func(title, body string) {
		fmt.Fprintf(&report, "\n--- %s\n%s\n", title, strings.TrimRight(body, "\n"))
	}
	dir := filepath.Dir(script)
	resolved := script
	if r, err := filepath.EvalSymlinks(script); err == nil {
		resolved = r
	}
	groups, _ := os.Getgroups()
	who := fmt.Sprintf("%s/%s. This process is uid %d (effective %d), gid %d (effective %d), groups %v. The probe runs as %d:%d.\nTMPDIR=%q, os.TempDir()=%q, the script is %s",
		runtime.GOOS, runtime.GOARCH, os.Getuid(), os.Geteuid(), os.Getgid(), os.Getegid(), groups, account.UID, account.GID,
		os.Getenv("TMPDIR"), os.TempDir(), script)
	if resolved != script {
		who += " (" + resolved + ")"
	}
	section("who and where", who)

	host := []string{diagnosticCommand(nil, "uname", "-a")}
	if runtime.GOOS == "darwin" {
		host = append(host, diagnosticCommand(nil, "sw_vers"), diagnosticCommand(nil, "spctl", "--status"), diagnosticCommand(nil, "csrutil", "status"))
	}
	section("the host", strings.Join(host, "\n"))

	listing := "-ld"
	if runtime.GOOS == "darwin" {
		// Flags, access lists and extended attributes: what a Mac keeps besides the mode.
		listing = "-ldeO@"
	}
	section("the script and every directory above it", diagnosticCommand(nil, "ls", append([]string{listing}, ancestorsOf(resolved)...)...))
	if runtime.GOOS == "darwin" {
		section("the extended attributes of the script and of its directory", diagnosticCommand(nil, "xattr", "-l", resolved, filepath.Dir(resolved)))
	}
	blocked := "by the permission bits, nothing on the way keeps the account from entering and running it"
	if blocker, _ := accessBlocker(probeAccountIDs(account), resolved, false); blocker != "" {
		blocked = "by the permission bits, " + blocker
	}
	section("who the account is, and what it sees of the script", blocked+"\n"+diagnosticCommand(&account, "id")+"\n"+diagnosticCommand(&account, "ls", "-ld", resolved))
	section("the file system that holds the directory", holdingFileSystem(dir))
	section("starting a script there as the account", startingAScript(dir, account))
	return report.String()
}

// probeFailed ends a test whose probe didn't do what its script says, with the host's
// own account of how the script is started.
func probeFailed(t *testing.T, script, format string, args ...any) {
	t.Helper()
	t.Fatalf("%s\n%s", fmt.Sprintf(format, args...), probeDiagnostics(script, probeAccount()))
}

func TestTheDiagnosticsOfAProbeTestSayHowAScriptIsStartedAndWhatTheHostKeepsAboutIt(t *testing.T) {
	account := probeAccount()
	script := probeScript(t, scriptDir(t), "exit 0")
	report := probeDiagnostics(script, account)
	for _, want := range []string{
		"--- who and where", "--- the host", "--- the script and every directory above it",
		"--- who the account is, and what it sees of the script", "--- the file system that holds the directory",
		"--- starting a script there as the account", "plain:", "all three, as the probe does:", "through /bin/sh:", "runProbe itself:",
	} {
		if !strings.Contains(report, want) {
			t.Errorf("the diagnostics lack %q:\n%s", want, report)
		}
	}
	if runtime.GOOS == "darwin" && !strings.Contains(report, "--- the extended attributes") {
		t.Errorf("a Mac's diagnostics lack the extended attributes:\n%s", report)
	}
	// In a directory where a script starts, it starts in every way.
	matrix := report[strings.Index(report, "--- starting a script there as the account"):]
	if strings.Contains(matrix, " failed: ") {
		t.Errorf("a script that starts the probe's way doesn't start in every way here:\n%s", report)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(script), "diagnostic-probe")); err == nil {
		t.Error("the diagnostics left their script in the directory")
	}
}

func TestTheDiagnosticsNameADirectoryTheAccountCantEnter(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("another account can be told apart from this one only by root")
	}
	// t.TempDir is private to its owner, as a Mac's whole temporary folder is.
	private := t.TempDir()
	script := probeScript(t, private, "exit 0")
	account := probeAccount()
	if err := os.Chmod(filepath.Dir(private), 0o700); err != nil {
		t.Fatal(err)
	}
	report := probeDiagnostics(script, account)
	matrix := report[strings.Index(report, "--- starting a script there as the account"):]
	// The shell says in its own words that it can't open the script, so it isn't asked.
	for _, label := range []string{"plain:", "from the directory /:", "all three, as the probe does:", "runProbe itself:"} {
		line := ""
		for _, candidate := range strings.Split(matrix, "\n") {
			if strings.HasPrefix(candidate, label) {
				line = candidate
			}
		}
		if !strings.Contains(line, " failed: ") || !strings.Contains(strings.ToLower(line), "permission denied") {
			t.Errorf("%s the line says %q, and the account can't enter the directory", label, line)
		}
	}
	if !strings.Contains(report, "Permission denied") {
		t.Errorf("the account's own look at the script doesn't say it was refused:\n%s", report)
	}
}

// The probe's account must reach its script. A Mac's temporary folder belongs to the
// account that runs the tests and is closed to every other, so a script put there
// can't be started as another account, which is what root does. The tests must find
// another place for it.
func TestTheScriptDirectoryIsOneTheProbesAccountCanEnterWhenTheTemporaryFolderIsPrivate(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("the probe runs as another account only when root runs the tests")
	}
	private := t.TempDir()
	if err := os.Chmod(filepath.Dir(private), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", private)
	dir := scriptDir(t)
	if strings.HasPrefix(dir, private+string(filepath.Separator)) {
		t.Errorf("the script directory %s is in the private temporary folder %s", dir, private)
	}
	if blocker, _ := accessBlocker(probeAccountIDs(probeAccount()), dir, false); blocker != "" {
		t.Errorf("the probe's account can't enter the script directory: %s", blocker)
	}
	script := probeScript(t, dir, `printf '{"version":"0.1.1","os":"%s","arch":"%s"}\n' `+runtime.GOOS+` `+runtime.GOARCH)
	output, err := runProbe(context.Background(), script, probeAccount(), 5*time.Second)
	if err != nil {
		t.Fatalf("a script in it doesn't start as the account: %v", err)
	}
	if refusal := checkProbeOutput(output, "0.1.1"); refusal != nil {
		t.Errorf("what the script printed is a good probe answer: %v", refusal)
	}
}
