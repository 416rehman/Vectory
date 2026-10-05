package agent

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func preflightTestExecutable(t *testing.T) string {
	t.Helper()
	running, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// setup resolves the executable before checking the staged candidate. Go's
	// macOS test binary may live below /var, which links to /private/var.
	running, err = filepath.EvalSymlinks(running)
	if err != nil {
		t.Fatal(err)
	}
	return running
}

func stagedRunningBuild(t *testing.T, target string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(filepath.Dir(target), ".vectory.new.fixture")
	in, err := os.Open(preflightTestExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInstallerPreflightBindsCandidateToRunningBuildAndDestination(t *testing.T) {
	target := filepath.Join(privateTempDir(t), "vectory")
	candidate := stagedRunningBuild(t, target)
	running := preflightTestExecutable(t)
	if err := checkInstallerCandidate(candidate, target, running, true); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(filepath.Dir(target), ".vectory.link.fixture")
		if err := os.Symlink(candidate, link); err != nil {
			t.Fatal(err)
		}
		if err := checkInstallerCandidate(link, target, running, true); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("symlinked staged candidate was not rejected: %v", err)
		}
	}
	for name, args := range map[string]struct {
		candidate, target string
		explicit          bool
	}{
		"missing agent path": {candidate, target, false},
		"same as target":     {candidate, candidate, true},
		"other directory":    {candidate, filepath.Join(privateTempDir(t), "vectory"), true},
		"relative path":      {".vectory.new.fixture", target, true},
	} {
		if err := checkInstallerCandidate(args.candidate, args.target, running, args.explicit); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if err := os.WriteFile(candidate, []byte("another executable"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := checkInstallerCandidate(candidate, target, running, true); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatal("mismatched staged bytes accepted", err)
	}
}

func TestInstallerPreflightChecksRequestedUpdateKeyWithoutChangingHost(t *testing.T) {
	f := newConsentFixture(t)
	foreign := testReleaseKey(t, "not offered")
	f.consent(UpdateConsentAuto, foreign)
	f.options.InstallerPreflight = stagedRunningBuild(t, f.agent)
	f.options.DryRun = false // the hidden preflight forces a read-only run
	f.options.Token = func() (string, error) { t.Fatal("preflight asked for token"); return "", nil }
	f.host.candidateAccess = func(context.Context, string, string) string { return "" }
	result, err := f.run()
	if err == nil || !result.DryRun || !strings.Contains(err.Error(), "offers no release key") {
		t.Fatalf("preflight did not reject foreign update key: %v\n%s", err, serviceDetail(result))
	}
	if f.server.keyRequests.Load() != 1 {
		t.Fatal("preflight did not fetch authenticated release keys")
	}
	if _, err := os.Lstat(f.agent); !os.IsNotExist(err) {
		t.Fatal("preflight replaced the installed target")
	}
	f.events = nil // the eligibility probe is read-only and expected
	f.untouched()
}

func TestInstallerPreflightEnforcesPrivilegeAndStagedAccountAccess(t *testing.T) {
	for _, refusal := range []string{"privilege", "service account"} {
		t.Run(refusal, func(t *testing.T) {
			f := newConsentFixture(t)
			f.options.InstallerPreflight = stagedRunningBuild(t, f.agent)
			f.options.DryRun = false
			f.options.Token = func() (string, error) { t.Fatal("preflight asked for token"); return "", nil }
			accessChecks := 0
			f.host.candidateAccess = func(context.Context, string, string) string {
				accessChecks++
				if refusal == "service account" {
					return "permission denied"
				}
				return ""
			}
			if refusal == "privilege" {
				f.host.elevated = func() bool { return false }
			}
			result, err := f.run()
			if err == nil || !result.DryRun {
				t.Fatalf("preflight accepted %s refusal: %v\n%s", refusal, err, serviceDetail(result))
			}
			if refusal == "privilege" && (accessChecks != 0 || !strings.Contains(err.Error(), "administrator rights")) {
				t.Fatalf("privilege was not checked first: %v, account checks %d", err, accessChecks)
			}
			if refusal == "service account" && (accessChecks != 1 || !strings.Contains(err.Error(), "staged agent")) {
				t.Fatalf("candidate account access was not checked: %v, checks %d", err, accessChecks)
			}
			if _, err := os.Lstat(f.agent); !os.IsNotExist(err) {
				t.Fatal("preflight replaced the installed target")
			}
		})
	}
}
