//go:build windows

package agent

import (
	"strings"
	"testing"
	"time"
)

// On Windows a drive root and C:\ProgramData let accounts create entries, as a default
// installation has them, and the path check refuses them only for the rights that
// change what an existing entry leads to. What the doctor tells a person to put right
// about a path that other accounts can change is therefore the directory the message
// names, or the directories the update uses, and never every directory above them.
func TestTheDoctorOnWindowsNamesTheDirectoryToPutRightAndNotEveryDirectoryAboveIt(t *testing.T) {
	now := viewNow
	policy := viewPolicy(t, UpdateConsentAuto)
	step := &UpdateStatus{RunAt: now.Add(-20 * time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1}
	policyView := UpdateView{StateDir: `C:\ProgramData\Vectory\agent`, ReadAt: now, Policy: DefaultUpdatePolicy(), PolicyFile: true, PolicyProblem: `C:\ProgramData\Vectory\updates can be changed by BUILTIN\Users (write)`}
	statusView := UpdateView{StateDir: `C:\ProgramData\Vectory\agent`, ReadAt: now, Policy: policy, StatusProblem: `C:\ProgramData\Vectory\update-state can be changed by BUILTIN\Users (write)`, Eligibility: "HELPER_NOT_RUNNING"}
	hostView := UpdateView{StateDir: `C:\ProgramData\Vectory\agent`, ReadAt: now, Policy: policy, Status: step, StepRunning: true, Eligibility: "UNTRUSTED_LOCATION"}
	hostView.Status.Eligibility = "UNTRUSTED_LOCATION"

	for name, tc := range map[string]struct {
		view UpdateView
		id   string
		fix  string
	}{
		"a policy whose directory others can change": {policyView, "updates", "Make the directory the message names writable by an administrator alone, or write it again: "},
		"a status whose directory others can change": {statusView, "updates-step", "Make the directory the message names an administrator's alone."},
		"a path the host reports others can change":  {hostView, "updates-host", `Make the install directory, %ProgramData%\Vectory and the directories in it that hold the update policy and the update step writable by an administrator alone, and keep them so. The directories above them may let other accounts create entries, as a default Windows install does in C:\ and in C:\ProgramData, but none may delete, rename or take over what it holds.`},
	} {
		t.Run(name, func(t *testing.T) {
			got := checkByID(updateChecks(tc.view), tc.id)
			if got == nil {
				t.Fatalf("no %s check", tc.id)
			}
			if got.Status != "fail" || !strings.HasPrefix(got.Fix, tc.fix) {
				t.Errorf("%s: %s, fix %q\nwant a fix that starts %q", tc.id, got.Status, got.Fix, tc.fix)
			}
			if strings.Contains(got.Fix, "every directory") {
				t.Errorf("the fix tells a person to change every directory on the way: %q", got.Fix)
			}
		})
	}
}
