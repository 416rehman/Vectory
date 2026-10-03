package agent

import (
	"errors"
	"fmt"
	"os"
	"testing"
)

// On Windows the agent's state directory is kept in a directory under ProgramData
// that another account may have made first (state_root.go). Setup looks at it before it
// reads or changes anything, in a dry run too, and makes or closes it as the first thing
// it changes. What the look says is the host's to say (the fixture's host replaces it);
// that setup asks at these two moments, and stops at the first, is what these tests hold.

// Another account's directory is refused by name, before anything is read or changed,
// whether or not setup was asked to apply: a dry run that said "would create" and a
// run that then failed would be a plan that lied.
func TestSetupRefusesAStateRootThatAnotherAccountOwnsBeforeItChangesAnything(t *testing.T) {
	for _, dryRun := range []bool{true, false} {
		t.Run(fmt.Sprintf("dry run %v", dryRun), func(t *testing.T) {
			f := newConsentFixture(t)
			refusal := &stateRootError{Path: stateRootPath, Owner: `PC\alice`}
			var calls []bool
			f.host.stateRoot = func(dir string, change bool) error {
				if dir != f.dir {
					t.Errorf("setup looked at %q, and the state directory is %q", dir, f.dir)
				}
				calls = append(calls, change)
				return refusal
			}
			f.options.DryRun = dryRun
			result, err := f.run()
			var failed *SetupError
			if !errors.As(err, &failed) {
				t.Fatalf("%v\n%s", err, serviceDetail(result))
			}
			detail, fix := refusal.words()
			if step := failed.Step; step.ID != "paths" || step.Label != "Paths" || step.Status != "fail" || step.Detail != detail || step.Fix != fix {
				t.Fatalf("the step: %+v, want detail %q and fix %q", step, detail, fix)
			}
			if len(calls) != 1 || calls[0] {
				t.Errorf("setup asked %v: it looks once, changes nothing, and stops", calls)
			}
			f.untouched()
		})
	}
}

// Setup looks first, and makes the directory closed (or closes it) as the first thing
// it changes: before the token is asked for, the state directory is made, the service
// account exists or anything is enrolled or registered.
func TestSetupLooksAtTheStateRootFirstAndMakesItBeforeAnythingElseChanges(t *testing.T) {
	f := newConsentFixture(t)
	var calls []bool
	f.host.stateRoot = func(dir string, change bool) error {
		if change {
			if _, err := os.Lstat(dir); !os.IsNotExist(err) {
				t.Errorf("the state directory was there when setup made the directory above it: %v", err)
			}
			if len(f.events) != 0 || f.server.enrolls.Load() != 0 || f.tokens != 0 {
				t.Errorf("something had changed already: events %v, enrollments %d, tokens %d", f.events, f.server.enrolls.Load(), f.tokens)
			}
		}
		calls = append(calls, change)
		return nil
	}
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if fmt.Sprint(calls) != "[false true]" {
		t.Errorf("setup asked %v, want a look and then the change", calls)
	}
	if f.tokens != 1 {
		t.Errorf("the token was asked for %d times", f.tokens)
	}
}

// An installation that is already there is upgraded by the same command, and the
// directory above its state directory is judged and closed then too.
func TestSetupMakesTheStateRootOnAnUpgradeToo(t *testing.T) {
	f := newConsentFixture(t)
	if result, err := f.run(); err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	var calls []bool
	f.host.stateRoot = func(dir string, change bool) error {
		calls = append(calls, change)
		return nil
	}
	if result, err := f.run(); err != nil || !result.OK {
		t.Fatalf("the second run: %v\n%s", err, serviceDetail(result))
	}
	if fmt.Sprint(calls) != "[false true]" {
		t.Errorf("an upgrade asked %v, want a look and then the change", calls)
	}
}

// A refusal that comes from the change, which is the look made again for a host that
// changed in between, is told the same way.
func TestSetupTellsARefusalOfTheChangeAsItTellsTheFirstLook(t *testing.T) {
	f := newConsentFixture(t)
	refusal := &stateRootError{Path: stateRootPath, Owner: `PC\alice`}
	f.host.stateRoot = func(dir string, change bool) error {
		if change {
			return fmt.Errorf("making the state directory: %w", refusal)
		}
		return nil
	}
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) {
		t.Fatal(err)
	}
	detail, fix := refusal.words()
	if step := failed.Step; step.ID != "paths" || step.Detail != detail || step.Fix != fix {
		t.Fatalf("the step: %+v", step)
	}
	if f.tokens != 0 || f.server.enrolls.Load() != 0 {
		t.Errorf("tokens %d, enrollments %d: nothing should have been asked or enrolled", f.tokens, f.server.enrolls.Load())
	}
}
