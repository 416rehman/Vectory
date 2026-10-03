//go:build !windows

package agent

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Everything in <state>/updates is the service account's. A service account that is
// compromised (a full-mode pipeline can run any command as it) writes what it likes
// there; the step copies, verifies and installs only what a pinned key signed, and
// refuses the rest. Each test here is one thing the account can do, and the host
// after it is the host before.

func (f *stepFixture) incoming(release *fakeRelease) string {
	dir, err := UpdateExchangeFor(f.stateDir).IncomingDir(release.manifestSHA())
	if err != nil {
		f.t.Fatal(err)
	}
	return dir
}

// runWithTimeout runs the step and fails when it doesn't return: a named pipe in
// place of a file must not make the step wait for a writer.
func (f *stepFixture) runWithTimeout() {
	f.t.Helper()
	done := make(chan error, 1)
	go func() { done <- f.run() }()
	select {
	case err := <-done:
		if err != nil {
			f.t.Fatalf("the step failed: %v", err)
		}
	case <-time.After(30 * time.Second):
		f.t.Fatal("the step is waiting on something the service account made")
	}
}

func TestAStagedFileThatIsALinkFifoOrDirectoryIsRefusedWithoutBeingRead(t *testing.T) {
	names := []string{UpdateReleaseFile, UpdateSignaturesFile, UpdateRolloversFile, UpdateBuildFile(runtime.GOOS)}
	kinds := map[string]func(f *stepFixture, release *fakeRelease, path string){
		"a symbolic link to the real file": func(f *stepFixture, release *fakeRelease, path string) {
			real := path + ".real"
			if err := os.Rename(path, real); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(real, path); err != nil {
				t.Fatal(err)
			}
		},
		"a symbolic link to a file of root's": func(f *stepFixture, release *fakeRelease, path string) {
			_ = os.Remove(path)
			if err := os.Symlink("/etc/passwd", path); err != nil {
				t.Fatal(err)
			}
		},
		"a named pipe": func(f *stepFixture, release *fakeRelease, path string) {
			_ = os.Remove(path)
			if err := syscall.Mkfifo(path, 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"a directory": func(f *stepFixture, release *fakeRelease, path string) {
			_ = os.Remove(path)
			if err := os.Mkdir(path, 0o700); err != nil {
				t.Fatal(err)
			}
		},
	}
	for kind, make := range kinds {
		for _, name := range names {
			t.Run(kind+" in place of "+name, func(t *testing.T) {
				f := newStepFixture(t)
				release := f.newRelease("0.1.1", "good", releaseOptions{})
				f.stage(release)
				make(f, release, filepath.Join(f.incoming(release), name))
				before := f.snapshot()
				f.runWithTimeout()
				f.requireAnswered(release, UpdateOutcomeRefused, "UNTRUSTED_LOCATION")
				f.requireUnchanged(before)
			})
		}
	}
}

func TestADirectoryOfTheOfferThatIsALinkIsRefusedAtEveryDepth(t *testing.T) {
	for name, link := range map[string]func(f *stepFixture, release *fakeRelease){
		"the offer's own directory": func(f *stepFixture, release *fakeRelease) {
			dir := f.incoming(release)
			real := dir + "-real"
			if err := os.Rename(dir, real); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(real, dir); err != nil {
				t.Fatal(err)
			}
		},
		"incoming": func(f *stepFixture, release *fakeRelease) {
			incoming := UpdateExchangeFor(f.stateDir).Incoming
			if err := os.Rename(incoming, incoming+"-real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(incoming+"-real", incoming); err != nil {
				t.Fatal(err)
			}
		},
		"updates": func(f *stepFixture, release *fakeRelease) {
			updates := UpdateExchangeFor(f.stateDir).Dir
			if err := os.Rename(updates, updates+"-real"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(updates+"-real", updates); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			link(f, release)
			before := f.snapshot()
			f.runWithTimeout()
			if f.executableDigest() != before.executable || len(f.service().History) != len(before.history) {
				t.Fatal("a link in the exchange directory made the step install something")
			}
			if journal, found := f.journal(); found {
				t.Errorf("a journal is left: %+v", journal)
			}
		})
	}
}

func TestAStagedFileThatBelongsToAnotherAccountIsRefused(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("making a file of root's, or a hard link to one, takes root")
	}
	for _, name := range []string{UpdateReleaseFile, UpdateBuildFile(runtime.GOOS), UpdateSignaturesFile} {
		t.Run("a hard link to a file of root's in place of "+name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			root := filepath.Join(f.root, "rootfile")
			if err := os.WriteFile(root, []byte(strings.Repeat("secret ", 20)), 0o600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(f.incoming(release), name)
			_ = os.Remove(path)
			if err := os.Link(root, path); err != nil {
				t.Fatal(err)
			}
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, UpdateOutcomeRefused, "UNTRUSTED_LOCATION")
			f.requireUnchanged(before)
		})
	}
	t.Run("a request of root's", func(t *testing.T) {
		f := newStepFixture(t)
		release := f.newRelease("0.1.1", "good", releaseOptions{})
		f.stage(release)
		if err := os.Lchown(UpdateExchangeFor(f.stateDir).Request, 0, 0); err != nil {
			t.Fatal(err)
		}
		before := f.snapshot()
		f.mustRun()
		if f.status().Last != nil {
			t.Error("a request that isn't the service account's was answered")
		}
		f.requireUnchanged(before)
	})
}

func TestOpenServiceFileOpensOnlyARegularFileOfTheServiceAccountWithinItsBound(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := os.Geteuid()
	if owner == 0 {
		owner = 65534
	}
	account := updateAccount{Name: "svc", UID: uint32(owner), GID: uint32(owner)}
	write := func(name string, size int, uid int) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0o600); err != nil {
			t.Fatal(err)
		}
		if os.Geteuid() == 0 {
			if err := os.Chown(path, uid, uid); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("small", 100, owner)
	host := unixUpdateHost{}

	t.Run("a file of the account that is exactly as large as the bound", func(t *testing.T) {
		file, err := host.OpenServiceFile(dir, "small", account, 100)
		if err != nil {
			t.Fatal(err)
		}
		defer file.File.Close()
		if file.Size != 100 {
			t.Errorf("the size is %d", file.Size)
		}
	})
	t.Run("a file one byte over the bound", func(t *testing.T) {
		if _, err := host.OpenServiceFile(dir, "small", account, 99); !errors.Is(err, errServiceFileTooLarge) {
			t.Errorf("got %v", err)
		}
	})
	t.Run("a file that isn't there", func(t *testing.T) {
		if _, err := host.OpenServiceFile(dir, "missing", account, 100); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("got %v", err)
		}
	})
	if os.Geteuid() != 0 {
		return
	}
	var refusal *UpdateRefusal
	t.Run("a file of another account", func(t *testing.T) {
		other := updateAccount{Name: "other", UID: account.UID + 1, GID: account.GID + 1}
		if _, err := host.OpenServiceFile(dir, "small", other, 100); !errors.As(err, &refusal) || refusal.Code != "UNTRUSTED_LOCATION" {
			t.Errorf("got %v", err)
		}
	})
	t.Run("a service account that is root", func(t *testing.T) {
		write("rootfile", 100, 0)
		if _, err := host.OpenServiceFile(dir, "rootfile", updateAccount{Name: "root", UID: 0, GID: 0}, 100); !errors.As(err, &refusal) || refusal.Code != "UNTRUSTED_LOCATION" {
			t.Errorf("got %v", err)
		}
	})
}

func TestAStagedFileThatIsLargerThanItsBoundIsRefusedWithoutBeingCopied(t *testing.T) {
	grow := func(name string, size int64) func(f *stepFixture, release *fakeRelease) {
		return func(f *stepFixture, release *fakeRelease) {
			if err := os.Truncate(filepath.Join(f.incoming(release), name), size); err != nil {
				t.Fatal(err)
			}
		}
	}
	for name, c := range map[string]struct {
		change func(f *stepFixture, release *fakeRelease)
		code   string
	}{
		"a manifest of 20 KiB":             {grow(UpdateReleaseFile, 20*1024), "MANIFEST_INVALID"},
		"signatures of 5 KiB":              {grow(UpdateSignaturesFile, 5*1024), "SIGNATURE_INVALID"},
		"rollovers of 17 KiB":              {grow(UpdateRolloversFile, 17*1024), "MANIFEST_INVALID"},
		"a build one byte over the bound":  {grow(UpdateBuildFile(runtime.GOOS), MaxAgentBuild+1), "ARTIFACT_MISMATCH"},
		"a build of the right size, grown": {grow(UpdateBuildFile(runtime.GOOS), 1<<20), "ARTIFACT_MISMATCH"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			c.change(f, release)
			before := f.snapshot()
			f.mustRun()
			f.requireAnswered(release, outcomeOf(c.code, true), c.code)
			f.requireUnchanged(before)
		})
	}
}

func TestAStagedFileReplacedAfterTheStepCopiedItChangesNothing(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	evil := fakeBuild("6.6.6", "good", "evil")
	replaced := map[string]bool{}
	updateFault = func(point string) {
		// After the build is copied, replace it in the agent's directory, and the
		// manifest and the signature too, with files the key never signed.
		if point == "built" && !replaced[point] {
			replaced[point] = true
			dir := f.incoming(release)
			f.host.writeAsAccount(filepath.Join(dir, UpdateBuildFile(runtime.GOOS)), evil, f.clock.Now())
			f.host.writeAsAccount(filepath.Join(dir, UpdateReleaseFile), []byte(`{"evil":true}`), f.clock.Now())
			f.host.writeAsAccount(filepath.Join(dir, UpdateSignaturesFile), []byte(`{"evil":true}`), f.clock.Now())
		}
	}
	f.mustRun()
	if got := f.executableDigest(); got != release.buildSHA() {
		t.Fatalf("the executable is %s: the step used what the service account wrote after it was copied", got)
	}
	if f.status().Last.Outcome != UpdateOutcomeCommitted {
		t.Errorf("the result: %+v", f.status().Last)
	}
	if got := fileDigest(t, f.paths.HelperExecutable); got != release.buildSHA() {
		t.Errorf("the helper copy is %s", got)
	}
}

func TestABuildReplacedBeforeTheStepCopiesItFailsTheSignedDigest(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.1", "good", releaseOptions{})
	f.stage(release)
	updateFault = func(point string) {
		if point == "verified" {
			f.host.writeAsAccount(filepath.Join(f.incoming(release), UpdateBuildFile(runtime.GOOS)), fakeBuild("0.1.1", "good", "evil"), f.clock.Now())
		}
	}
	before := f.snapshot()
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeFailed, "ARTIFACT_MISMATCH")
	f.requireUnchanged(before)
}

// The build is held to the signed digest where each copy of it is made, before the
// next copy: one byte differs and the size is the signed size, at the three places a
// byte could change (the agent's file, the step's copy before the probe's copy is
// made, and the step's copy after the probe ran), and the first check that sees it
// answers, before anything runs or is put beside the executable.
func TestEveryCopyOfTheBuildIsHeldToTheSignedDigestBeforeTheNextCopyIsMade(t *testing.T) {
	for name, c := range map[string]struct {
		point     string
		inStaging bool
		code      string
		probes    int
	}{
		"the agent's file, before it is copied":                        {"verified", false, "ARTIFACT_MISMATCH", 0},
		"the step's copy, before the probe's copy is made":             {"built", true, "PROBE_FAILED", 0},
		"the step's copy, after the probe ran and before it is staged": {"probed", true, "ARTIFACT_MISMATCH", 1},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			other := bytes.Clone(release.build)
			other[len(other)/2] ^= 0x01
			changed := false
			updateFault = func(point string) {
				if point != c.point || changed {
					return
				}
				changed = true
				if c.inStaging {
					if err := os.WriteFile(filepath.Join(f.paths.Staging, UpdateBuildFile(runtime.GOOS)), other, 0o600); err != nil {
						t.Error(err)
					}
					return
				}
				f.host.writeAsAccount(filepath.Join(f.incoming(release), UpdateBuildFile(runtime.GOOS)), other, f.clock.Now())
			}
			before := f.snapshot()
			f.mustRun()
			if !changed {
				t.Fatalf("the step never reached %s", c.point)
			}
			f.requireAnswered(release, outcomeOf(c.code, true), c.code)
			f.requireUnchanged(before)
			if len(f.host.probeCalls) != c.probes {
				t.Errorf("the probe ran %d times, want %d: %v", len(f.host.probeCalls), c.probes, f.host.probeCalls)
			}
		})
	}
}

func TestAForgedRequestCanOnlyNameWhatIsStagedAndSigned(t *testing.T) {
	t.Run("a request that is not a request", func(t *testing.T) {
		for name, data := range map[string]string{
			"text":                        "install me",
			"an object with unknown keys": `{"schema":"vectory.update-request.v1","mode":"auto"}`,
			"a digest in capitals":        `{"schema":"vectory.update-request.v1","manifest_sha256":"` + strings.ToUpper(digestOf([]byte("a"))) + `","artifact_sha256":"` + digestOf([]byte("b")) + `","rollout_id":"c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4","offered_at":"2026-10-04T01:58:10Z"}`,
			"a path in the digest":        `{"schema":"vectory.update-request.v1","manifest_sha256":"../../../etc","artifact_sha256":"` + digestOf([]byte("b")) + `","rollout_id":"c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4","offered_at":"2026-10-04T01:58:10Z"}`,
		} {
			f := newStepFixture(t)
			release := f.newRelease("0.1.1", "good", releaseOptions{})
			f.stage(release)
			f.host.writeAsAccount(UpdateExchangeFor(f.stateDir).Request, []byte(data), f.clock.Now())
			before := f.snapshot()
			f.mustRun()
			if f.status().Last != nil {
				t.Errorf("%s was answered: %+v", name, f.status().Last)
			}
			f.requireUnchanged(before)
		}
	})
	t.Run("a request for a manifest whose files are another release's", func(t *testing.T) {
		f := newStepFixture(t)
		genuine := f.newRelease("0.1.1", "good", releaseOptions{counter: 7})
		other := f.newRelease("0.1.2", "good", releaseOptions{counter: 8})
		f.stage(genuine)
		// The service account puts the other release's signed files where the
		// genuine manifest's digest says the genuine ones are.
		dir := f.incoming(genuine)
		f.host.writeAsAccount(filepath.Join(dir, UpdateReleaseFile), other.manifest, f.clock.Now())
		f.host.writeAsAccount(filepath.Join(dir, UpdateSignaturesFile), other.signature, f.clock.Now())
		before := f.snapshot()
		f.mustRun()
		f.requireAnswered(genuine, UpdateOutcomeRefused, "MANIFEST_INVALID")
		f.requireUnchanged(before)
	})
	t.Run("an unsigned build with a manifest and a signature of its own", func(t *testing.T) {
		f := newStepFixture(t)
		attacker := testPrivateKey(t, 99)
		attackerKey := testPublicKey(t, attacker, "attacker")
		release := f.newRelease("0.1.1", "good", releaseOptions{signer: &attacker, signerKey: &attackerKey})
		f.stage(release)
		before := f.snapshot()
		f.mustRun()
		f.requireAnswered(release, UpdateOutcomeRefused, "KEY_NOT_PINNED")
		f.requireUnchanged(before)
	})
	t.Run("the pins and the consent are not in the request", func(t *testing.T) {
		f := newStepFixture(t)
		f.setPolicy(func(p *UpdatePolicy) { p.Consent, p.Keys = UpdateConsentOff, nil })
		release := f.newRelease("0.1.1", "good", releaseOptions{})
		f.stage(release)
		before := f.snapshot()
		f.mustRun()
		f.requireAnswered(release, UpdateOutcomeRefused, "UPDATES_OFF")
		f.requireUnchanged(before)
	})
}

// ---------------------------------------------------------------- the executable changed

func TestAnExecutableReplacedByHandWhileARequestWaitedIsTakenAsTheRunningBuild(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.6", "good", releaseOptions{})
	f.stage(release)
	// Someone upgrades the agent by hand: the executable is another build than the
	// one the step recorded.
	f.installBuild(fakeBuild("0.1.5", "good", "by hand"))
	handDigest := f.executableDigest()
	history := len(f.service().History)
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeFailed, "BINARY_CHANGED")
	if f.executableDigest() != handDigest {
		t.Fatal("the step touched an executable it didn't install")
	}
	if record := f.installedRecord(); record.Version != "0.1.5" || record.SHA256 != handDigest || record.Release != "" {
		t.Errorf("the build the step takes as running: %+v", record)
	}
	if len(f.service().History) != history {
		t.Error("the service was touched")
	}
	if _, found := f.journal(); found {
		t.Error("a journal is left")
	}
	if f.counters().HighestCounters[f.public.Fingerprint()] != 0 {
		t.Error("a request that was dropped raised the floor")
	}
	// The next request starts from the build that runs.
	f.clock.advance(time.Minute)
	f.request(release.manifestSHA(), release.buildSHA(), f.clock.Now())
	f.mustRun()
	if f.executableDigest() != release.buildSHA() || f.status().Last.Outcome != UpdateOutcomeCommitted || f.status().Last.FromVersion != "0.1.5" {
		t.Errorf("an update after the executable was replaced by hand: %+v", f.status().Last)
	}
}

func TestAnExecutableReplacedAfterTheServiceStoppedIsLeftAloneAndTheServiceStartedAgain(t *testing.T) {
	f := newStepFixture(t)
	release := f.newRelease("0.1.6", "good", releaseOptions{})
	f.stage(release)
	handDigest := ""
	updateFault = func(point string) {
		if point == "stopped" {
			f.installBuild(fakeBuild("0.1.5", "good", "by hand"))
			handDigest = f.executableDigest()
		}
	}
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeFailed, "BINARY_CHANGED")
	if f.executableDigest() != handDigest || handDigest == "" {
		t.Fatalf("the executable is %s, want the file that was put there %s", f.executableDigest(), handDigest)
	}
	if got := strings.Join(f.service().History, ","); got != "start 0.1.0,stop,start 0.1.5" {
		t.Errorf("the service's history: %s", got)
	}
	if f.service().State != "active" {
		t.Error("the service was left stopped")
	}
	if beside := f.beside(); len(beside) != 1 || beside[0] != ".vectory-previous" {
		// The previous build was linked before the check that found the change? It
		// wasn't: nothing but the old link may be there.
		if len(beside) != 0 {
			t.Errorf("files beside the executable: %v", beside)
		}
	}
	// The floor was raised before the service stopped, and a dropped request keeps it.
	if f.counters().HighestCounters[f.public.Fingerprint()] != 7 {
		t.Error("the floor was lowered")
	}
	if got := f.installedRecord(); got.Version != "0.1.5" || got.SHA256 != handDigest {
		t.Errorf("installed.json: %+v", got)
	}
}

// ---------------------------------------------------------------- the key and its statements

func TestAnOfferSignedByTheSuccessorOfAPinnedKeyMovesThePinsOnlyWhenItCommits(t *testing.T) {
	f := newStepFixture(t)
	next := testPrivateKey(t, 31)
	nextKey := testPublicKey(t, next, "team-next")
	statement, err := SignRollover(f.private, nextKey, f.start.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	f.setPolicy(func(p *UpdatePolicy) { p.Windows = []string{"daily 00:00-23:59 UTC"}; p.Track = UpdateTrackMinor })
	release := f.newRelease("0.1.1", "good", releaseOptions{signer: &next, signerKey: &nextKey, rollovers: []RolloverEnvelope{statement}})
	f.stage(release)
	var pinsInTrial []string
	var floorsInTrial map[string]uint64
	updateFault = func(point string) {
		if point == "trial" {
			pinsInTrial = f.policy().Fingerprints()
			floorsInTrial = f.counters().HighestCounters
		}
	}
	f.mustRun()
	// During the trial the host still pins the old key, and the attempt is on disk
	// under it: if the build is taken back, the host is where it was.
	if len(pinsInTrial) != 1 || pinsInTrial[0] != f.public.Fingerprint() || floorsInTrial[f.public.Fingerprint()] != 7 || len(floorsInTrial) != 1 {
		t.Errorf("during the trial the pins were %v and the floors %v", pinsInTrial, floorsInTrial)
	}
	if f.status().Last.Outcome != UpdateOutcomeCommitted {
		t.Fatalf("the update: %+v", f.status().Last)
	}
	policy := f.policy()
	if got := policy.Fingerprints(); len(got) != 1 || got[0] != nextKey.Fingerprint() {
		t.Errorf("after the commit the host pins %v, want the successor %s", got, nextKey.Fingerprint())
	}
	if policy.Consent != UpdateConsentAuto || policy.Track != UpdateTrackMinor || len(policy.Windows) != 1 || policy.Paused {
		t.Errorf("the commit changed more than the pins: %+v", policy)
	}
	if floors := f.counters().HighestCounters; len(floors) != 1 || floors[nextKey.Fingerprint()] != 7 {
		t.Errorf("after the commit the floors are %v: the old key's floor moves to its successor", floors)
	}
	if got := f.status().HighestCounters; got[nextKey.Fingerprint()] != 7 || len(got) != 1 {
		t.Errorf("status.json reports %v", got)
	}
}

func TestARolledBackReleaseOfASuccessorKeyStaysTriedUnderTheKeyTheHostStillPins(t *testing.T) {
	f := newStepFixture(t)
	next := testPrivateKey(t, 31)
	nextKey := testPublicKey(t, next, "team-next")
	statement, err := SignRollover(f.private, nextKey, f.start.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	oldDigest := f.executableDigest()
	release := f.newRelease("0.1.2", "crash", releaseOptions{signer: &next, signerKey: &nextKey, rollovers: []RolloverEnvelope{statement}})
	f.stage(release)
	f.mustRun()
	f.requireTakenBack(oldDigest, release, "START_FAILED")
	if got := f.policy().Fingerprints(); len(got) != 1 || got[0] != f.public.Fingerprint() {
		t.Fatalf("a rollback moved the pins: %v", got)
	}
	if got := f.counters().HighestCounters; got[f.public.Fingerprint()] != 7 {
		t.Fatalf("the floor of the key the host still pins: %v", got)
	}
	history := len(f.service().History)
	// The server offers the same release again: the successor's floor is what the old
	// key's carries, and the host refuses it as tried.
	f.clock.advance(time.Hour)
	f.stage(release)
	f.request(release.manifestSHA(), release.buildSHA(), f.clock.Now())
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeRefused, "RELEASE_ALREADY_TRIED")
	if len(f.service().History) != history {
		t.Error("the service was touched again")
	}
}

func TestAnOldStatementFromAKeyTheHostAlreadyLeftIsIgnored(t *testing.T) {
	f := newStepFixture(t)
	next := testPrivateKey(t, 31)
	nextKey := testPublicKey(t, next, "team-next")
	statement, err := SignRollover(f.private, nextKey, f.start.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	// The host already followed the statement: it pins the successor only.
	f.setPolicy(func(p *UpdatePolicy) { p.Keys = []PinnedKey{{Key: nextKey, PinnedAt: f.start}} })
	release := f.newRelease("0.1.1", "good", releaseOptions{signer: &next, signerKey: &nextKey, rollovers: []RolloverEnvelope{statement}})
	f.stage(release)
	f.mustRun()
	if f.status().Last.Outcome != UpdateOutcomeCommitted || f.status().RolloverConflict != nil {
		t.Fatalf("a statement relayed by a server froze or refused the host: %+v", f.status().Last)
	}
	if got := f.policy().Fingerprints(); len(got) != 1 || got[0] != nextKey.Fingerprint() {
		t.Errorf("the pins: %v", got)
	}
}

func TestAForkFreezesTheHostUntilItIsPinnedAgain(t *testing.T) {
	f := newStepFixture(t)
	b := testPrivateKey(t, 31)
	c := testPrivateKey(t, 32)
	keyB, keyC := testPublicKey(t, b, "b"), testPublicKey(t, c, "c")
	toB, err := SignRollover(f.private, keyB, f.start.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	toC, err := SignRollover(f.private, keyC, f.start.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	release := f.newRelease("0.1.1", "good", releaseOptions{signer: &b, signerKey: &keyB, rollovers: []RolloverEnvelope{toB, toC}})
	f.stage(release)
	before := f.snapshot()
	f.mustRun()
	f.requireAnswered(release, UpdateOutcomeRefused, "KEY_ROLLOVER_CONFLICT")
	f.requireUnchanged(before, "counters")
	conflict := f.counters().RolloverConflict
	successors := []string{keyB.Fingerprint(), keyC.Fingerprint()}
	if successors[0] > successors[1] {
		successors[0], successors[1] = successors[1], successors[0]
	}
	if conflict == nil || conflict.From != f.public.Fingerprint() || conflict.To[0] != successors[0] || conflict.To[1] != successors[1] {
		t.Fatalf("the fork the step recorded: %+v", conflict)
	}
	if got := f.status().RolloverConflict; got == nil || *got != *conflict {
		t.Errorf("status.json says %+v", got)
	}

	// A good release, signed by the key the host pins, is refused now too: the host
	// is frozen until a person pins it again.
	f.clock.advance(time.Hour)
	good := f.newRelease("0.1.2", "good", releaseOptions{counter: 9})
	f.stage(good)
	f.mustRun()
	f.requireAnswered(good, UpdateOutcomeRefused, "KEY_ROLLOVER_CONFLICT")
	if f.executableDigest() != before.executable {
		t.Fatal("a frozen host took an update")
	}

	// Pinned again to another key, the fork no longer concerns a key the host pins.
	other := testPrivateKey(t, 40)
	otherKey := testPublicKey(t, other, "recovery")
	f.setPolicy(func(p *UpdatePolicy) { p.Keys = []PinnedKey{{Key: otherKey, PinnedAt: f.clock.Now()}} })
	f.clock.advance(time.Hour)
	again := f.newRelease("0.1.2", "good", releaseOptions{counter: 9, signer: &other, signerKey: &otherKey})
	f.stage(again)
	f.mustRun()
	if f.status().Last.Outcome != UpdateOutcomeCommitted || f.status().RolloverConflict != nil || f.counters().RolloverConflict != nil {
		t.Fatalf("a host pinned again after a fork: %+v", f.status().Last)
	}
}

// ---------------------------------------------------------------- the files themselves

func TestACopyThatTheSourceDoesNotFillOrOverfillsIsRefusedAndLeavesNothing(t *testing.T) {
	f := newStepFixture(t)
	dir, err := ensureRootOwnedDir(filepath.Join(f.root, "scratch"), rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	host := unixUpdateHost{}
	for name, c := range map[string]struct {
		content string
		size    int64
	}{"shorter than it said": {"abc", 10}, "longer than it said": {"abcdefghijkl", 10}} {
		if _, err := host.CopyInto(dir, "copy", rootPrivate, strings.NewReader(c.content), c.size); err == nil {
			t.Errorf("%s was copied", name)
		}
		if _, err := os.Stat(filepath.Join(dir.Path(), "copy")); err == nil {
			t.Errorf("%s left a file", name)
		}
	}
	digest, err := host.CopyInto(dir, "copy", rootPrivate, strings.NewReader("abcdefghij"), 10)
	if err != nil || digest != digestOf([]byte("abcdefghij")) {
		t.Fatalf("a copy of exactly its size: %s, %v", digest, err)
	}
	if _, err := host.CopyInto(dir, "copy", rootPrivate, bytes.NewReader([]byte("again")), 5); err == nil {
		t.Error("a copy replaced a file that was there")
	}
	if info, err := os.Stat(filepath.Join(dir.Path(), "copy")); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("the copy: %v, %v", info, err)
	}
}

// replacingReader runs replace once, when the source is exhausted: the moment a
// copy has been written and not yet read back.
type replacingReader struct {
	io.Reader
	replace func()
	done    bool
}

func (r *replacingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err == io.EOF && !r.done {
		r.done = true
		r.replace()
	}
	return n, err
}

func TestACopyWhoseNameIsReplacedBeforeItIsReadBackIsNotBelieved(t *testing.T) {
	f := newStepFixture(t)
	dir, err := ensureRootOwnedDir(filepath.Join(f.root, "scratch"), rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	// The file that takes the name has the same bytes, so that only the check that the
	// name still refers to the file that was written can tell.
	other := filepath.Join(dir.Path(), "other")
	if err := os.WriteFile(other, []byte("abcdefghij"), 0o600); err != nil {
		t.Fatal(err)
	}
	source := &replacingReader{Reader: strings.NewReader("abcdefghij"), replace: func() {
		if err := os.Rename(other, filepath.Join(dir.Path(), "copy")); err != nil {
			t.Error(err)
		}
	}}
	if digest, err := (unixUpdateHost{}).CopyInto(dir, "copy", rootPrivate, source, 10); err == nil {
		t.Errorf("a copy whose name was replaced was believed: %s", digest)
	}
}
