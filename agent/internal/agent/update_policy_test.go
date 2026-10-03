package agent

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const (
	teamKeyLine = "vectory-release-key ed25519 3n1kX5uZnEN2wf+ZrjTlfd3sqUPQff1ANP0I/elZz7o= team"
	nextKeyLine = "vectory-release-key ed25519 EfEAEZ4zQhLJkpS72PMa8tlIIRVq/eIn895jrezMZpY= team-next"
	// The fingerprints of the two published test keys.
	teamFingerprint = "05cc6c02351af0cb1be9877e7cdcd326c68310018746cb7bbbf6beb29392618b"
	nextFingerprint = "5f0681261c9f25fae4e8a4e2e6701582cf20e228f711848bb8bc9db7190acadb"
)

func testKey(t *testing.T, line string) ReleaseKey {
	t.Helper()
	key, err := ParseReleaseKey(line)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// generatedKeyLine is a key line for the n-th of any number of valid keys: the
// public half of a key made from a fixed seed.
func generatedKeyLine(n int) string {
	seed := sha256.Sum256([]byte(fmt.Sprintf("a test key for the update policy, number %d", n)))
	public := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
	return fmt.Sprintf("vectory-release-key ed25519 %s generated-%d", base64.StdEncoding.EncodeToString(public), n)
}

func samplePolicy(t *testing.T) UpdatePolicy {
	t.Helper()
	return UpdatePolicy{
		Consent: UpdateConsentAuto, Track: UpdateTrackPatch, Windows: []string{"Mon-Fri 02:00-04:00 UTC"},
		Keys:      []PinnedKey{{Key: testKey(t, teamKeyLine), PinnedAt: time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC)}},
		UpdatedAt: time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC),
	}
}

func TestThePolicyGoldenFilesReadAndWriteBackToTheSameBytes(t *testing.T) {
	for _, name := range []string{"policy.json", "policy-off.json", "policy-ask-minor.json"} {
		policy, err := ParseUpdatePolicy(golden(t, name))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		out, err := MarshalUpdatePolicy(policy)
		if err != nil || !bytes.Equal(out, golden(t, name)) {
			t.Errorf("%s was read and written back as\n%s (%v)\nwant\n%s", name, out, err, golden(t, name))
		}
	}
}

func TestThePolicyExamplesSayWhatTheContractSays(t *testing.T) {
	policy, err := ParseUpdatePolicy(golden(t, "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if policy.Consent != UpdateConsentAuto || policy.Track != UpdateTrackPatch || policy.Paused || len(policy.Windows) != 1 || policy.Windows[0] != "Mon-Fri 02:00-04:00 UTC" ||
		len(policy.Keys) != 1 || policy.Keys[0].Key.Line() != teamKeyLine || policy.Keys[0].Key.Fingerprint() != teamFingerprint ||
		!policy.Keys[0].PinnedAt.Equal(time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC)) || !policy.UpdatedAt.Equal(time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC)) {
		t.Errorf("%+v", policy)
	}
	if got := policy.Fingerprints(); len(got) != 1 || got[0] != teamFingerprint {
		t.Errorf("Fingerprints: %v", got)
	}
	if got := policy.PinnedKeys(); len(got) != 1 || got[0].Fingerprint() != teamFingerprint {
		t.Errorf("PinnedKeys: %v", got)
	}
	windows, err := policy.ParsedWindows()
	if err != nil || len(windows) != 1 || !windows.OpenAt(time.Date(2026, 10, 5, 3, 0, 0, 0, time.UTC)) || windows.OpenAt(time.Date(2026, 10, 5, 5, 0, 0, 0, time.UTC)) {
		t.Errorf("the window: %v, %v", windows, err)
	}
	off, err := ParseUpdatePolicy(golden(t, "policy-off.json"))
	if err != nil || off.Consent != UpdateConsentOff || off.Windows == nil || len(off.Windows) != 0 || len(off.Keys) != 0 {
		t.Errorf("off: %+v, %v", off, err)
	}
	ask, err := ParseUpdatePolicy(golden(t, "policy-ask-minor.json"))
	if err != nil || ask.Consent != UpdateConsentAsk || ask.Track != UpdateTrackMinor || !ask.Paused || len(ask.Keys) != 2 || ask.Keys[1].Key.Fingerprint() != nextFingerprint {
		t.Errorf("ask: %+v, %v", ask, err)
	}
	if def := DefaultUpdatePolicy(); def.Consent != UpdateConsentOff || def.Track != UpdateTrackPatch || def.Paused || len(def.Keys) != 0 {
		t.Errorf("the default: %+v", def)
	}
}

func TestEveryMemberOfThePolicyIsRequiredAndNothingElseIsAccepted(t *testing.T) {
	for _, name := range []string{"policy.json", "policy-off.json", "policy-ask-minor.json"} {
		top := parseObject(t, golden(t, name))
		check := func(what string, data []byte, want string) {
			t.Helper()
			_, err := ParseUpdatePolicy(data)
			if !errors.Is(err, ErrUpdatePolicyInvalid) || !strings.Contains(err.Error(), want) {
				t.Errorf("%s, %s: %v, want ErrUpdatePolicyInvalid that says %q", name, what, err, want)
			}
		}
		for _, key := range top.keys {
			check("without "+key, top.without(key).bytes(), `lacks the member "`+key+`"`)
			check(key+" renamed", top.renamed(key, key+"_x").bytes(), `has a member "`+key+`_x"`)
			check(key+" in capitals", top.renamed(key, strings.ToUpper(key)).bytes(), `has a member "`+strings.ToUpper(key)+`"`)
			check(key+" twice", top.duplicated(key), `has the member "`+key+`" twice`)
		}
		check("another member", top.with("extra", "1").bytes(), `has a member "extra"`)
	}
	// The members of a pinned key.
	top := parseObject(t, golden(t, "policy.json"))
	entry := parseObject(t, []byte(strings.TrimSuffix(strings.TrimPrefix(string(top.values["keys"]), "["), "]")))
	withKey := func(raw string) []byte { return top.with("keys", "["+strings.TrimSpace(raw)+"]").bytes() }
	for _, member := range entry.keys {
		for what, raw := range map[string]string{
			"without " + member:     string(entry.without(member).bytes()),
			member + " renamed":     string(entry.renamed(member, member+"_x").bytes()),
			member + " in capitals": string(entry.renamed(member, strings.ToUpper(member)).bytes()),
			member + " twice":       string(entry.duplicated(member)),
			"another member":        string(entry.with("extra", "1").bytes()),
		} {
			if _, err := ParseUpdatePolicy(withKey(raw)); !errors.Is(err, ErrUpdatePolicyInvalid) {
				t.Errorf("a pinned key with %s: %v", what, err)
			}
		}
	}
}

func TestUpdatePolicyValues(t *testing.T) {
	policy := parseObject(t, golden(t, "policy.json"))
	team := `{"public_key":"` + teamKeyLine + `","pinned_at":"2026-10-03T12:30:00Z"}`
	windows := func(n int) string {
		list := make([]string, n)
		for i := range list {
			list[i] = fmt.Sprintf(`"Mon 0%d:00-0%d:00"`, i+1, i+2)
		}
		return "[" + strings.Join(list, ",") + "]"
	}
	for _, tc := range []struct{ member, value, want string }{
		{"schema", `"vectory.update-policy.v2"`, "the schema is"},
		{"consent", `"on"`, `consent "on"`},
		{"consent", `"AUTO"`, `consent "AUTO"`},
		{"consent", `""`, `consent ""`},
		{"consent", `null`, `consent ""`},
		{"track", `"major"`, releaseMajorTrackMessage},
		{"track", `"Patch"`, `"Patch" isn't an update track`},
		{"track", `"weekly"`, `"weekly" isn't an update track`},
		{"track", `""`, `"" isn't an update track`},
		{"windows", `null`, "windows isn't a list"},
		{"windows", `"Mon-Fri 02:00-04:00"`, ""},
		{"windows", `[1]`, ""},
		{"windows", `[null]`, "isn't an update window"},
		{"windows", `["nonsense"]`, "isn't an update window"},
		{"windows", `["Mon-Fri 02:00-04:00","Mon  02:00-04:00"]`, "isn't an update window"},
		{"windows", strings.Replace(windows(7), "]", `,"daily 03:00-04:00"]`, 1), "at most 7"},
		{"paused", `null`, "paused isn't true or false"},
		{"paused", `"false"`, ""},
		{"paused", `0`, ""},
		{"keys", `null`, "keys isn't a list"},
		{"keys", `{}`, ""},
		{"keys", `[]`, "pins at least one release key"},
		{"keys", "[" + team + "," + team + "]", "pins " + teamFingerprint[:16] + " again"},
		{"keys", `[{"public_key":"` + teamKeyLine + `","pinned_at":"yesterday"}]`, "pinned_at"},
		{"keys", `[{"public_key":"` + teamKeyLine + `","pinned_at":"2026-10-03T12:30:00.500Z"}]`, "pinned_at"},
		{"keys", `[{"public_key":"not a key","pinned_at":"2026-10-03T12:30:00Z"}]`, "key 1"},
		{"keys", `[{"public_key":"` + strings.Replace(teamKeyLine, "ed25519", "rsa", 1) + `","pinned_at":"2026-10-03T12:30:00Z"}]`, "key 1"},
		{"keys", `[{"public_key":"` + teamKeyLine + `\n","pinned_at":"2026-10-03T12:30:00Z"}]`, "key 1"},
		{"keys", `[{"public_key":"","pinned_at":"2026-10-03T12:30:00Z"}]`, "key 1"},
		{"keys", `[null]`, "key 1"},
		{"updated_at", `"2026-10-03T12:30:00+00:00"`, "updated_at"},
		{"updated_at", `""`, "updated_at"},
		{"updated_at", `null`, "updated_at"},
	} {
		_, err := ParseUpdatePolicy(policy.with(tc.member, tc.value).bytes())
		if err == nil || !errors.Is(err, ErrUpdatePolicyInvalid) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s = %s: %v, want an ErrUpdatePolicyInvalid that says %q", tc.member, tc.value, err, tc.want)
		}
	}
	// With the level off, no key is needed, and keys may still be pinned.
	if _, err := ParseUpdatePolicy(policy.with("consent", `"off"`).with("keys", "[]").bytes()); err != nil {
		t.Errorf("off with no key: %v", err)
	}
	if p, err := ParseUpdatePolicy(policy.with("consent", `"off"`).bytes()); err != nil || len(p.Keys) != 1 {
		t.Errorf("off with a key (pins are kept): %+v, %v", p, err)
	}
	for _, tc := range []struct{ member, value string }{
		{"consent", `"ask"`}, {"track", `"minor"`}, {"paused", `true`}, {"windows", windows(7)}, {"windows", `[]`},
		// A key's name may hold spaces, and a name is all that tells two keys apart by eye.
		{"keys", `[{"public_key":"` + teamKeyLine + ` extra","pinned_at":"2026-10-03T12:30:00Z"}]`},
	} {
		if _, err := ParseUpdatePolicy(policy.with(tc.member, tc.value).bytes()); err != nil {
			t.Errorf("%s = %s: %v", tc.member, tc.value, err)
		}
	}
}

func TestThePolicyPinsAtMostFourKeys(t *testing.T) {
	policy := parseObject(t, golden(t, "policy.json"))
	keys := func(n int) string {
		list := make([]string, n)
		for i := range list {
			list[i] = `{"public_key":"` + generatedKeyLine(i) + `","pinned_at":"2026-10-03T12:30:00Z"}`
		}
		return "[" + strings.Join(list, ",") + "]"
	}
	for n := 1; n <= 4; n++ {
		if p, err := ParseUpdatePolicy(policy.with("keys", keys(n)).bytes()); err != nil || len(p.Keys) != n {
			t.Errorf("%d keys: %v", n, err)
		}
	}
	if _, err := ParseUpdatePolicy(policy.with("keys", keys(5)).bytes()); err == nil || !strings.Contains(err.Error(), "at most 4") {
		t.Errorf("5 keys: %v", err)
	}
	p := samplePolicy(t)
	p.Keys = nil
	for i := 0; i < 5; i++ {
		p.Keys = append(p.Keys, PinnedKey{Key: testKey(t, generatedKeyLine(i)), PinnedAt: p.UpdatedAt})
	}
	if _, err := MarshalUpdatePolicy(p); err == nil {
		t.Error("a policy that pins five keys was written")
	}
	p.Keys = p.Keys[:4]
	if _, err := MarshalUpdatePolicy(p); err != nil {
		t.Errorf("four keys: %v", err)
	}
}

func TestMarshalUpdatePolicyRefusesWhatAReaderWouldRefuse(t *testing.T) {
	good := samplePolicy(t)
	if _, err := MarshalUpdatePolicy(good); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*UpdatePolicy){
		"a consent that isn't one": func(p *UpdatePolicy) { p.Consent = "on" },
		"no consent":               func(p *UpdatePolicy) { p.Consent = "" },
		"track major":              func(p *UpdatePolicy) { p.Track = "major" },
		"no track":                 func(p *UpdatePolicy) { p.Track = "" },
		"a window":                 func(p *UpdatePolicy) { p.Windows = []string{"whenever"} },
		"eight windows":            func(p *UpdatePolicy) { p.Windows = repeated("daily 01:00-02:00", 8) },
		"no key on auto":           func(p *UpdatePolicy) { p.Keys = nil },
		"no key on ask":            func(p *UpdatePolicy) { p.Consent = UpdateConsentAsk; p.Keys = nil },
		"a key that isn't one":     func(p *UpdatePolicy) { p.Keys = []PinnedKey{{PinnedAt: p.UpdatedAt}} },
		"a key pinned twice":       func(p *UpdatePolicy) { p.Keys = append(p.Keys, p.Keys[0]) },
		"no update time":           func(p *UpdatePolicy) { p.UpdatedAt = time.Time{} },
		"no pinned time":           func(p *UpdatePolicy) { p.Keys[0].PinnedAt = time.Time{} },
		"a time before 1970":       func(p *UpdatePolicy) { p.Keys[0].PinnedAt = time.Date(1969, 12, 31, 0, 0, 0, 0, time.UTC) },
	} {
		p := good
		p.Keys = append([]PinnedKey(nil), good.Keys...)
		change(&p)
		if data, err := MarshalUpdatePolicy(p); err == nil {
			t.Errorf("%s: a policy was written: %s", name, data)
		}
	}
	if data, err := MarshalUpdatePolicy(UpdatePolicy{Consent: "off", Track: "patch", UpdatedAt: good.UpdatedAt}); err != nil || !bytes.Equal(data, golden(t, "policy-off.json")) {
		t.Errorf("nothing set: %s, %v", data, err)
	}
	// A key name's <, > and & are not written as HTML escapes: the line is quoted
	// in the file exactly as it is anywhere else.
	odd := good
	odd.Keys = []PinnedKey{{Key: testKey(t, strings.Replace(teamKeyLine, " team", " ops <a&b>", 1)), PinnedAt: good.UpdatedAt}}
	data, err := MarshalUpdatePolicy(odd)
	if err != nil || !strings.Contains(string(data), "ops <a&b>") {
		t.Errorf("a key named with angle brackets: %s, %v", data, err)
	}
}

func repeated(text string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = text
	}
	return out
}

// ---------------------------------------------------------------- on disk

func TestAMissingPolicyIsAHostThatTakesNoUpdate(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	policy, err := ReadUpdatePolicy()
	if err != nil {
		t.Fatalf("no policy directory: %v", err)
	}
	if policy.Consent != UpdateConsentOff || policy.Track != UpdateTrackPatch || len(policy.Keys) != 0 || policy.Windows != nil && len(policy.Windows) != 0 {
		t.Errorf("%+v", policy)
	}
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	dir.Close()
	if policy, err = ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentOff {
		t.Errorf("a policy directory with no policy: %+v, %v", policy, err)
	}
}

func TestWriteUpdatePolicyThenReadItBack(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	written := time.Date(2026, 10, 3, 12, 31, 7, 900_000_000, time.UTC)
	p := samplePolicy(t)
	p.Keys = append(p.Keys, PinnedKey{Key: testKey(t, nextKeyLine)}) // never pinned: pinned now
	p.Keys[0].PinnedAt = time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	if err := writeUpdatePolicy(paths, p, written, nil); err != nil {
		t.Fatal(err)
	}
	got, err := ReadUpdatePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if got.Consent != UpdateConsentAuto || got.Track != UpdateTrackPatch || got.Paused || len(got.Windows) != 1 || len(got.Keys) != 2 {
		t.Fatalf("%+v", got)
	}
	if want := time.Date(2026, 10, 3, 12, 31, 7, 0, time.UTC); !got.UpdatedAt.Equal(want) {
		t.Errorf("updated_at is %v, want the time of the write, %v", got.UpdatedAt, want)
	}
	if !got.Keys[0].PinnedAt.Equal(time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("a key that was pinned before has pinned_at %v", got.Keys[0].PinnedAt)
	}
	if !got.Keys[1].PinnedAt.Equal(time.Date(2026, 10, 3, 12, 31, 7, 0, time.UTC)) {
		t.Errorf("a key with no time is pinned at the time of the write: %v", got.Keys[1].PinnedAt)
	}
	if fingerprints := got.Fingerprints(); fingerprints[0] != teamFingerprint || fingerprints[1] != nextFingerprint {
		t.Errorf("the pins: %v", fingerprints)
	}
	if !p.UpdatedAt.Equal(time.Date(2026, 10, 3, 12, 30, 0, 0, time.UTC)) || !p.Keys[1].PinnedAt.IsZero() {
		t.Error("writing a policy changed the caller's copy")
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{paths.PolicyDir: 0o755, paths.Policy: 0o644} {
			if info, err := os.Stat(path); err != nil || info.Mode().Perm() != want {
				t.Errorf("%s: %v, %v; want %04o", path, info, err, want)
			}
		}
	}
	// Writing again replaces the file and leaves nothing beside it.
	p.Paused = true
	if err := writeUpdatePolicy(paths, p, written.Add(time.Hour), nil); err != nil {
		t.Fatal(err)
	}
	if again, err := ReadUpdatePolicy(); err != nil || !again.Paused {
		t.Errorf("after a second write: %+v, %v", again, err)
	}
	entries, err := os.ReadDir(paths.PolicyDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "policy.json" {
		t.Errorf("the policy directory holds %v, %v", entries, err)
	}
}

func TestWriteUpdatePolicyRefusesAPolicyAReaderWouldRefuseAndKeepsWhatWasThere(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(paths.Policy)
	if err != nil {
		t.Fatal(err)
	}
	bad := samplePolicy(t)
	bad.Keys = nil
	if err := writeUpdatePolicy(paths, bad, time.Now(), nil); err == nil || !errors.Is(err, ErrUpdatePolicyInvalid) {
		t.Errorf("auto with no key: %v", err)
	}
	bad = samplePolicy(t)
	bad.Windows = []string{"whenever"}
	if err := writeUpdatePolicy(paths, bad, time.Now(), nil); err == nil {
		t.Error("a window that doesn't parse was written")
	}
	if after, _ := os.ReadFile(paths.Policy); !bytes.Equal(before, after) {
		t.Error("a refused write changed the policy")
	}
}

func TestAPolicyInADirectoryAnotherAccountCanWriteIsNotBelieved(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows rule is tested with real access lists in rootpath_windows_test.go")
	}
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdatePolicy(); err != nil {
		t.Fatal(err)
	}
	above := filepath.Dir(paths.PolicyDir)
	for name, change := range map[string]func() error{
		"the policy directory is writable by its group":     func() error { return os.Chmod(paths.PolicyDir, 0o775) },
		"the policy file is writable by everyone":           func() error { return os.Chmod(paths.Policy, 0o666) },
		"a directory above the policy is writable by group": func() error { return os.Chmod(above, 0o775) },
	} {
		if err := change(); err != nil {
			t.Fatal(err)
		}
		_, err := ReadUpdatePolicy()
		refusedAs(t, err)
		if name != "the policy file is writable by everyone" {
			// Nothing is written below a directory that isn't root's alone.
			if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err == nil {
				t.Errorf("%s: a policy was written", name)
			}
		}
		for path, mode := range map[string]os.FileMode{paths.PolicyDir: 0o755, paths.Policy: 0o644, above: 0o755} {
			if err := os.Chmod(path, mode); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := ReadUpdatePolicy(); err != nil {
			t.Fatalf("%s, after it was put right: %v", name, err)
		}
	}
	// A link in place of the file is not followed.
	real := paths.Policy + ".real"
	if err := os.Rename(paths.Policy, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, paths.Policy); err != nil {
		t.Fatal(err)
	}
	_, err := ReadUpdatePolicy()
	refusedAs(t, err)
	// A write replaces the link itself, and the policy is read again.
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdatePolicy(); err != nil {
		t.Errorf("after a write replaced the link: %v", err)
	}
}

func TestAPolicyThatIsNotWhatTheContractSaysIsAnErrorTheCallerCanTell(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	for name, content := range map[string]string{
		"not JSON":           "consent: auto\n",
		"empty":              "",
		"the wrong schema":   strings.Replace(string(golden(t, "policy.json")), "update-policy.v1", "update-policy.v9", 1),
		"track major":        strings.Replace(string(golden(t, "policy.json")), `"track":"patch"`, `"track":"major"`, 1),
		"a member twice":     strings.Replace(string(golden(t, "policy.json")), `"paused":false`, `"paused":false,"paused":false`, 1),
		"more than 8 KiB":    string(golden(t, "policy.json")) + strings.Repeat(" ", maxUpdatePolicy),
		"auto and no key":    strings.Replace(string(golden(t, "policy-off.json")), `"consent":"off"`, `"consent":"auto"`, 1),
		"data after it":      string(golden(t, "policy.json")) + "{}",
		"a byte order mark":  "\xef\xbb\xbf" + string(golden(t, "policy.json")),
		"capitals in a name": strings.Replace(string(golden(t, "policy.json")), `"consent"`, `"Consent"`, 1),
	} {
		if err := dir.WriteFile("policy.json", []byte(content), rootReadable); err != nil {
			t.Fatal(err)
		}
		policy, err := ReadUpdatePolicy()
		if err == nil {
			t.Errorf("%s: read as %+v", name, policy)
			continue
		}
		if name != "more than 8 KiB" && !errors.Is(err, ErrUpdatePolicyInvalid) {
			t.Errorf("%s: %v isn't ErrUpdatePolicyInvalid", name, err)
		}
		if policy.Consent != "" {
			t.Errorf("%s: the policy came back as %+v with the error", name, policy)
		}
		if !strings.Contains(err.Error(), paths.Policy) {
			t.Errorf("%s: the error doesn't name the file: %v", name, err)
		}
	}
	if err := dir.WriteFile("policy.json", []byte(strings.Replace(string(golden(t, "policy.json")), `"track":"patch"`, `"track":"major"`, 1)), rootReadable); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadUpdatePolicy(); err == nil || !strings.Contains(err.Error(), "Upgrade to a new major version by hand.") {
		t.Errorf("track major: %v", err)
	}
}

func TestOnlyRootWritesThePolicy(t *testing.T) {
	if os.Geteuid() == 0 || runtime.GOOS == "windows" {
		t.Skip("this test runs as an account that isn't root")
	}
	if rootOwnedTrust != (ownerTrust{}) {
		t.Fatal("a test left the path check's seam set")
	}
	err := WriteUpdatePolicy(samplePolicy(t))
	if err == nil || !strings.Contains(err.Error(), "root") {
		t.Errorf("a policy written without root: %v", err)
	}
}
