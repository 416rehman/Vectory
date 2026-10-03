package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/vectory/vectory/agent/internal/agent"
)

func TestVersionTakesFlagsOnlyLikeEveryOtherCommand(t *testing.T) {
	for _, args := range [][]string{{"version", "extra"}, {"version", "--json", "extra"}, {"--version", "extra"}} {
		code, stdout, stderr := invoke(args...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "version accepts flags only; unexpected positional arguments") {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	if code, _, stderr := invoke("version", "--nope"); code != 2 || !strings.Contains(stderr, "unknown flag --nope") {
		t.Errorf("an unknown flag: %d %q", code, stderr)
	}
	for _, args := range [][]string{{"version"}, {"version", "--state-dir", "/srv/agent"}, {"-v"}} {
		if code, stdout, _ := invoke(args...); code != 0 || !strings.HasPrefix(stdout, "vectory "+agent.Version) {
			t.Errorf("%v: %d %q", args, code, stdout)
		}
	}
	code, stdout, _ := invoke("version", "--json")
	var document map[string]string
	if code != 0 || json.Unmarshal([]byte(stdout), &document) != nil || document["version"] != agent.Version {
		t.Errorf("version --json: %d %q", code, stdout)
	}
}

func TestFlagsBeforeTheCommandAreSaidSo(t *testing.T) {
	for args, want := range map[string]string{
		"--json status":                  "vectory status --json",
		"--state-dir /srv/vectory logs":  "vectory logs --state-dir /srv/vectory",
		"--state-dir '/srv/my dir' logs": "vectory logs --state-dir '/srv/my dir'",
		"-json doctor":                   "vectory doctor -json",
	} {
		var fields []string
		for _, field := range strings.Fields(args) {
			fields = append(fields, strings.Trim(field, "'"))
		}
		if strings.Contains(args, "my dir") {
			fields = []string{"--state-dir", "/srv/my dir", "logs"}
		}
		code, stdout, stderr := invoke(fields...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "put the command first: "+want) {
			t.Errorf("%s: %d %q %q", args, code, stdout, stderr)
		}
	}
	// The compatibility form still enrolls: a device name that is also a command
	// is a value, not a command.
	code, _, stderr := invoke("-ip", "https://vectory.example.com:8443", "-id", "status", "-token", "t", "--state-dir", filepath.Join(t.TempDir(), "none"))
	if strings.Contains(stderr, "put the command first") {
		t.Errorf("the compatibility form was taken for a misplaced command: %d %q", code, stderr)
	}
}

func TestLogsLinesNeedsAWholeNumberInRange(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	for _, lines := range []string{"abc", "0", "-5", "100001", "1.5"} {
		code, stdout, stderr := invoke("logs", "--state-dir", dir, "--lines", lines)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "--lines needs a whole number from 1 to 100000") {
			t.Errorf("--lines %s: %d %q %q", lines, code, stdout, stderr)
		}
	}
	if code, _, stderr := invoke("logs", "--state-dir", dir, "--lines", "abc"); !strings.Contains(stderr, `"abc" isn't one`) {
		t.Errorf("the value is echoed: %d %q", code, stderr)
	}
	if code, _, stderr := invoke("logs", "--state-dir", dir, "--lines", "5"); code != 1 || !strings.Contains(stderr, "no Vector log yet") {
		t.Errorf("a valid count: %d %q", code, stderr)
	}
	if code, _, stderr := invoke("install", "--state-dir", dir, "--graceful-shutdown-seconds", "abc"); code != 2 || !strings.Contains(stderr, "--graceful-shutdown-seconds needs a whole number of seconds from 5 to 300") {
		t.Errorf("seconds that aren't a number: %d %q", code, stderr)
	}
}

// A member with nothing to say is absent, not null; logs --json is one object
// per line, an error included.
func TestJSONOmitsEmptyListsAndLogsErrorsStayOnOneLine(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	code, stdout, stderr := invoke("allow", "--state-dir", dir, "--network", "127.0.0.1:8688", "--json")
	if code != 0 || stderr != "" || strings.Contains(stdout, "null") {
		t.Fatalf("allow --json: %d %q %q", code, stdout, stderr)
	}
	var document struct {
		Added      map[string][]string `json:"added"`
		Allowances map[string][]string `json:"allowances"`
	}
	if err := json.Unmarshal([]byte(stdout), &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Added) != 1 || document.Added["allowed_network_hosts"][0] != "127.0.0.1:8688" || len(document.Allowances) != 1 {
		t.Fatalf("only the list with entries is present: %q", stdout)
	}
	if code, stdout, _ = invoke("allow", "--state-dir", dir, "--network", "127.0.0.1:8688", "--json"); code != 0 || !strings.Contains(stdout, `"added": {}`) {
		t.Fatalf("nothing added: %d %q", code, stdout)
	}
	code, stdout, _ = invoke("logs", "--state-dir", installedDir(t, agent.CapabilityPolicy{}), "--json")
	if code != 1 || strings.Count(strings.TrimSpace(stdout), "\n") != 0 || !strings.Contains(stdout, `"error":"no Vector log yet`) {
		t.Fatalf("logs --json before any log: %d %q", code, stdout)
	}
}

func TestUninstallWithNothingToRemoveSaysSo(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "agent")
	for _, args := range [][]string{{"uninstall", "--state-dir", missing}, {"uninstall", "--purge", "--state-dir", missing}} {
		code, stdout, stderr := invoke(args...)
		if code != 0 || stderr != "" || stdout != "Nothing to remove: "+missing+" doesn't exist.\n" {
			t.Errorf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	if code, stdout, _ := invoke("uninstall", "--purge", "--state-dir", missing, "--json"); code != 0 || !strings.Contains(stdout, `"removed": false`) {
		t.Errorf("--json: %d %q", code, stdout)
	}
	// An interrupted purge is run again and finds nothing left.
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Dir(dir)
	installed := agent.Settings{VectorBinary: filepath.Join(parent, "vector"), VectorBinarySHA256: agent.Digest([]byte("fixture vector")), ManagedConfig: filepath.Join(parent, "managed.json"), Adopted: true, ValidationSeconds: 30, StartupSeconds: 20}
	if err := agent.WriteJSON(filepath.Join(dir, "settings.json"), installed); err != nil {
		t.Fatal(err)
	}
	if code, stdout, stderr := invoke("uninstall", "--purge", "--state-dir", dir); code != 0 || !strings.HasPrefix(stdout, "Deleted "+dir) {
		t.Fatalf("the purge: %d %q %q", code, stdout, stderr)
	}
	if code, stdout, _ := invoke("uninstall", "--purge", "--state-dir", dir); code != 0 || stdout != "Nothing to remove: "+dir+" doesn't exist.\n" {
		t.Errorf("the purge again: %d %q", code, stdout)
	}
}

func TestUnenrollSaysWhetherThereWereCredentials(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	code, stdout, stderr := invoke("unenroll", "--state-dir", dir)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "This host has no credentials: it isn't enrolled, so there was nothing to remove.") || strings.Contains(stdout, "Local credentials removed") {
		t.Errorf("a host that was never enrolled: %d %q %q", code, stdout, stderr)
	}
	if code, stdout, _ = invoke("unenroll", "--state-dir", dir, "--json"); code != 0 || !strings.Contains(stdout, `"credentials_removed": false`) {
		t.Errorf("--json: %d %q", code, stdout)
	}
	dir = installedDir(t, agent.CapabilityPolicy{})
	if err := agent.WriteJSON(filepath.Join(dir, "identity.json"), agent.IdentityBundle{Credentials: agent.Credentials{DeviceID: "5e7a9c2d-0000-4000-8000-000000000001"}}); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr = invoke("unenroll", "--state-dir", dir)
	if code != 0 || !strings.HasPrefix(stdout, "Local credentials removed. Also revoke this device in the dashboard") {
		t.Errorf("an enrolled host: %d %q %q", code, stdout, stderr)
	}
	if code, stdout, _ = invoke("unenroll", "--state-dir", dir); code != 0 || !strings.Contains(stdout, "This host has no credentials") {
		t.Errorf("the second time: %d %q", code, stdout)
	}
}

func TestASecondRunSaysAnAgentAlreadyRuns(t *testing.T) {
	dir := statusDir(t, nil, "", 0)
	code, _, stderr := invoke("run", "--state-dir", dir)
	want := "An agent already runs on this state directory (vectory run, pid " + strconv.Itoa(os.Getpid()) + ")."
	if code != 1 || !strings.Contains(stderr, want) || strings.Contains(stderr, "needs it stopped") {
		t.Errorf("a second agent: %d %q", code, stderr)
	}
}

func TestConfigureSecretsSaysWhatItDid(t *testing.T) {
	dir, secret, _ := bindingCLIState(t)
	path := filepath.Join(t.TempDir(), "bindings.json")
	for bindings, want := range map[string]string{
		`{"ONE":` + strconv.Quote(secret) + `}`:                                     "Saved 1 secret-file binding. Start the agent to use it;",
		`{"ONE":` + strconv.Quote(secret) + `,"TWO":` + strconv.Quote(secret) + `}`: "Saved 2 secret-file bindings. Start the agent to use them;",
		`{}`: "Removed all secret-file bindings. Start the agent to apply this;",
	} {
		if err := os.WriteFile(path, []byte(bindings), 0600); err != nil {
			t.Fatal(err)
		}
		if code, stdout, stderr := invoke("configure-secrets", "--state-dir", dir, "--secret-files", path); code != 0 || !strings.HasPrefix(stdout, want) {
			t.Errorf("%s: %d %q %q", bindings, code, stdout, stderr)
		}
	}
	code, _, stderr := invoke("configure-secrets", "--state-dir", dir, "--secret-files", "relative/bindings.json")
	if code != 2 || !strings.Contains(stderr, "--secret-files relative/bindings.json isn't an absolute path") {
		t.Errorf("a relative path: %d %q", code, stderr)
	}
}

func TestReAdoptWithoutADigestIsAUsageError(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	if code, _, stderr := invoke("re-adopt", "--state-dir", dir); code != 2 || !strings.Contains(stderr, "--expected-sha256 is required") {
		t.Errorf("no digest: %d %q", code, stderr)
	}
	if code, _, stderr := invoke("re-adopt", "--state-dir", dir, "--expected-sha256", "abc"); code != 2 || !strings.Contains(stderr, "64 hexadecimal characters, and abc has 3") {
		t.Errorf("a short digest: %d %q", code, stderr)
	}
}

func TestInstallWithAnOutOfRangeDrainIsAUsageError(t *testing.T) {
	dir := installedDir(t, agent.CapabilityPolicy{})
	if code, _, stderr := invoke("install", "--state-dir", dir, "--graceful-shutdown-seconds", "3"); code != 2 || !strings.Contains(stderr, "--graceful-shutdown-seconds 3 is out of range") {
		t.Errorf("%d %q", code, stderr)
	}
}
