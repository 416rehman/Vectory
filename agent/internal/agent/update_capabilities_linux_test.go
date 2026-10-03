//go:build linux

package agent

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

// The unit lists the only capabilities the privileged step may have. The step's
// own file operations and the probe are run here under exactly that set, so a call
// that needs another (a chown, or a change of a file's mode or times by someone who
// doesn't own it) fails in this test and says which, instead of in the native proof.
//
// The set is dropped from the bounding set of a child of the test binary with
// setpriv, which for root is the capabilities the child has after it starts, as it
// is for the unit. Root is needed to do it, so the tests that run as root run it.

// underUnitCapsEnv marks the run under the unit's capabilities.
const underUnitCapsEnv = "VECTORY_TEST_UNDER_UNIT_CAPABILITIES"

// capabilityNumbers are the numbers of the capabilities the unit may name, as
// /proc reports them.
var capabilityNumbers = map[string]uint{
	"CAP_CHOWN": 0, "CAP_DAC_OVERRIDE": 1, "CAP_FOWNER": 3, "CAP_KILL": 5, "CAP_SETGID": 6, "CAP_SETUID": 7,
}

// unitCapabilities is the unit's CapabilityBoundingSet, by name.
func unitCapabilities(t *testing.T) []string {
	t.Helper()
	service, _, err := systemdUpdateUnits(testUnitSpec())
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(service, "\n") {
		if value, found := strings.CutPrefix(line, "CapabilityBoundingSet="); found {
			return strings.Fields(value)
		}
	}
	t.Fatal("the step's unit has no CapabilityBoundingSet")
	return nil
}

func TestTheStepsPrimitivesRunUnderTheCapabilitiesTheUnitGrantsAndNoMore(t *testing.T) {
	if os.Getenv(underUnitCapsEnv) != "" {
		t.Skip("this is the run under the unit's capabilities")
	}
	if os.Geteuid() != 0 {
		t.Skip("dropping capabilities from a bounding set takes root")
	}
	setpriv, err := exec.LookPath("setpriv")
	if err != nil {
		t.Skip("setpriv isn't installed")
	}
	set := "-all"
	for _, name := range unitCapabilities(t) {
		set += ",+" + strings.ToLower(strings.TrimPrefix(name, "CAP_"))
	}
	if out, err := exec.Command(setpriv, "--bounding-set", set, "true").CombinedOutput(); err != nil {
		t.Skipf("this system doesn't let a process drop capabilities from its bounding set: %v: %s", err, out)
	}

	// The step's swap and staging, its copies, and the probe that runs a build as the
	// service account and ends it with a signal; with the check that the capabilities
	// really are the unit's.
	names := []string{"TestWhileRunUnderTheUnitsCapabilitiesTheProcessHasExactlyThem", "TestTheStepsFilesAreWrittenAtomicallyAndPrivately"}
	declared := regexp.MustCompile(`(?m)^func (Test\w+)\(t \*testing\.T\)`)
	for _, file := range []string{"update_swap_unix_test.go", "update_probe_unix_test.go"} {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range declared.FindAllStringSubmatch(string(source), -1) {
			names = append(names, match[1])
		}
	}
	self, err := os.Executable()
	if err != nil {
		t.Skip("this system can't say which file runs the test")
	}
	command := exec.Command(setpriv, "--bounding-set", set, self, "-test.count=1", "-test.run", "^("+strings.Join(names, "|")+")$")
	command.Env = append(os.Environ(), underUnitCapsEnv+"=1")
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("under CapabilityBoundingSet=%s a call the step makes was refused, or the probe was not ended:\n%s", set, out)
	}
}

// While run by the test above: the process has the capabilities of the unit and no
// others.
func TestWhileRunUnderTheUnitsCapabilitiesTheProcessHasExactlyThem(t *testing.T) {
	if os.Getenv(underUnitCapsEnv) == "" {
		t.Skip("only the run under the unit's capabilities looks at them")
	}
	var want uint64
	for _, name := range unitCapabilities(t) {
		number, known := capabilityNumbers[name]
		if !known {
			t.Fatalf("%s has no number in capabilityNumbers", name)
		}
		want |= 1 << number
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"CapBnd", "CapEff", "CapPrm"} {
		match := regexp.MustCompile(`(?m)^` + field + `:\s*([0-9a-f]+)$`).FindStringSubmatch(string(status))
		if match == nil {
			t.Fatalf("/proc/self/status has no %s", field)
		}
		var got uint64
		for _, digit := range match[1] {
			got = got<<4 | uint64(strings.IndexRune("0123456789abcdef", digit))
		}
		if got != want {
			t.Errorf("%s is %x, and the unit grants %x", field, got, want)
		}
	}
}
