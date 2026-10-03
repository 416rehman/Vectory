package agent

import (
	"context"
	"strings"
	"testing"
)

// The signatures of the step's API are frozen: the host side is written against
// them. This fails to compile when one changes.
var (
	_ func(dir, executable string) error                                             = InstallUpdateHelper
	_ func() error                                                                   = RemoveUpdateHelper
	_ func(ctx context.Context, dir string, force bool, progress func(string)) error = ApplyStagedUpdate
	_ func(ctx context.Context, dir string) error                                    = RunUpdateHelper
	_ func(dir string) string                                                        = UpdateEligibility
)

func TestUntilTheStepIsBuiltEveryFunctionSaysSoAndNoHostIsEligible(t *testing.T) {
	ctx := context.Background()
	for name, err := range map[string]error{
		"InstallUpdateHelper": InstallUpdateHelper("/var/lib/vectory-agent", "/usr/local/bin/vectory"),
		"RemoveUpdateHelper":  RemoveUpdateHelper(),
		"ApplyStagedUpdate":   ApplyStagedUpdate(ctx, "/var/lib/vectory-agent", false, func(string) {}),
		"RunUpdateHelper":     RunUpdateHelper(ctx, "/var/lib/vectory-agent"),
	} {
		if err != errUpdateHelperUnavailable {
			t.Errorf("%s: %v", name, err)
		}
	}
	eligibility := UpdateEligibility("/var/lib/vectory-agent")
	if eligibility == UpdateEligible || !oneOf(eligibility, updateEligibilities) {
		t.Errorf("a host with no step: %q", eligibility)
	}
	if !strings.Contains(errUpdateHelperUnavailable.Error(), "step") {
		t.Errorf("the error: %v", errUpdateHelperUnavailable)
	}
}

func TestMaxAgentBuildIsTheContractsBoundOnABuild(t *testing.T) {
	if MaxAgentBuild != 128*1024*1024 || MaxAgentBuild <= MaxArtifact {
		t.Errorf("MaxAgentBuild is %d", MaxAgentBuild)
	}
	if !strings.Contains(string(repoFile(t, "contracts/CONTRACT.md")), "134,217,728") {
		t.Error("the contract doesn't state the bound the constant stands for")
	}
}
