package agent

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestChangeUpdatePolicyEditsWhatIsThereAndKeepsTheRest(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC), nil); err != nil {
		t.Fatal(err)
	}
	before, err := ReadUpdatePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Paused = true; return nil }); err != nil {
		t.Fatal(err)
	}
	after, err := ReadUpdatePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if !after.Paused || after.Consent != before.Consent || after.Track != before.Track || len(after.Windows) != 1 || after.Windows[0] != before.Windows[0] ||
		len(after.Keys) != 1 || after.Keys[0].Key.Fingerprint() != teamFingerprint || !after.Keys[0].PinnedAt.Equal(before.Keys[0].PinnedAt) {
		t.Errorf("before %+v, after %+v", before, after)
	}
	if after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Error("an edit didn't update updated_at")
	}
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Paused = false; return nil }); err != nil {
		t.Fatal(err)
	}
	if again, err := ReadUpdatePolicy(); err != nil || again.Paused {
		t.Errorf("resumed: %+v, %v", again, err)
	}
}

func TestChangeUpdatePolicyOnAHostWithNoPolicyEditsTheDefault(t *testing.T) {
	requireRootOwnedWriter(t)
	useUpdateRoots(t)
	err := ChangeUpdatePolicy(func(p *UpdatePolicy) error {
		if p.Consent != UpdateConsentOff {
			t.Errorf("the default policy to edit is %+v", *p)
		}
		p.Consent = UpdateConsentAsk
		p.Keys = []PinnedKey{{Key: testKey(t, teamKeyLine)}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := ReadUpdatePolicy(); err != nil || got.Consent != UpdateConsentAsk || len(got.Keys) != 1 {
		t.Errorf("%+v, %v", got, err)
	}
}

// Two writers must not undo each other: a person's `off` and the step's pins.
func TestChangeUpdatePolicyRepeatsAnEditThatAnotherWriterOverlapped(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	calls := 0
	err := ChangeUpdatePolicy(func(p *UpdatePolicy) error {
		calls++
		if calls == 1 {
			// Another writer replaces the policy after this one read it.
			other := samplePolicy(t)
			other.Track = UpdateTrackMinor
			if err := writeUpdatePolicy(paths, other, time.Now(), nil); err != nil {
				t.Fatal(err)
			}
		}
		p.Paused = true
		return nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("%d calls, %v", calls, err)
	}
	got, err := ReadUpdatePolicy()
	if err != nil || !got.Paused || got.Track != UpdateTrackMinor {
		t.Errorf("both writers' changes should be there: %+v, %v", got, err)
	}

	// A policy that never stops changing is given up on, and the other writer's last version stays.
	calls = 0
	err = ChangeUpdatePolicy(func(p *UpdatePolicy) error {
		calls++
		other := samplePolicy(t)
		other.Windows = []string{fmt.Sprintf("daily 0%d:00-0%d:30", calls, calls)}
		if err := writeUpdatePolicy(paths, other, time.Now(), nil); err != nil {
			t.Fatal(err)
		}
		p.Consent = UpdateConsentOff
		return nil
	})
	if !errors.Is(err, ErrUpdatePolicyChanged) || calls != changeAttempts {
		t.Errorf("%d calls, %v", calls, err)
	}
	if got, err := ReadUpdatePolicy(); err != nil || got.Consent != UpdateConsentAuto || got.Windows[0] != "daily 04:00-04:30" {
		t.Errorf("the other writer's last version should stay: %+v, %v", got, err)
	}
}

func TestChangeUpdatePolicyWritesNothingWhenTheEditFailsOrThePolicyIsNotReadable(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(paths.Policy)
	boom := errors.New("not this edit")
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Paused = true; return boom }); err != boom {
		t.Errorf("an edit that fails: %v", err)
	}
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Consent = "on"; return nil }); !errors.Is(err, ErrUpdatePolicyInvalid) {
		t.Errorf("an edit that makes the policy invalid: %v", err)
	}
	if after, _ := os.ReadFile(paths.Policy); !bytes.Equal(before, after) {
		t.Error("an edit that failed changed the policy")
	}
	// A policy that can't be read is not edited from.
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := dir.WriteFile("policy.json", []byte("not a policy"), rootReadable); err != nil {
		t.Fatal(err)
	}
	called := false
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { called = true; return nil }); !errors.Is(err, ErrUpdatePolicyInvalid) || called {
		t.Errorf("an invalid policy: %v (edited: %v)", err, called)
	}
}

func TestAPolicyIsWrittenOverOnlyTheFileItWasReadFrom(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	now := time.Now()
	stale := "not the digest of the file"
	if err := writeUpdatePolicy(paths, samplePolicy(t), now, &stale); !errors.Is(err, ErrUpdatePolicyChanged) {
		t.Errorf("a policy that was never written, over a basis that names a file: %v", err)
	}
	if _, err := os.Stat(paths.Policy); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a refused write made the file: %v", err)
	}
	none := ""
	if err := writeUpdatePolicy(paths, samplePolicy(t), now, &none); err != nil {
		t.Fatalf("a first policy over no file: %v", err)
	}
	if err := writeUpdatePolicy(paths, samplePolicy(t), now, &none); !errors.Is(err, ErrUpdatePolicyChanged) {
		t.Errorf("a basis of no file over a file: %v", err)
	}
	_, basis, err := readUpdatePolicy(paths)
	if err != nil || basis == "" {
		t.Fatalf("%q, %v", basis, err)
	}
	if err := writeUpdatePolicy(paths, samplePolicy(t), now, &basis); err != nil {
		t.Errorf("a write over the file it was read from: %v", err)
	}
}

func TestOnlyRootChangesThePolicy(t *testing.T) {
	if os.Geteuid() == 0 || runtime.GOOS == "windows" {
		t.Skip("this test runs as an account that isn't root")
	}
	called := false
	err := ChangeUpdatePolicy(func(*UpdatePolicy) error { called = true; return nil })
	if err == nil || !strings.Contains(err.Error(), "root") || called {
		t.Errorf("a policy changed without root: %v (called %v)", err, called)
	}
}
