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

func TestMaxAgentBuildIsTheContractsBoundOnABuild(t *testing.T) {
	if MaxAgentBuild != 128*1024*1024 || MaxAgentBuild <= MaxArtifact {
		t.Errorf("MaxAgentBuild is %d", MaxAgentBuild)
	}
	if !strings.Contains(string(repoFile(t, "contracts/CONTRACT.md")), "134,217,728") {
		t.Error("the contract doesn't state the bound the constant stands for")
	}
}
