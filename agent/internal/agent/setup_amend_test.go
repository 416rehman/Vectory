package agent

import (
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Update flags without --updates amend what a host already agreed to. They change
// the parts they name in the policy the host has, and keep the rest: the level,
// the parts they don't name, a person's pause. A host that agreed to nothing has
// nothing to amend, and setup refuses it before it changes anything.

// agreed sets up a host that took updates on its own terms: it asks before it
// applies (unless level says otherwise), takes the track given, starts an update
// only inside the windows given, pins the team's key, and a person has paused
// updates on it. The command carries no update flag afterwards; each test adds
// the flags it amends with.
func (f *consentFixture) agreed(level, track string, windows ...string) {
	f.t.Helper()
	f.consent(level, f.key)
	f.options.UpdateTrack, f.options.UpdateWindows = track, windows
	if result, err := f.run(); err != nil || !result.OK {
		f.t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Paused = true; return nil }); err != nil {
		f.t.Fatal(err)
	}
	f.options.Token = func() (string, error) { f.t.Fatal("an enrolled host asked for a token"); return "", nil }
	f.options.Updates, f.options.UpdateKeys, f.options.UpdateTrack, f.options.UpdateWindows = "", nil, "", nil
	f.events, f.manager.actions = nil, nil
}

// policyMembers is the members of policy.json, each as the bytes it is written in.
func policyMembers(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil {
		t.Fatalf("%v: %s", err, raw)
	}
	out := make(map[string]string, len(members))
	for name, value := range members {
		out[name] = string(value)
	}
	return out
}

// keepsMembers fails the test unless every member of the policy that the amendment
// doesn't name is, byte for byte, what it was.
func keepsMembers(t *testing.T, before, after map[string]string, changed ...string) {
	t.Helper()
	for _, name := range []string{"schema", "consent", "track", "windows", "paused", "keys"} {
		if slices.Contains(changed, name) {
			if before[name] == after[name] {
				t.Errorf("%s was meant to change and is still %s", name, after[name])
			}
			continue
		}
		if before[name] != after[name] {
			t.Errorf("%s changed from %s to %s", name, before[name], after[name])
		}
	}
}

// amending makes the command carry the update flags a test names and no --updates.
func (f *consentFixture) amending(track string, windows []string, keys ...ReleaseKey) {
	f.options.Updates, f.options.UpdateTrack, f.options.UpdateWindows = "", track, windows
	f.options.UpdateKeys = nil
	for _, key := range keys {
		f.options.UpdateKeys = append(f.options.UpdateKeys, key.Fingerprint())
	}
}

func (f *consentFixture) policyFile() []byte {
	f.t.Helper()
	raw, err := os.ReadFile(f.paths.Policy)
	if err != nil {
		f.t.Fatal(err)
	}
	return raw
}

// unchanged fails the test unless a refused amendment left the host as it was:
// the same policy file, no call to the update step or the service, and nothing
// but the read-only checks a refusal comes after.
func (f *consentFixture) unchanged(policy []byte) {
	f.t.Helper()
	if now := f.policyFile(); string(now) != string(policy) {
		f.t.Errorf("the policy changed:\n%s\n%s", policy, now)
	}
	for _, event := range f.events {
		if event != "eligibility" {
			f.t.Errorf("setup reached for %q before it refused", event)
		}
	}
	for _, action := range f.manager.actions {
		if action != "check" {
			f.t.Errorf("the service was asked to %q", action)
		}
	}
}

func (f *consentFixture) stepInstalls() int {
	count := 0
	for _, event := range f.events {
		if event == "install-step" {
			count++
		}
	}
	return count
}

func TestSetupWithATrackAloneChangesOnlyTheTrack(t *testing.T) {
	for name, tc := range map[string]struct{ from, to string }{
		"minor to patch": {UpdateTrackMinor, UpdateTrackPatch},
		"patch to minor": {UpdateTrackPatch, UpdateTrackMinor},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConsentFixture(t)
			f.agreed(UpdateConsentAsk, tc.from, "Mon-Fri 02:00-04:00")
			before := policyMembers(t, f.paths.Policy)
			requests := f.server.keyRequests.Load()
			f.amending(tc.to, nil)
			if err := f.options.CheckUpdates(); err != nil {
				t.Fatalf("a host that agreed can be amended: %v", err)
			}
			result, err := f.run()
			if err != nil || !result.OK {
				t.Fatalf("%v\n%s", err, serviceDetail(result))
			}
			keepsMembers(t, before, policyMembers(t, f.paths.Policy), "track")
			policy, err := ReadUpdatePolicy()
			if err != nil || policy.Track != tc.to || policy.Consent != UpdateConsentAsk || !policy.Paused || len(policy.Windows) != 1 {
				t.Fatalf("%+v %v", policy, err)
			}
			want := "ask on this host · " + UpdateTrackWords(tc.to) + " · Mon–Fri 02:00–04:00 · key " + f.key.ShortID() + " (pinned) · changed: track · paused on this host: " + asAdmin("vectory update resume") + " --state-dir " + ShellQuote(f.dir)
			if step := lastUpdatesStep(t, result); step.Detail != want || step.Status != "ok" {
				t.Fatalf("%+v want %q", step, want)
			}
			// What is now in force, in the JSON result.
			if got := result.Updates; got == nil || got.Consent != UpdateConsentAsk || got.Track != tc.to || !got.Paused || len(got.Windows) != 1 || len(got.Keys) != 1 || got.Keys[0] != f.key.Fingerprint() {
				t.Fatalf("%+v", got)
			}
			// A track needs nothing from the server, and the step is looked after as
			// when consent was given.
			if f.server.keyRequests.Load() != requests {
				t.Fatal("setup asked the server for its keys to change a track")
			}
			if f.stepInstalls() != 1 {
				t.Fatalf("%v", f.events)
			}
			// The service is already registered here, and the step is installed before the
			// service is restarted, so no restart can race it.
			if got := strings.Join(f.events, ","); got != "eligibility,service-register,install-step,service-restart" {
				t.Fatalf("%s", got)
			}
		})
	}
}

func TestSetupWithWindowsAloneReplacesOnlyTheWindows(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAuto, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
	before := policyMembers(t, f.paths.Policy)
	f.amending("", []string{"Sat,Sun 01:00-03:00 UTC", "daily 23:00-23:30"})
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	keepsMembers(t, before, policyMembers(t, f.paths.Policy), "windows")
	policy, _ := ReadUpdatePolicy()
	if got := policy.Windows; len(got) != 2 || got[0] != "Sat,Sun 01:00-03:00 UTC" || got[1] != "daily 23:00-23:30" {
		t.Fatalf("the windows are replaced, not added to: %v", got)
	}
	if want := "automatic · minor and patch releases · Sat,Sun 01:00–03:00 UTC, daily 23:00–23:30 · key " + f.key.ShortID() + " (pinned) · changed: windows"; !strings.HasPrefix(lastUpdatesStep(t, result).Detail, want) {
		t.Fatalf("%q want %q", lastUpdatesStep(t, result).Detail, want)
	}
}

// A key alone re-pins: the pinned keys become exactly the keys given, found in
// the server's list by the fingerprint setup computes. The level, the track, the
// windows and a person's pause stay as they were, byte for byte.
func TestSetupWithAKeyAloneRepinsAndKeepsEverythingElseByteForByte(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAuto, UpdateTrackMinor, "Mon-Fri 02:00-04:00", "Sat,Sun 01:00-03:00 UTC")
	before := policyMembers(t, f.paths.Policy)
	next := testReleaseKey(t, "team-next")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "retired"}, BundleKey{Key: next, State: "current"})
	requests := f.server.keyRequests.Load()
	f.amending("", nil, next)
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	after := policyMembers(t, f.paths.Policy)
	keepsMembers(t, before, after, "keys")
	policy, err := ReadUpdatePolicy()
	if err != nil || len(policy.Keys) != 1 || policy.Keys[0].Key.Line() != next.Line() {
		t.Fatalf("the pinned keys are exactly the keys given: %+v %v", policy.Keys, err)
	}
	if want := "automatic · minor and patch releases · Mon–Fri 02:00–04:00, Sat,Sun 01:00–03:00 UTC · key " + next.ShortID() + " (pinned) · changed: pinned keys · paused on this host: " + asAdmin("vectory update resume") + " --state-dir " + ShellQuote(f.dir); lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q want %q", lastUpdatesStep(t, result).Detail, want)
	}
	if got := result.Updates; got == nil || len(got.Keys) != 1 || got.Keys[0] != next.Fingerprint() || got.Consent != UpdateConsentAuto || got.Track != UpdateTrackMinor || !got.Paused {
		t.Fatalf("%+v", got)
	}
	// The key came from the server's list over the connection setup trusts, with
	// no token and no certificate; the update step is installed (if missing).
	if f.server.keyRequests.Load() != requests+1 || f.server.keyRequestCerts.Load() != 0 || f.stepInstalls() != 1 {
		t.Fatalf("%d requests for the list, %d with a certificate, events %v", f.server.keyRequests.Load()-requests, f.server.keyRequestCerts.Load(), f.events)
	}
}

// Keys that stay pinned keep the time they were pinned; keys given in another
// order are pinned in that order; at most four.
func TestSetupWithKeysAloneKeepsWhenAKeyThatStaysWasPinned(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackPatch)
	first, _ := ReadUpdatePolicy()
	second := testReleaseKey(t, "team-next")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "current"}, BundleKey{Key: second, State: "current"})
	time.Sleep(1100 * time.Millisecond)
	f.amending("", nil, second, f.key)
	if result, err := f.run(); err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	again, _ := ReadUpdatePolicy()
	if got := again.Fingerprints(); len(got) != 2 || got[0] != second.Fingerprint() || got[1] != f.key.Fingerprint() {
		t.Fatalf("%v", got)
	}
	if !again.Keys[1].PinnedAt.Equal(first.Keys[0].PinnedAt) || !again.Keys[0].PinnedAt.After(first.Keys[0].PinnedAt) {
		t.Fatalf("pinned at %v and %v, the key that stayed was pinned at %v", again.Keys[0].PinnedAt, again.Keys[1].PinnedAt, first.Keys[0].PinnedAt)
	}
}

// Any combination applies the parts given and keeps the rest.
func TestSetupWithAnyCombinationOfUpdateFlagsAppliesTheOnesGiven(t *testing.T) {
	next := func(f *consentFixture) ReleaseKey {
		key := testReleaseKey(t, "team-next")
		f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "retired"}, BundleKey{Key: key, State: "current"})
		return key
	}
	for name, tc := range map[string]struct {
		track   string
		windows []string
		key     bool
		changed []string
		parts   string
	}{
		"a key and a track":                {track: "patch", key: true, changed: []string{"track", "keys"}, parts: "pinned keys and track"},
		"a key and windows":                {windows: []string{"daily 01:00-03:00"}, key: true, changed: []string{"windows", "keys"}, parts: "pinned keys and windows"},
		"a track and windows":              {track: "patch", windows: []string{"daily 01:00-03:00"}, changed: []string{"track", "windows"}, parts: "track and windows"},
		"a key, a track and windows":       {track: "patch", windows: []string{"daily 01:00-03:00"}, key: true, changed: []string{"track", "windows", "keys"}, parts: "pinned keys, track and windows"},
		"a track that is the track it was": {track: "minor", windows: []string{"daily 01:00-03:00"}, changed: []string{"windows"}, parts: "windows"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConsentFixture(t)
			f.agreed(UpdateConsentAsk, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
			before := policyMembers(t, f.paths.Policy)
			var keys []ReleaseKey
			if tc.key {
				keys = append(keys, next(f))
			}
			f.amending(tc.track, tc.windows, keys...)
			result, err := f.run()
			if err != nil || !result.OK {
				t.Fatalf("%v\n%s", err, serviceDetail(result))
			}
			keepsMembers(t, before, policyMembers(t, f.paths.Policy), tc.changed...)
			if want := " · changed: " + tc.parts; !strings.Contains(lastUpdatesStep(t, result).Detail, want) {
				t.Fatalf("%q lacks %q", lastUpdatesStep(t, result).Detail, want)
			}
			policy, _ := ReadUpdatePolicy()
			if policy.Consent != UpdateConsentAsk || !policy.Paused {
				t.Fatalf("the level and the pause stay: %+v", policy)
			}
		})
	}
}

// With a level the command is the whole consent, as it always was: the flags it
// leaves out take their defaults, and only a pause is kept.
func TestSetupWithALevelStillGivesTheWholeConsent(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
	f.consent(UpdateConsentAuto, f.key)
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	policy, _ := ReadUpdatePolicy()
	if policy.Consent != UpdateConsentAuto || policy.Track != UpdateTrackPatch || len(policy.Windows) != 0 || !policy.Paused {
		t.Fatalf("%+v", policy)
	}
	if want := "automatic · patch releases · any time · key " + f.key.ShortID() + " (pinned) · paused on this host: " + asAdmin("vectory update resume") + " --state-dir " + ShellQuote(f.dir); lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q want %q", lastUpdatesStep(t, result).Detail, want)
	}
}

// A command with no update flag leaves what the host agreed to exactly as it is.
func TestSetupWithoutUpdateFlagsLeavesWhatAHostAgreedTo(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
	before, requests := f.policyFile(), f.server.keyRequests.Load()
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if string(f.policyFile()) != string(before) || f.server.keyRequests.Load() != requests || result.Updates != nil || stepStatus(result, "updates") != "" || f.stepInstalls() != 0 {
		t.Fatalf("updates were touched: %v %v", f.events, result.Steps)
	}
	for _, event := range f.events {
		if event == "remove-step" || event == "install-step" {
			t.Fatalf("%v", f.events)
		}
	}
}

// ---------------------------------------------------------------- refusals

// A host that agreed to nothing has nothing to amend: setup refuses before it
// changes anything, with the usage exit code (the command's check) and as a failed
// Updates step (setup itself). Each message says what to add to give consent.
func TestSetupWithUpdateFlagsRefusesAHostThatAgreedToNothing(t *testing.T) {
	const hint = "Add --updates auto or --updates ask, with --update-key-sha256"
	for name, tc := range map[string]struct {
		// setUp says the host was set up before, with consent that this case ends.
		setUp bool
		// prepare gets the test of its own case.
		prepare func(t *testing.T, f *consentFixture)
		want    string
	}{
		"no policy": {
			want: "This host hasn't agreed to agent updates, so there is nothing to change. " + hint + ".",
		},
		"consent off": {
			setUp: true,
			prepare: func(t *testing.T, f *consentFixture) {
				if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Consent = UpdateConsentOff; return nil }); err != nil {
					t.Fatal(err)
				}
			},
			want: "This host hasn't agreed to agent updates, so there is nothing to change. " + hint + ".",
		},
		"a policy that can't be used": {
			prepare: func(t *testing.T, f *consentFixture) {
				dir, err := ensureRootOwnedDir(f.paths.PolicyDir, rootReadable)
				if err != nil {
					t.Fatal(err)
				}
				defer dir.Close()
				if err := dir.WriteFile(updatePolicyFile, []byte(`{"schema":"vectory.update-policy.v1","consent":"yes","track":"patch","windows":[],"paused":false,"keys":[],"updated_at":"2026-10-03T12:00:00Z"}`), rootReadable); err != nil {
					t.Fatal(err)
				}
			},
			want: `The update policy on this host can't be used (consent "yes" isn't off, auto or ask), so there is nothing to change. ` + hint + ", to write it again.",
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConsentFixture(t)
			if tc.setUp {
				f.agreed(UpdateConsentAuto, UpdateTrackPatch)
			}
			if tc.prepare != nil {
				tc.prepare(t, f)
			}
			policy, readErr := os.ReadFile(f.paths.Policy)
			requests, tokens := f.server.keyRequests.Load(), f.tokens
			f.amending(UpdateTrackMinor, []string{"daily 01:00-03:00"}, f.key)
			if err := f.options.CheckUpdates(); err == nil || !IsInputError(err) || err.Error() != tc.want {
				t.Fatalf("the command's check: %v, want the input error %q", err, tc.want)
			}
			for _, dry := range []bool{false, true} {
				f.options.DryRun = dry
				f.events = nil
				result, err := f.run()
				var failed *SetupError
				if !errors.As(err, &failed) || failed.Step.ID != "updates" || failed.Step.Detail != tc.want || failed.Step.Fix != "" || result.OK || len(result.Steps) != 1 {
					t.Fatalf("dry run %v: %v\n%s", dry, err, serviceDetail(result))
				}
				// Nothing was looked at, asked of the server, enrolled, installed or written.
				if len(f.events) != 0 || len(f.manager.actions) != 0 || f.server.keyRequests.Load() != requests || f.tokens != tokens {
					t.Fatalf("setup went on: %v %v, %d tokens", f.events, f.manager.actions, f.tokens-tokens)
				}
				if readErr == nil {
					f.unchanged(policy)
				}
			}
			if !tc.setUp && Installed(f.dir) {
				t.Fatal("the host was set up")
			}
		})
	}
}

func TestSetupWithUpdateFlagsRefusesAPolicyAnyoneCouldReplace(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAuto, UpdateTrackPatch)
	if err := os.Chmod(f.paths.PolicyDir, 0o777); err != nil {
		t.Fatal(err)
	}
	f.amending(UpdateTrackMinor, nil)
	policy := f.policyFile()
	err := f.options.CheckUpdates()
	if err == nil || !IsInputError(err) || !strings.HasPrefix(err.Error(), "The update policy on this host can't be read safely (") || !strings.Contains(err.Error(), f.paths.PolicyDir) ||
		!strings.HasSuffix(err.Error(), "), so there is nothing to change. Make it, and every directory above it, writable by "+updateRootWord()+" alone, then run the command again.") {
		t.Fatalf("%v", err)
	}
	result, runErr := f.run()
	var failed *SetupError
	if !errors.As(runErr, &failed) || failed.Step.ID != "updates" || failed.Step.Detail != err.Error() || len(result.Steps) != 1 {
		t.Fatalf("%v\n%s", runErr, serviceDetail(result))
	}
	if string(f.policyFile()) != string(policy) || len(f.events) != 0 {
		t.Fatalf("setup changed something: %v", f.events)
	}
}

// A key the server doesn't offer, or a list that lies, pins nothing: the policy,
// the update step and the service stay as they were.
func TestSetupWithAKeyTheServerDoesntOfferChangesNothing(t *testing.T) {
	stranger := testReleaseKey(t, "stranger")
	for name, tc := range map[string]struct {
		// list is what the server answers for its keys, made by the test of its own case.
		list func(t *testing.T, f *consentFixture) []byte
		want string
		fix  string
	}{
		"a list of other keys": {
			list: func(t *testing.T, f *consentFixture) []byte {
				return releaseKeyList(t, BundleKey{Key: f.key, State: "current"})
			},
			want: "The server offers no release key with the fingerprint this command pins:\nexpected " + GroupFingerprint(stranger.Fingerprint()) + "\noffered  ",
			fix:  "Compare it with the key in Settings → Agent updates, and copy the command again from Add device. If it still doesn't match, this address may lead to a different server; don't continue.",
		},
		"an empty list": {
			list: func(t *testing.T, f *consentFixture) []byte { return releaseKeyList(t) },
			want: "The server offers no release key with the fingerprint this command pins:\nexpected " + GroupFingerprint(stranger.Fingerprint()) + "\nThe server's list of release keys is empty.",
			fix:  "Compare it with the key in Settings → Agent updates, and copy the command again from Add device. If it still doesn't match, this address may lead to a different server; don't continue.",
		},
		"a list whose fingerprint member lies": {
			list: func(t *testing.T, f *consentFixture) []byte {
				list := releaseKeyList(t, BundleKey{Key: f.key, State: "current"})
				return []byte(strings.ReplaceAll(string(list), f.key.Fingerprint(), stranger.Fingerprint()))
			},
			want: "The server's list of release keys is invalid (RELEASE_KEY_INVALID): the fingerprint of key 1 isn't the fingerprint of its key",
			fix:  bundleFix,
		},
		"a server with updates off": {
			list: func(t *testing.T, f *consentFixture) []byte { return nil },
			want: "This server doesn't offer agent updates.",
			fix:  "Turn them on in Settings → Agent updates, or leave out the update flags.",
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConsentFixture(t)
			f.agreed(UpdateConsentAuto, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
			f.server.releaseKeys = tc.list(t, f)
			policy := f.policyFile()
			f.amending(UpdateTrackPatch, []string{"daily 01:00-03:00"}, stranger)
			_, err := f.run()
			var failed *SetupError
			if !errors.As(err, &failed) || failed.Step.ID != "updates" || !strings.HasPrefix(failed.Step.Detail, tc.want) || failed.Step.Fix != tc.fix {
				t.Fatalf("%v", err)
			}
			// Not even the track or the windows that came with the key are applied.
			f.unchanged(policy)
		})
	}
}

// ---------------------------------------------------------------- nothing to change

// Running the same command again changes nothing: the policy file isn't rewritten,
// and the step says so.
func TestSetupWithUpdateFlagsThatSayWhatTheHostHasChangesNothing(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
	before := f.policyFile()
	time.Sleep(1100 * time.Millisecond)
	for name, flags := range map[string]func(){
		"the key":     func() { f.amending("", nil, f.key) },
		"the track":   func() { f.amending(UpdateTrackMinor, nil) },
		"the windows": func() { f.amending("", []string{"Mon-Fri 02:00-04:00"}) },
		"all of them": func() { f.amending(UpdateTrackMinor, []string{"Mon-Fri 02:00-04:00"}, f.key) },
	} {
		t.Run(name, func(t *testing.T) {
			flags()
			f.events = nil
			result, err := f.run()
			if err != nil || !result.OK {
				t.Fatalf("%v\n%s", err, serviceDetail(result))
			}
			if string(f.policyFile()) != string(before) {
				t.Fatalf("a policy that says the same was rewritten:\n%s\n%s", before, f.policyFile())
			}
			want := "ask on this host · minor and patch releases · Mon–Fri 02:00–04:00 · key " + f.key.ShortID() + " (pinned) · nothing changed · paused on this host: " + asAdmin("vectory update resume") + " --state-dir " + ShellQuote(f.dir)
			if lastUpdatesStep(t, result).Detail != want {
				t.Fatalf("%q want %q", lastUpdatesStep(t, result).Detail, want)
			}
			if got := result.Updates; got == nil || got.Consent != UpdateConsentAsk || got.Track != UpdateTrackMinor || !got.Paused {
				t.Fatalf("%+v", got)
			}
		})
	}
}

// ---------------------------------------------------------------- dry run

func TestSetupDryRunSaysWhatAnAmendmentWouldChange(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
	next := testReleaseKey(t, "team-next")
	before := f.policyFile()
	requests := f.server.keyRequests.Load()
	f.options.DryRun = true
	f.options.Token = func() (string, error) { t.Fatal("a dry run asked for the token"); return "", nil }
	for name, tc := range map[string]struct {
		track   string
		windows []string
		keys    []ReleaseKey
		want    string
		fix     string
	}{
		"a key, a track and a window": {
			track: "patch", windows: []string{"daily 01:00-03:00 UTC"}, keys: []ReleaseKey{next},
			want: "Would change updates: pin key " + next.ShortID() + " instead of key " + f.key.ShortID() + "; take patch releases instead of minor and patch releases; start an update in daily 01:00–03:00 UTC instead of Mon–Fri 02:00–04:00. The rest of what this host agreed to stays as it is.",
			fix:  "A real run checks the key against the server's own list before it changes anything.",
		},
		"a track": {
			track: "patch",
			want:  "Would change updates: take patch releases instead of minor and patch releases. The rest of what this host agreed to stays as it is.",
		},
		"two keys": {
			keys: []ReleaseKey{f.key, next},
			want: "Would change updates: pin keys " + f.key.ShortID() + ", " + next.ShortID() + " instead of key " + f.key.ShortID() + ". The rest of what this host agreed to stays as it is.",
			fix:  "A real run checks the key against the server's own list before it changes anything.",
		},
		"what the host has": {
			track: "minor", windows: []string{"Mon-Fri 02:00-04:00"}, keys: []ReleaseKey{f.key},
			want: "Would change nothing about updates: this host already has ask on this host · minor and patch releases · Mon–Fri 02:00–04:00 · key " + f.key.ShortID() + ".",
		},
	} {
		t.Run(name, func(t *testing.T) {
			f.amending(tc.track, tc.windows, tc.keys...)
			f.events = nil
			result, err := f.run()
			if err != nil || !result.OK {
				t.Fatalf("%v\n%s", err, serviceDetail(result))
			}
			if step := lastUpdatesStep(t, result); step.Status != "plan" || step.Detail != tc.want || step.Fix != tc.fix {
				t.Fatalf("%+v\nwant %q and fix %q", step, tc.want, tc.fix)
			}
			if result.Updates != nil {
				t.Fatalf("a dry run reported a result: %+v", result.Updates)
			}
			if f.server.keyRequests.Load() != requests {
				t.Fatal("a dry run fetched the list of keys")
			}
			f.unchanged(before)
		})
	}
}

// ---------------------------------------------------------------- what setup keeps

// The privileged step's state is the step's: setup never touches it, whatever it
// amends.
func TestSetupWithUpdateFlagsNeverTouchesTheUpdateStepsState(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAuto, UpdateTrackPatch)
	dir, err := ensureRootOwnedDir(f.paths.StepDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	status := UpdateStatus{RunAt: time.Now().UTC().Truncate(time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1, HighestCounters: map[string]uint64{f.key.Fingerprint(): 7}}
	if err := WriteUpdateStatus(dir, status); err != nil {
		t.Fatal(err)
	}
	dir.Close()
	list := func() string {
		entries, err := os.ReadDir(f.paths.StepDir)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		return strings.Join(names, ",")
	}
	statusBefore, filesBefore := f.statusFile(), list()
	next := testReleaseKey(t, "team-next")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "retired"}, BundleKey{Key: next, State: "current"})
	f.amending(UpdateTrackMinor, []string{"daily 01:00-03:00"}, next)
	if result, err := f.run(); err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if string(f.statusFile()) != string(statusBefore) || list() != filesBefore {
		t.Fatalf("the step's state changed: %s then %s", filesBefore, list())
	}
}

func (f *consentFixture) statusFile() []byte {
	f.t.Helper()
	raw, err := os.ReadFile(f.paths.Status)
	if err != nil {
		f.t.Fatal(err)
	}
	return raw
}

// An amendment installs the step the way consent does (it is repaired where it is
// missing), after the policy is written, and a failure says what was saved. Run
// again, the command finds the policy as it wants it and installs the step.
func TestSetupWithUpdateFlagsSaysWhatWasSavedWhenTheUpdateStepCantBeInstalled(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackMinor)
	f.installFails = errors.New("systemd refused the unit")
	f.amending(UpdateTrackPatch, nil)
	result, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" || result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if want := "The agent is installed and enrolled, the update policy is saved and the service is registered, but the update step couldn't be installed (Systemd refused the unit). Setup stopped before it started or restarted the service. Until the step is installed, this host takes no update."; failed.Step.Detail != want {
		t.Fatalf("%q", failed.Step.Detail)
	}
	if strings.Contains(strings.Join(f.events, ","), "service-restart") {
		t.Fatalf("the service was restarted although its step wasn't installed: %v", f.events)
	}
	if failed.Step.Fix != "Fix the cause, then run the same command again; setup resumes where it stopped." {
		t.Fatalf("%q", failed.Step.Fix)
	}
	if policy, _ := ReadUpdatePolicy(); policy.Track != UpdateTrackPatch {
		t.Fatalf("the policy is saved: %+v", policy)
	}
	f.installFails, f.events = nil, nil
	again, err := f.run()
	if err != nil || !again.OK || f.stepInstalls() != 1 {
		t.Fatalf("%v %v\n%s", err, f.events, serviceDetail(again))
	}
	if !strings.Contains(lastUpdatesStep(t, again).Detail, "nothing changed") {
		t.Fatalf("%q", lastUpdatesStep(t, again).Detail)
	}
}

// Consent withdrawn while setup runs (a person ran `vectory update off` after
// setup read the policy) stays withdrawn: an amendment never gives it back.
func TestAnAmendmentNeverGivesBackAConsentWithdrawnWhileSetupRan(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAuto, UpdateTrackMinor, "Mon-Fri 02:00-04:00")
	var once sync.Once
	eligibility := f.host.eligibility
	f.host.eligibility = func(dir string) string {
		once.Do(func() {
			if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Consent = UpdateConsentOff; return nil }); err != nil {
				t.Error(err)
			}
		})
		return eligibility(dir)
	}
	f.amending(UpdateTrackPatch, nil)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" {
		t.Fatal(err)
	}
	if want := "The agent is installed and enrolled, but the update choices weren't changed: the consent to agent updates was withdrawn while setup ran."; failed.Step.Detail != want || failed.Step.Fix != "Add --updates auto or --updates ask, with --update-key-sha256, to turn them on again." {
		t.Fatalf("%q\n%q", failed.Step.Detail, failed.Step.Fix)
	}
	policy, _ := ReadUpdatePolicy()
	if policy.Consent != UpdateConsentOff || policy.Track != UpdateTrackMinor {
		t.Fatalf("%+v", policy)
	}
	if f.stepInstalls() != 0 {
		t.Fatal("the update step was installed for a host that withdrew its consent")
	}
}

// An amendment needs what consent needs, and says what to leave out.
func TestSetupWithUpdateFlagsNeedsAServiceAndNamesWhatToLeaveOut(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAuto, UpdateTrackMinor)
	policy := f.policyFile()
	f.options.Service = "none"
	f.amending(UpdateTrackPatch, nil)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" {
		t.Fatal(err)
	}
	if want := "Agent updates need a service. The update step restarts the agent through its service manager, and --service none leaves that to you."; failed.Step.Detail != want || failed.Step.Fix != "Leave out the update flags, or leave out --service none." {
		t.Fatalf("%q\n%q", failed.Step.Detail, failed.Step.Fix)
	}
	f.unchanged(policy)
}

// The command's own check accepts an amendment of a host that agreed, and its
// refusals of what can't work on any host come first.
func TestTheCommandsCheckOfAnAmendmentOfAHostThatAgreed(t *testing.T) {
	f := newConsentFixture(t)
	f.agreed(UpdateConsentAsk, UpdateTrackPatch)
	f.amending(UpdateTrackMinor, []string{"daily 01:00-03:00"}, f.key)
	if err := f.options.CheckUpdates(); err != nil {
		t.Fatal(err)
	}
	f.options.UpdateTrack = "major"
	if err := f.options.CheckUpdates(); err == nil || !IsInputError(err) || !strings.Contains(err.Error(), "This release offers patch and minor tracks.") {
		t.Fatalf("%v", err)
	}
}
