package agent

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- the shared vectors

// The vectors are written by a third implementation of the contract and read
// by the server's tests too: a byte string that one side accepts and the other
// refuses fails there instead of reaching a host. Every case must give exactly
// the answer in the file.

type releaseVectorKey struct {
	Name          string `json:"name"`
	SeedHex       string `json:"seed_hex"`
	PublicKeyLine string `json:"public_key_line"`
	Fingerprint   string `json:"fingerprint"`
}

type releaseKeyLineVector struct {
	Name   string `json:"name"`
	About  string `json:"about"`
	Line   string `json:"line"`
	Expect struct {
		Result      string `json:"result"`
		Fingerprint string `json:"fingerprint"`
		Name        string `json:"name"`
		Code        string `json:"code"`
	} `json:"expect"`
}

type releaseBundleVector struct {
	Name        string `json:"name"`
	About       string `json:"about"`
	BundleB64   string `json:"bundle_b64"`
	Fingerprint string `json:"fingerprint"`
	Expect      struct {
		Result    string `json:"result"`
		Code      string `json:"code"`
		PublicKey string `json:"public_key"`
	} `json:"expect"`
}

type releaseCaseVector struct {
	Name          string `json:"name"`
	About         string `json:"about"`
	ManifestB64   string `json:"manifest_b64"`
	SignaturesB64 string `json:"signatures_b64"`
	Rollovers     []struct {
		StatementB64 string `json:"statement_b64"`
		SignatureB64 string `json:"signature_b64"`
	} `json:"rollovers"`
	Pins              []string          `json:"pins"`
	Floors            map[string]uint64 `json:"floors"`
	RunningVersion    string            `json:"running_version"`
	OS                string            `json:"os"`
	Arch              string            `json:"arch"`
	Track             string            `json:"track"`
	ServiceDefinition int               `json:"service_definition"`
	Now               string            `json:"now"`
	Last              *struct {
		Release string `json:"release"`
		Outcome string `json:"outcome"`
	} `json:"last"`
	Expect struct {
		Result           string            `json:"result"`
		Code             string            `json:"code"`
		Signer           string            `json:"signer"`
		PinsAfter        []string          `json:"pins_after"`
		FloorsAfter      map[string]uint64 `json:"floors_after"`
		RolloverConflict *struct {
			From string   `json:"from"`
			To   []string `json:"to"`
		} `json:"rollover_conflict"`
	} `json:"expect"`
}

type releaseVectors struct {
	Keys     []releaseVectorKey     `json:"keys"`
	KeyLines []releaseKeyLineVector `json:"key_lines"`
	Bundles  []releaseBundleVector  `json:"bundles"`
	Cases    []releaseCaseVector    `json:"cases"`
}

func loadReleaseVectors(t *testing.T) releaseVectors {
	t.Helper()
	var vectors releaseVectors
	if err := json.Unmarshal(repoFile(t, "contracts/fixtures/agent-release/vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Keys) < 16 || len(vectors.KeyLines) < 40 || len(vectors.Bundles) < 10 || len(vectors.Cases) < 250 {
		t.Fatalf("the vectors look cut short: %d keys, %d key lines, %d bundles, %d cases", len(vectors.Keys), len(vectors.KeyLines), len(vectors.Bundles), len(vectors.Cases))
	}
	return vectors
}

func TestSharedReleaseVectors(t *testing.T) {
	vectors := loadReleaseVectors(t)
	keys := map[string]ReleaseKey{}
	for _, vector := range vectors.Keys {
		key, err := ParseReleaseKey(vector.PublicKeyLine)
		if err != nil {
			t.Fatalf("test key %s: %v", vector.Name, err)
		}
		keys[vector.Fingerprint] = key
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			decode := func(text string) []byte {
				decoded, err := base64.StdEncoding.DecodeString(text)
				if err != nil {
					t.Fatalf("the vector's base64: %v", err)
				}
				return decoded
			}
			now, err := time.Parse(time.RFC3339, vector.Now)
			if err != nil {
				t.Fatal(err)
			}
			input := VerifyInput{
				Manifest:          decode(vector.ManifestB64),
				Signatures:        decode(vector.SignaturesB64),
				Floors:            vector.Floors,
				Now:               now,
				RunningVersion:    vector.RunningVersion,
				OS:                vector.OS,
				Arch:              vector.Arch,
				Track:             vector.Track,
				ServiceDefinition: vector.ServiceDefinition,
			}
			for _, fingerprint := range vector.Pins {
				key, found := keys[fingerprint]
				if !found {
					t.Fatalf("the case pins %s, which is not one of the vectors' keys", fingerprint)
				}
				input.Pins = append(input.Pins, key)
			}
			for _, envelope := range vector.Rollovers {
				input.Rollovers = append(input.Rollovers, RolloverEnvelope{Statement: envelope.StatementB64, Signature: envelope.SignatureB64})
			}
			if vector.Last != nil {
				input.Last = &ReleaseResult{Release: vector.Last.Release, Outcome: vector.Last.Outcome}
			}
			verified, err := VerifyRelease(input)
			if vector.Expect.Result == "valid" {
				if err != nil {
					t.Fatalf("want a valid release (%s), got %v", vector.About, err)
				}
				if got := verified.Signer().Fingerprint(); got != vector.Expect.Signer {
					t.Errorf("signer %s, want %s", got, vector.Expect.Signer)
				}
				var pins []string
				for _, key := range verified.Pins {
					pins = append(pins, key.Fingerprint())
				}
				if !reflect.DeepEqual(pins, vector.Expect.PinsAfter) {
					t.Errorf("pins after %v, want %v", pins, vector.Expect.PinsAfter)
				}
				if !reflect.DeepEqual(verified.Floors, vector.Expect.FloorsAfter) {
					t.Errorf("floors after %v, want %v", verified.Floors, vector.Expect.FloorsAfter)
				}
				if verified.ManifestSHA256 != Digest(input.Manifest) {
					t.Errorf("manifest digest %s", verified.ManifestSHA256)
				}
				if verified.Artifact.OS != vector.OS || verified.Artifact.Arch != vector.Arch {
					t.Errorf("artifact %+v is not for %s/%s", verified.Artifact, vector.OS, vector.Arch)
				}
				return
			}
			var refusal *UpdateRefusal
			if !errors.As(err, &refusal) {
				t.Fatalf("want %s (%s), got %v", vector.Expect.Code, vector.About, err)
			}
			if refusal.Code != vector.Expect.Code {
				t.Fatalf("code %s (%s), want %s (%s)", refusal.Code, refusal.Detail, vector.Expect.Code, vector.About)
			}
			if refusal.Detail == "" {
				t.Error("a refusal says what was found")
			}
			if conflict := vector.Expect.RolloverConflict; conflict != nil {
				if refusal.From != conflict.From || !reflect.DeepEqual(refusal.Successors, conflict.To) {
					t.Errorf("fork from %s to %v, want from %s to %v", refusal.From, refusal.Successors, conflict.From, conflict.To)
				}
			} else if refusal.From != "" || refusal.Successors != nil {
				t.Errorf("only a fork names a key and its successors: %+v", refusal)
			}
		})
	}
}

func TestSharedReleaseKeyLines(t *testing.T) {
	for _, vector := range loadReleaseVectors(t).KeyLines {
		t.Run(vector.Name, func(t *testing.T) {
			key, err := ParseReleaseKey(vector.Line)
			if vector.Expect.Result == "valid" {
				if err != nil {
					t.Fatalf("want a valid key (%s), got %v", vector.About, err)
				}
				if key.Fingerprint() != vector.Expect.Fingerprint || key.Name() != vector.Expect.Name {
					t.Errorf("key %s %q, want %s %q", key.Fingerprint(), key.Name(), vector.Expect.Fingerprint, vector.Expect.Name)
				}
				if key.Line() != vector.Line {
					t.Errorf("the key writes itself as %q, not %q", key.Line(), vector.Line)
				}
				return
			}
			var refusal *UpdateRefusal
			if !errors.As(err, &refusal) || refusal.Code != vector.Expect.Code {
				t.Fatalf("want %s (%s), got %v", vector.Expect.Code, vector.About, err)
			}
			if !key.IsZero() || key.Fingerprint() != "" {
				t.Error("a refused key is not a key")
			}
		})
	}
}

// What setup does with the key bundle: this runs the vectors' bundle cases with
// the library's key rule, the way setup applies it. Every entry's key must pass
// the rule and its `fingerprint` member must equal the fingerprint computed from
// its bytes, or the bundle is malformed and nothing is pinned.
func TestSharedReleaseBundles(t *testing.T) {
	pinFromBundle := func(raw []byte, wanted string) (string, string) {
		var bundle struct {
			Schema string `json:"schema"`
			Keys   []struct {
				PublicKey   string `json:"public_key"`
				Fingerprint string `json:"fingerprint"`
				State       string `json:"state"`
			} `json:"keys"`
		}
		if json.Unmarshal(raw, &bundle) != nil || bundle.Schema != "vectory.release-keys.v1" || bundle.Keys == nil {
			return "refused", ""
		}
		found := ""
		for _, entry := range bundle.Keys {
			key, err := ParseReleaseKey(entry.PublicKey)
			if err != nil || entry.Fingerprint != key.Fingerprint() || (entry.State != "current" && entry.State != "retired") {
				return "refused", ""
			}
			if key.Fingerprint() == wanted && found == "" {
				found = entry.PublicKey
			}
		}
		if found == "" {
			return "absent", ""
		}
		return "valid", found
	}
	for _, vector := range loadReleaseVectors(t).Bundles {
		t.Run(vector.Name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(vector.BundleB64)
			if err != nil {
				t.Fatal(err)
			}
			result, pinned := pinFromBundle(raw, vector.Fingerprint)
			if result != vector.Expect.Result || pinned != vector.Expect.PublicKey {
				t.Fatalf("%s %q, want %s %q (%s)", result, pinned, vector.Expect.Result, vector.Expect.PublicKey, vector.About)
			}
		})
	}
}

// A key line is the key's own text: the seed gives the line and the fingerprint
// the vectors publish, with Go's own Ed25519.
func TestSharedReleaseKeysComeFromTheirSeeds(t *testing.T) {
	for _, vector := range loadReleaseVectors(t).Keys {
		seed, err := hex.DecodeString(vector.SeedHex)
		if err != nil || len(seed) != ed25519.SeedSize {
			t.Fatalf("%s: seed %q", vector.Name, vector.SeedHex)
		}
		private := ReleasePrivateKey{valid: true}
		copy(private.seed[:], seed)
		public, err := private.Public(vector.Name)
		if err != nil {
			t.Fatal(err)
		}
		if public.Line() != vector.PublicKeyLine || public.Fingerprint() != vector.Fingerprint || private.Fingerprint() != vector.Fingerprint {
			t.Errorf("%s: key %s %q, want %s %q", vector.Name, public.Fingerprint(), public.Line(), vector.Fingerprint, vector.PublicKeyLine)
		}
	}
}

// ---------------------------------------------------------------- a small host to test with

const testManifest = `{"schema":"vectory.agent-release.v1","version":"0.1.1","counter":7,"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z","min_from":"0.1.0","service_definition":1,"artifacts":[{"os":"linux","arch":"amd64","format":"executable","file":"vectory-0.1.1-linux-amd64","size":15204352,"sha256":"4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"},{"os":"windows","arch":"amd64","format":"executable","file":"vectory-0.1.1-windows-amd64.exe","size":15892480,"sha256":"25043433d22cf8f6f5ffb531abb6a0b0fe0952af2bb946586b5868b4bdf4e201"}]}`

var testNow = time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)

func testPrivateKey(t *testing.T, seedByte byte) ReleasePrivateKey {
	t.Helper()
	key := ReleasePrivateKey{valid: true}
	for i := range key.seed {
		key.seed[i] = seedByte
	}
	return key
}

func testPublicKey(t *testing.T, private ReleasePrivateKey, name string) ReleaseKey {
	t.Helper()
	key, err := private.Public(name)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// signedHost is a host that pins one key, and an offer of manifest signed by it.
func signedHost(t *testing.T, manifest string) (VerifyInput, ReleasePrivateKey, ReleaseKey) {
	t.Helper()
	private := testPrivateKey(t, 1)
	public := testPublicKey(t, private, "team")
	return signedBy(t, manifest, private, public), private, public
}

func signedBy(t *testing.T, manifest string, private ReleasePrivateKey, public ReleaseKey) VerifyInput {
	t.Helper()
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(public, private.SignRelease([]byte(manifest)))})
	if err != nil {
		t.Fatal(err)
	}
	return VerifyInput{
		Manifest:          []byte(manifest),
		Signatures:        signatures,
		Pins:              []ReleaseKey{public},
		Now:               testNow,
		RunningVersion:    "0.1.0",
		OS:                "linux",
		Arch:              "amd64",
		Track:             ReleaseTrackPatch,
		ServiceDefinition: 1,
	}
}

func releaseSignatureBy(key ReleaseKey, signature []byte) ReleaseSignature {
	entry := ReleaseSignature{Key: key.Fingerprint()}
	copy(entry.Signature[:], signature)
	return entry
}

// mutated returns testManifest with the first occurrence of old replaced.
func mutated(t *testing.T, old, replacement string) string {
	t.Helper()
	if !strings.Contains(testManifest, old) {
		t.Fatalf("the test manifest has no %q", old)
	}
	return strings.Replace(testManifest, old, replacement, 1)
}

func wantRefusal(t *testing.T, err error, code string) *UpdateRefusal {
	t.Helper()
	var refusal *UpdateRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("want %s, got %v", code, err)
	}
	if refusal.Code != code {
		t.Fatalf("code %s (%s), want %s", refusal.Code, refusal.Detail, code)
	}
	return refusal
}

// ---------------------------------------------------------------- the manifest

func TestParseReleaseManifestReadsEveryField(t *testing.T) {
	manifest, err := ParseReleaseManifest([]byte(testManifest + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := ReleaseManifest{
		Version:           "0.1.1",
		Counter:           7,
		IssuedAt:          time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC),
		ExpiresAt:         time.Date(2027, 4, 1, 12, 0, 0, 0, time.UTC),
		MinFrom:           "0.1.0",
		ServiceDefinition: 1,
		Artifacts: []ReleaseArtifact{
			{OS: "linux", Arch: "amd64", Format: "executable", File: "vectory-0.1.1-linux-amd64", Size: 15204352, SHA256: "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"},
			{OS: "windows", Arch: "amd64", Format: "executable", File: "vectory-0.1.1-windows-amd64.exe", Size: 15892480, SHA256: "25043433d22cf8f6f5ffb531abb6a0b0fe0952af2bb946586b5868b4bdf4e201"},
		},
	}
	if !reflect.DeepEqual(manifest, want) {
		t.Fatalf("got %+v\nwant %+v", manifest, want)
	}
	if artifact, ok := manifest.ArtifactFor("windows", "amd64"); !ok || artifact.File != "vectory-0.1.1-windows-amd64.exe" {
		t.Errorf("ArtifactFor: %+v %v", artifact, ok)
	}
	if _, ok := manifest.ArtifactFor("linux", "arm64"); ok {
		t.Error("ArtifactFor finds a build that isn't there")
	}
	// min_from is optional.
	without, err := ParseReleaseManifest([]byte(mutated(t, `"min_from":"0.1.0",`, "")))
	if err != nil || without.MinFrom != "" {
		t.Fatalf("a manifest without min_from: %+v %v", without, err)
	}
}

// Every rule of the manifest at its boundary: the value one step inside is
// taken, the value one step outside is MANIFEST_INVALID.
func TestReleaseManifestBoundaries(t *testing.T) {
	artifact := func(size string) string {
		return mutated(t, `"size":15204352`, `"size":`+size)
	}
	for _, c := range []struct {
		name     string
		manifest string
		ok       bool
	}{
		{"counter 1", mutated(t, `"counter":7`, `"counter":1`), true},
		{"counter 0", mutated(t, `"counter":7`, `"counter":0`), false},
		{"counter 2^53-1", mutated(t, `"counter":7`, `"counter":9007199254740991`), true},
		{"counter 2^53", mutated(t, `"counter":7`, `"counter":9007199254740992`), false},
		{"counter with 17 digits", mutated(t, `"counter":7`, `"counter":10000000000000000`), false},
		{"counter as a string", mutated(t, `"counter":7`, `"counter":"7"`), false},
		{"size 1", artifact("1"), true},
		{"size 0", artifact("0"), false},
		{"size 128 MiB", artifact("134217728"), true},
		{"size 128 MiB + 1", artifact("134217729"), false},
		{"service definition 1", mutated(t, `"service_definition":1`, `"service_definition":1`), true},
		{"service definition 0", mutated(t, `"service_definition":1`, `"service_definition":0`), false},
		{"service definition 2^53-1", mutated(t, `"service_definition":1`, `"service_definition":9007199254740991`), true},
		{"valid for 400 days", mutated(t, `"expires_at":"2027-04-01T12:00:00Z"`, `"expires_at":"2027-11-07T12:00:00Z"`), true},
		{"valid for 400 days and a second", mutated(t, `"expires_at":"2027-04-01T12:00:00Z"`, `"expires_at":"2027-11-07T12:00:01Z"`), false},
		{"valid for a second", mutated(t, `"expires_at":"2027-04-01T12:00:00Z"`, `"expires_at":"2026-10-03T12:00:01Z"`), true},
		{"valid for no time", mutated(t, `"expires_at":"2027-04-01T12:00:00Z"`, `"expires_at":"2026-10-03T12:00:00Z"`), false},
		{"expires before it is issued", mutated(t, `"expires_at":"2027-04-01T12:00:00Z"`, `"expires_at":"2026-10-03T11:59:59Z"`), false},
		{"issued on the first day of 1970", mutated(t, `"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z"`, `"issued_at":"1970-01-01T00:00:00Z","expires_at":"1970-01-02T00:00:00Z"`), true},
		{"issued in 1970 and valid until 2027", mutated(t, `"issued_at":"2026-10-03T12:00:00Z"`, `"issued_at":"1970-01-01T00:00:00Z"`), false},
		{"a version with nine digits", mutated(t, `"version":"0.1.1"`, `"version":"999999999.0.0"`), false},
		{"artifact for a platform twice", mutated(t, `"os":"windows","arch":"amd64","format":"executable","file":"vectory-0.1.1-windows-amd64.exe"`, `"os":"linux","arch":"amd64","format":"executable","file":"vectory-0.1.1-linux-amd64"`), false},
		{"no artifacts", strings.Replace(testManifest[:strings.Index(testManifest, `"artifacts"`)], `,"min_from":"0.1.0"`, "", 1) + `"artifacts":[]}`, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseReleaseManifest([]byte(c.manifest))
			if c.ok && err != nil {
				t.Fatalf("want a valid manifest, got %v", err)
			}
			if !c.ok {
				wantRefusal(t, err, "MANIFEST_INVALID")
			}
		})
	}
	// Every platform the format knows, once each: six builds.
	t.Run("all six platforms", func(t *testing.T) {
		var entries []string
		for _, goos := range []string{"linux", "darwin", "windows"} {
			for _, arch := range []string{"amd64", "arm64"} {
				file := fmt.Sprintf("vectory-0.1.1-%s-%s", goos, arch)
				if goos == "windows" {
					file += ".exe"
				}
				entries = append(entries, fmt.Sprintf(`{"os":"%s","arch":"%s","format":"executable","file":"%s","size":1,"sha256":"%s"}`, goos, arch, file, strings.Repeat("a", 64)))
			}
		}
		manifest := `{"schema":"vectory.agent-release.v1","version":"0.1.1","counter":7,"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z","service_definition":1,"artifacts":[` + strings.Join(entries, ",") + `]}`
		parsed, err := ParseReleaseManifest([]byte(manifest))
		if err != nil || len(parsed.Artifacts) != 6 {
			t.Fatalf("%+v %v", parsed, err)
		}
	})
}

func TestReleaseManifestSizeBounds(t *testing.T) {
	pad := func(total int) []byte {
		body := strings.TrimSuffix(testManifest, "}")
		padding := total - len(body) - 1
		if padding < 0 {
			t.Fatalf("the manifest is longer than %d bytes", total)
		}
		return []byte(body + strings.Repeat(" ", padding) + "}")
	}
	if _, err := ParseReleaseManifest(pad(MaxReleaseManifest)); err != nil {
		t.Fatalf("exactly 16 KiB: %v", err)
	}
	// The final line feed counts toward the limit.
	if _, err := ParseReleaseManifest(append(pad(MaxReleaseManifest-1), '\n')); err != nil {
		t.Fatalf("16 KiB with its line feed: %v", err)
	}
	_, err := ParseReleaseManifest(append(pad(MaxReleaseManifest), '\n'))
	wantRefusal(t, err, "MANIFEST_INVALID")
	_, err = ParseReleaseManifest(pad(MaxReleaseManifest + 1))
	wantRefusal(t, err, "MANIFEST_INVALID")
}

// The profile of the signed files, one rule at a time. Spaces between tokens are
// fine; nothing else is whitespace.
func TestReleaseProfile(t *testing.T) {
	bs := string(rune(92)) // a backslash
	deep := strings.Repeat(`{"a":`, 16) + `1` + strings.Repeat(`}`, 16)
	tooDeep := strings.Repeat(`{"a":`, 17) + `1` + strings.Repeat(`}`, 17)
	for _, c := range []struct {
		name  string
		input string
		ok    bool
	}{
		{"an empty object", `{}`, true},
		{"spaces around every token", `{ "a" : [ 1 , "x" , { } , [ ] ] }`, true},
		{"a final line feed", "{}\n", true},
		{"two final line feeds", "{}\n\n", false},
		{"a carriage return", "{}\r\n", false},
		{"nothing", ``, false},
		{"only a line feed", "\n", false},
		{"a leading space", ` {}`, false},
		{"a trailing space", `{} `, false},
		{"a trailing space before the line feed", "{} \n", false},
		{"a leading line feed", "\n{}", false},
		{"a tab between tokens", "{\t}", false},
		{"a line feed between tokens", "{\n}", false},
		{"a byte order mark", "\xef\xbb\xbf{}", false},
		{"a NUL", "{\x00}", false},
		{"DEL", "{\x7f}", false},
		{"a byte above ASCII", "{\"a\":\"\xc3\xa9\"}", false},
		{"a backslash in a value", `{"a":"x` + bs + `ny"}`, false},
		{"a backslash in a name", `{"a` + bs + `u0041":1}`, false},
		{"an escaped quote", `{"a":"x` + bs + `"y"}`, false},
		{"an escaped surrogate pair", `{"a":"` + bs + `ud83d` + bs + `ude00"}`, false},
		{"a lone escaped surrogate", `{"a":"` + bs + `ud83d"}`, false},
		{"a lone low surrogate", `{"a":"` + bs + `ude00"}`, false},
		{"an escaped slash", `{"a":"` + bs + `/"}`, false},
		{"a second object", `{}{}`, false},
		{"data after the object", `{} x`, false},
		{"an array at the top", `[]`, false},
		{"a string at the top", `"a"`, false},
		{"a duplicate member", `{"a":1,"a":2}`, false},
		{"a duplicate member of different types", `{"a":1,"a":"x"}`, false},
		{"a duplicate member in a nested object", `{"a":{"b":1,"b":2}}`, false},
		{"the same name in different objects", `{"a":{"b":1},"c":{"b":2}}`, true},
		{"a duplicate member in an array's object", `{"a":[{"b":1,"b":1}]}`, false},
		{"zero", `{"a":0}`, true},
		{"a number with a leading zero", `{"a":07}`, false},
		{"a double zero", `{"a":00}`, false},
		{"negative zero", `{"a":-0}`, false},
		{"a negative number", `{"a":-1}`, false},
		{"a plus sign", `{"a":+1}`, false},
		{"an exponent", `{"a":1e2}`, false},
		{"a capital exponent", `{"a":1E2}`, false},
		{"a fraction", `{"a":7.0}`, false},
		{"a trailing point", `{"a":7.}`, false},
		{"a leading point", `{"a":.5}`, false},
		{"hexadecimal", `{"a":0x10}`, false},
		{"2^53-1", `{"a":9007199254740991}`, true},
		{"2^53", `{"a":9007199254740992}`, false},
		{"twenty digits", `{"a":12345678901234567890}`, false},
		{"true", `{"a":true}`, false},
		{"false", `{"a":false}`, false},
		{"null", `{"a":null}`, false},
		{"a trailing comma in an object", `{"a":1,}`, false},
		{"a trailing comma in an array", `{"a":[1,]}`, false},
		{"a leading comma in an array", `{"a":[,1]}`, false},
		{"a missing comma", `{"a":1 "b":2}`, false},
		{"a missing colon", `{"a" 1}`, false},
		{"single quotes", `{'a':1}`, false},
		{"an unquoted name", `{a:1}`, false},
		{"an unterminated string", `{"a":"x}`, false},
		{"an unclosed object", `{"a":1`, false},
		{"an unclosed array", `{"a":[1}`, false},
		{"a comment", `{"a":1 /* x */}`, false},
		{"a name that is not a string", `{1:1}`, false},
		{"nesting of 16 levels", deep, true},
		{"nesting of 17 levels", tooDeep, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseReleaseProfile([]byte(c.input), MaxReleaseManifest)
			if c.ok != (err == nil) {
				t.Fatalf("%q: accepted=%v, error %v", c.input, err == nil, err)
			}
		})
	}
}

func TestReleaseVersions(t *testing.T) {
	for text, want := range map[string]ReleaseVersion{
		"0.0.0":                 {},
		"0.1.0":                 {0, 1, 0},
		"0.1.10":                {0, 1, 10},
		"10.20.30":              {10, 20, 30},
		"999999999.0.999999999": {999999999, 0, 999999999},
	} {
		got, err := ParseReleaseVersion(text)
		if err != nil || got != want || got.String() != text {
			t.Errorf("%q: %+v %v", text, got, err)
		}
	}
	for _, text := range []string{"", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-rc.1", "1.2.3+build", "v1.2.3", " 1.2.3", "1.2.3 ", "1..3", "a.b.c", "1.2.-3", "1.2.+3", "1.2.3\n", "1000000000.0.0", "1.2.1e2", "١.٢.٣"} {
		if _, err := ParseReleaseVersion(text); err == nil {
			t.Errorf("%q is not a version", text)
		}
	}
	order := []string{"0.0.9", "0.1.0", "0.1.9", "0.1.10", "0.2.0", "1.0.0", "10.0.0"}
	for i := range order {
		for j := range order {
			a, _ := ParseReleaseVersion(order[i])
			b, _ := ParseReleaseVersion(order[j])
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := a.Compare(b); got != want {
				t.Errorf("%s compared with %s is %d, want %d", order[i], order[j], got, want)
			}
		}
	}
}

func TestReleaseInstants(t *testing.T) {
	for text, want := range map[string]time.Time{
		"1970-01-01T00:00:00Z": time.Unix(0, 0).UTC(),
		"2024-02-29T23:59:59Z": time.Date(2024, 2, 29, 23, 59, 59, 0, time.UTC),
		"2000-02-29T00:00:00Z": time.Date(2000, 2, 29, 0, 0, 0, 0, time.UTC),
		"9999-12-31T23:59:59Z": time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC),
	} {
		got, ok := parseReleaseInstant(text)
		if !ok || !got.Equal(want) || formatReleaseInstant(got) != text {
			t.Errorf("%q: %v %v", text, got, ok)
		}
	}
	for _, text := range []string{
		"", "2026-10-03", "2026-10-03T12:00:00", "2026-10-03T12:00:00z", "2026-10-03t12:00:00Z", "2026-10-03 12:00:00Z",
		"2026-10-03T12:00:00+00:00", "2026-10-03T12:00:00.5Z", "2026-10-03T12:00Z", "2026-10-03T12:00:00ZZ", " 2026-10-03T12:00:00Z",
		"2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-00-10T00:00:00Z",
		"2026-13-10T00:00:00Z", "2026-10-00T00:00:00Z", "2026-10-32T00:00:00Z", "2026-10-03T24:00:00Z", "2026-10-03T12:60:00Z",
		"2026-10-03T12:00:60Z", "1969-12-31T23:59:59Z", "0000-01-01T00:00:00Z", "2026-1-3T12:00:00Z", "+026-10-03T12:00:00Z",
		"2026-10-03T12:00:0٠Z",
	} {
		if _, ok := parseReleaseInstant(text); ok {
			t.Errorf("%q is not an instant", text)
		}
	}
}

// ---------------------------------------------------------------- the detached signatures

func TestReleaseSignatureFileRoundTrip(t *testing.T) {
	first := testPublicKey(t, testPrivateKey(t, 1), "one")
	second := testPublicKey(t, testPrivateKey(t, 2), "two")
	entries := []ReleaseSignature{
		releaseSignatureBy(first, bytes.Repeat([]byte{1}, 64)),
		releaseSignatureBy(second, bytes.Repeat([]byte{2}, 64)),
	}
	file, err := BuildReleaseSignatures(entries)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(file, []byte("]}\n")) || bytes.Count(file, []byte("\n")) != 1 || bytes.Contains(file, []byte(" ")) {
		t.Fatalf("the file is one line without spaces: %q", file)
	}
	parsed, err := ParseReleaseSignatures(file)
	if err != nil || !reflect.DeepEqual(parsed, entries) {
		t.Fatalf("%+v %v", parsed, err)
	}
	if _, err := BuildReleaseSignatures(nil); err == nil {
		t.Error("a file with no signatures is refused")
	}
	if _, err := BuildReleaseSignatures([]ReleaseSignature{entries[0], entries[0]}); err == nil {
		t.Error("a file that names a key twice is refused")
	}
	var five []ReleaseSignature
	for i := 0; i < 5; i++ {
		five = append(five, releaseSignatureBy(testPublicKey(t, testPrivateKey(t, byte(10+i)), "k"), bytes.Repeat([]byte{3}, 64)))
	}
	if _, err := BuildReleaseSignatures(five[:4]); err != nil {
		t.Errorf("four signatures: %v", err)
	}
	if _, err := BuildReleaseSignatures(five); err == nil {
		t.Error("five signatures are refused")
	}
}

func TestReleaseSignatureFileBounds(t *testing.T) {
	entry := func(i int) string {
		return fmt.Sprintf(`{"key":"%064x","signature":"%s"}`, i, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 64)))
	}
	file := func(padding int) []byte {
		return []byte(`{"schema":"vectory.agent-release-signatures.v1","signatures":[` + entry(1) + `]` + strings.Repeat(" ", padding) + `}`)
	}
	base := len(file(0))
	if _, err := ParseReleaseSignatures(file(MaxReleaseSignatures - base)); err != nil {
		t.Fatalf("exactly 4 KiB: %v", err)
	}
	_, err := ParseReleaseSignatures(file(MaxReleaseSignatures - base + 1))
	wantRefusal(t, err, "SIGNATURE_INVALID")
}

// ---------------------------------------------------------------- the decision

func TestVerifyReleaseTakesAGoodOffer(t *testing.T) {
	input, _, public := signedHost(t, testManifest)
	input.Floors = map[string]uint64{public.Fingerprint(): 6}
	before := copyFloors(input.Floors)
	verified, err := VerifyRelease(input)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Signer().Fingerprint() != public.Fingerprint() || len(verified.Signers) != 1 {
		t.Errorf("signers %+v", verified.Signers)
	}
	if verified.Manifest.Version != "0.1.1" || verified.Artifact.File != "vectory-0.1.1-linux-amd64" || verified.ManifestSHA256 != Digest(input.Manifest) {
		t.Errorf("%+v", verified)
	}
	if len(verified.Pins) != 1 || verified.Pins[0] != public {
		t.Errorf("pins %+v", verified.Pins)
	}
	if verified.Floors[public.Fingerprint()] != 7 {
		t.Errorf("floors %v: the signer's floor is raised to the counter", verified.Floors)
	}
	if !reflect.DeepEqual(input.Floors, before) {
		t.Errorf("the input's floors changed: %v", input.Floors)
	}
}

func copyFloors(in map[string]uint64) map[string]uint64 {
	out := map[string]uint64{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

// A release is checked against the floor of every key that signed it: the
// counter floor is raised only by taking the release, never by looking at it.
func TestVerifyReleaseDoesNotRaiseFloorsOfARefusedRelease(t *testing.T) {
	input, _, public := signedHost(t, testManifest)
	input.RunningVersion = "0.1.1"
	_, err := VerifyRelease(input)
	wantRefusal(t, err, "ALREADY_RUNNING")
	input.RunningVersion = "0.1.0"
	input.Floors = map[string]uint64{public.Fingerprint(): 7}
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "COUNTER_REPLAYED")
	if input.Floors[public.Fingerprint()] != 7 {
		t.Errorf("floors %v", input.Floors)
	}
}

func TestVerifyReleaseRefusesARollbackItAlreadyTried(t *testing.T) {
	input, _, public := signedHost(t, testManifest)
	input.Floors = map[string]uint64{public.Fingerprint(): 7}
	digest := Digest(input.Manifest)
	for _, c := range []struct {
		name string
		last *ReleaseResult
		code string
	}{
		{"nothing before", nil, "COUNTER_REPLAYED"},
		{"rolled back", &ReleaseResult{Release: digest, Outcome: "rolled_back"}, "RELEASE_ALREADY_TRIED"},
		{"committed", &ReleaseResult{Release: digest, Outcome: "committed"}, "COUNTER_REPLAYED"},
		{"failed", &ReleaseResult{Release: digest, Outcome: "failed"}, "COUNTER_REPLAYED"},
		{"another release rolled back", &ReleaseResult{Release: strings.Repeat("0", 64), Outcome: "rolled_back"}, "COUNTER_REPLAYED"},
	} {
		input.Last = c.last
		_, err := VerifyRelease(input)
		if refusal := wantRefusal(t, err, c.code); c.code == "RELEASE_ALREADY_TRIED" && !strings.Contains(refusal.Detail, "tried here and rolled back") {
			t.Errorf("%s: %s", c.name, refusal.Detail)
		}
	}
}

// A release's counter can never be at or below the floor of any key that signed
// it, so a second signature does not hide a replay.
func TestVerifyReleaseChecksEverySignersFloor(t *testing.T) {
	first, second := testPrivateKey(t, 1), testPrivateKey(t, 2)
	firstKey, secondKey := testPublicKey(t, first, "one"), testPublicKey(t, second, "two")
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{
		releaseSignatureBy(firstKey, first.SignRelease([]byte(testManifest))),
		releaseSignatureBy(secondKey, second.SignRelease([]byte(testManifest))),
	})
	if err != nil {
		t.Fatal(err)
	}
	input := VerifyInput{
		Manifest: []byte(testManifest), Signatures: signatures, Pins: []ReleaseKey{firstKey, secondKey}, Now: testNow,
		RunningVersion: "0.1.0", OS: "linux", Arch: "amd64", Track: ReleaseTrackPatch, ServiceDefinition: 1,
	}
	verified, err := VerifyRelease(input)
	if err != nil || len(verified.Signers) != 2 || verified.Signer() != firstKey {
		t.Fatalf("%+v %v", verified, err)
	}
	if verified.Floors[firstKey.Fingerprint()] != 7 || verified.Floors[secondKey.Fingerprint()] != 7 {
		t.Errorf("both signers' floors are raised: %v", verified.Floors)
	}
	input.Floors = map[string]uint64{secondKey.Fingerprint(): 8}
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "COUNTER_REPLAYED")
}

func TestVerifyReleaseTracksAndVersions(t *testing.T) {
	for _, c := range []struct {
		name, running, release, track, minFrom, code string
	}{
		{"a newer patch on the patch track", "0.1.0", "0.1.1", "patch", "", ""},
		{"a newer patch on the minor track", "0.1.0", "0.1.1", "minor", "", ""},
		{"a newer minor on the minor track", "0.1.5", "0.2.0", "minor", "", ""},
		{"a newer minor on the patch track", "0.1.5", "0.2.0", "patch", "", "VERSION_NOT_ON_TRACK"},
		{"a newer major on the minor track", "0.9.9", "1.0.0", "minor", "", "VERSION_NOT_ON_TRACK"},
		{"a newer major on the patch track", "0.9.9", "1.0.0", "patch", "", "VERSION_NOT_ON_TRACK"},
		{"a newer major with a lower minor on the minor track", "1.5.0", "2.0.0", "minor", "", "VERSION_NOT_ON_TRACK"},
		{"the same version", "0.1.1", "0.1.1", "patch", "", "ALREADY_RUNNING"},
		{"an older patch", "0.1.2", "0.1.1", "patch", "", "DOWNGRADE_REFUSED"},
		{"0.1.10 against 0.1.9 is newer", "0.1.9", "0.1.10", "patch", "", ""},
		{"0.1.9 against 0.1.10 is older", "0.1.10", "0.1.9", "patch", "", "DOWNGRADE_REFUSED"},
		{"a track that is not one", "0.1.0", "0.1.1", "major", "", "VERSION_NOT_ON_TRACK"},
		{"no track", "0.1.0", "0.1.1", "", "", "VERSION_NOT_ON_TRACK"},
		{"a running version with a pre-release", "0.1.0-dev", "0.1.1", "patch", "", "DOWNGRADE_REFUSED"},
		{"no running version", "", "0.1.1", "patch", "", "DOWNGRADE_REFUSED"},
		{"the minimum is the running version", "0.1.0", "0.1.1", "patch", "0.1.0", ""},
		{"the running version is below the minimum", "0.1.0", "0.1.1", "patch", "0.1.1", "AGENT_TOO_OLD"},
		{"the minimum compares as numbers", "0.1.9", "0.1.10", "patch", "0.1.10", "AGENT_TOO_OLD"},
	} {
		t.Run(c.name, func(t *testing.T) {
			manifest := `{"schema":"vectory.agent-release.v1","version":"` + c.release + `","counter":7,"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z",`
			if c.minFrom != "" {
				manifest += `"min_from":"` + c.minFrom + `",`
			}
			manifest += `"service_definition":1,"artifacts":[{"os":"linux","arch":"amd64","format":"executable","file":"vectory-` + c.release + `-linux-amd64","size":1,"sha256":"` + strings.Repeat("a", 64) + `"}]}`
			input, _, _ := signedHost(t, manifest)
			input.RunningVersion, input.Track = c.running, c.track
			_, err := VerifyRelease(input)
			if c.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			wantRefusal(t, err, c.code)
		})
	}
}

func TestVerifyReleaseNamesTheMajorTrackPlainly(t *testing.T) {
	input, _, _ := signedHost(t, testManifest)
	input.Track = "major"
	_, err := VerifyRelease(input)
	refusal := wantRefusal(t, err, "VERSION_NOT_ON_TRACK")
	if refusal.Detail != "This release offers patch and minor tracks. Upgrade to a new major version by hand." {
		t.Errorf("%q", refusal.Detail)
	}
	if _, err := ParseReleaseTrack("major"); err == nil || !IsInputError(err) || err.Error() != refusal.Detail {
		t.Errorf("%v", err)
	}
	for _, track := range []string{ReleaseTrackPatch, ReleaseTrackMinor} {
		if got, err := ParseReleaseTrack(track); err != nil || got != track {
			t.Errorf("%s: %q %v", track, got, err)
		}
	}
	for _, track := range []string{"", "Patch", "latest", "patch "} {
		if _, err := ParseReleaseTrack(track); err == nil {
			t.Errorf("%q is not a track", track)
		}
	}
}

func TestVerifyReleaseServiceDefinitionAndPlatform(t *testing.T) {
	input, _, _ := signedHost(t, mutated(t, `"service_definition":1`, `"service_definition":2`))
	_, err := VerifyRelease(input)
	wantRefusal(t, err, "SERVICE_DEFINITION_OUTDATED")
	input.ServiceDefinition = 2
	if _, err := VerifyRelease(input); err != nil {
		t.Errorf("a host that has the definition: %v", err)
	}
	input.ServiceDefinition = 3
	if _, err := VerifyRelease(input); err != nil {
		t.Errorf("a host with a newer definition: %v", err)
	}
	for _, c := range []struct{ os, arch string }{{"linux", "arm64"}, {"darwin", "amd64"}, {"", ""}, {"Linux", "amd64"}} {
		input.OS, input.Arch = c.os, c.arch
		_, err := VerifyRelease(input)
		wantRefusal(t, err, "PLATFORM_NOT_IN_RELEASE")
	}
}

func TestVerifyReleaseClockRules(t *testing.T) {
	input, _, _ := signedHost(t, testManifest)
	issued := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	expires := time.Date(2027, 4, 1, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name string
		now  time.Time
		code string
	}{
		{"the moment it is issued", issued, ""},
		{"a day before it is issued", issued.Add(-24 * time.Hour), ""},
		{"a day and a second before it is issued", issued.Add(-24*time.Hour - time.Second), "MANIFEST_INVALID"},
		{"a day and half a second before it is issued", issued.Add(-24*time.Hour - 500*time.Millisecond), "MANIFEST_INVALID"},
		{"half a second under a day before", issued.Add(-24*time.Hour + 500*time.Millisecond), ""},
		{"a second before it expires", expires.Add(-time.Second), ""},
		{"a millisecond before it expires", expires.Add(-time.Millisecond), ""},
		{"the moment it expires", expires, "MANIFEST_EXPIRED"},
		{"a day after it expires", expires.Add(24 * time.Hour), "MANIFEST_EXPIRED"},
		{"a clock in another zone", expires.In(time.FixedZone("far", 14*3600)), "MANIFEST_EXPIRED"},
	} {
		t.Run(c.name, func(t *testing.T) {
			input.Now = c.now
			_, err := VerifyRelease(input)
			if c.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			wantRefusal(t, err, c.code)
		})
	}
}

// A refusal's first match in the contract's order: the rules that come first
// decide, whatever else is wrong.
func TestVerifyReleaseOrder(t *testing.T) {
	input, _, public := signedHost(t, mutated(t, `"counter":7`, `"counter":0`))
	// A manifest that is invalid is refused for its content only when its signature holds.
	_, err := VerifyRelease(input)
	wantRefusal(t, err, "MANIFEST_INVALID")
	// With a broken signature the signature decides first.
	input.Manifest = append([]byte(nil), input.Manifest...)
	input.Manifest[10] ^= 1
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "SIGNATURE_INVALID")
	// No pinned key decides before the signature.
	input.Pins = nil
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "KEY_NOT_PINNED")
	// An unreadable signature file decides before the pins.
	input.Signatures = []byte("{}")
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "SIGNATURE_INVALID")
	// More than 8 statements decide before everything.
	input.Rollovers = make([]RolloverEnvelope, MaxRolloverChain+1)
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "MANIFEST_INVALID")
	_ = public
}

func TestVerifyReleaseFilesSaysNothingAboutTheHost(t *testing.T) {
	input, _, public := signedHost(t, testManifest)
	// A tool that has no host asks only whether the files hold together.
	input.OS, input.Arch, input.RunningVersion, input.Track, input.ServiceDefinition = "", "", "", "", 0
	input.Floors = map[string]uint64{public.Fingerprint(): 100}
	verified, err := VerifyReleaseFiles(input)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Manifest.Counter != 7 || verified.Signer() != public || verified.Artifact.File != "" {
		t.Errorf("%+v", verified)
	}
	// A floor above the counter is not lowered by looking at the files.
	if verified.Floors[public.Fingerprint()] != 100 {
		t.Errorf("floors %v: a floor only ever rises", verified.Floors)
	}
	// The signature and the manifest still decide.
	input.Manifest = []byte(strings.Replace(testManifest, `"counter":7`, `"counter":8`, 1))
	_, err = VerifyReleaseFiles(input)
	wantRefusal(t, err, "SIGNATURE_INVALID")
	input, _, _ = signedHost(t, testManifest)
	input.Now = time.Date(2027, 4, 1, 12, 0, 0, 0, time.UTC)
	_, err = VerifyReleaseFiles(input)
	wantRefusal(t, err, "MANIFEST_EXPIRED")
}

// The key named in a signature entry only selects which pinned key to try: a
// signature by one key under the name of another verifies against the named
// key's bytes, so it fails.
func TestVerifyReleaseUsesThePinnedKeysOwnBytes(t *testing.T) {
	team, outsider := testPrivateKey(t, 1), testPrivateKey(t, 3)
	teamKey := testPublicKey(t, team, "team")
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(teamKey, outsider.SignRelease([]byte(testManifest)))})
	if err != nil {
		t.Fatal(err)
	}
	input := VerifyInput{Manifest: []byte(testManifest), Signatures: signatures, Pins: []ReleaseKey{teamKey}, Now: testNow, RunningVersion: "0.1.0", OS: "linux", Arch: "amd64", Track: "patch", ServiceDefinition: 1}
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "SIGNATURE_INVALID")
}

// The signature is over the prefix and the bytes of the file, and nothing else:
// the same signature without the prefix, or with a rollover's prefix, is no
// signature of the release.
func TestReleaseSignaturesAreBoundToTheirPrefix(t *testing.T) {
	private := testPrivateKey(t, 1)
	public := testPublicKey(t, private, "team")
	manifest := []byte(testManifest)
	if !public.verify(releaseSignaturePrefix, manifest, private.SignRelease(manifest)) {
		t.Fatal("the release signature verifies")
	}
	bare := ed25519.Sign(private.signingKey(), manifest)
	if public.verify(releaseSignaturePrefix, manifest, bare) {
		t.Error("a signature without the prefix is accepted")
	}
	rollover := private.sign(rolloverSignaturePrefix, manifest)
	if public.verify(releaseSignaturePrefix, manifest, rollover) {
		t.Error("a signature with a rollover's prefix is accepted as a release")
	}
	if public.verify(rolloverSignaturePrefix, manifest, private.SignRelease(manifest)) {
		t.Error("a release signature is accepted as a rollover")
	}
	// The line feed a tool may add changes what is signed.
	if public.verify(releaseSignaturePrefix, append(manifest, '\n'), private.SignRelease(manifest)) {
		t.Error("a signature covers the bytes as they are")
	}
}

// ---------------------------------------------------------------- rollovers

func TestRolloverRoundTrip(t *testing.T) {
	oldKey, newKey := testPrivateKey(t, 1), testPrivateKey(t, 2)
	oldPublic, newPublic := testPublicKey(t, oldKey, "team"), testPublicKey(t, newKey, "team-next")
	issued := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	envelope, err := SignRollover(oldKey, newPublic, issued)
	if err != nil {
		t.Fatal(err)
	}
	statement, _ := base64.StdEncoding.DecodeString(envelope.Statement)
	want := `{"schema":"vectory.release-key-rollover.v1","from":"` + oldPublic.Fingerprint() + `","to":"` + newPublic.Line() + `","issued_at":"2026-11-02T09:00:00Z"}`
	if string(statement) != want {
		t.Fatalf("the statement is\n%s\nwant\n%s", statement, want)
	}
	rollover, err := envelope.Parse()
	if err != nil {
		t.Fatal(err)
	}
	if rollover.From != oldPublic.Fingerprint() || rollover.To != newPublic || !rollover.IssuedAt.Equal(issued) {
		t.Errorf("%+v", rollover)
	}
	if !rollover.VerifiedBy(oldPublic) || rollover.VerifiedBy(newPublic) {
		t.Error("only the key it replaces verifies the statement")
	}
	// An envelope is JSON with the contract's member names.
	encoded, _ := json.Marshal(envelope)
	if !strings.HasPrefix(string(encoded), `{"statement":"`) || !strings.Contains(string(encoded), `","signature":"`) {
		t.Errorf("%s", encoded)
	}
	if _, err := SignRollover(oldKey, oldPublic, issued); err == nil {
		t.Error("a key can't replace itself")
	}
	if _, err := SignRollover(ReleasePrivateKey{}, newPublic, issued); err == nil {
		t.Error("a rollover needs a key")
	}
}

func TestRolloverEnvelopesAreStrict(t *testing.T) {
	oldKey, newKey := testPrivateKey(t, 1), testPrivateKey(t, 2)
	envelope, err := SignRollover(oldKey, testPublicKey(t, newKey, "next"), testNow)
	if err != nil {
		t.Fatal(err)
	}
	for name, broken := range map[string]RolloverEnvelope{
		"a line feed inside the statement":   {Statement: envelope.Statement[:8] + "\n" + envelope.Statement[8:], Signature: envelope.Signature},
		"the URL alphabet":                   {Statement: base64.URLEncoding.EncodeToString([]byte{0xfb, 0xff, 0xfe}), Signature: envelope.Signature},
		"a signature of 63 bytes":            {Statement: envelope.Statement, Signature: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 63))},
		"a signature of 65 bytes":            {Statement: envelope.Statement, Signature: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 65))},
		"a statement without padding":        {Statement: strings.TrimRight(envelope.Statement, "="), Signature: envelope.Signature},
		"an empty statement":                 {Statement: "", Signature: envelope.Signature},
		"a statement that is not JSON":       {Statement: base64.StdEncoding.EncodeToString([]byte("hello")), Signature: envelope.Signature},
		"a statement larger than 1 KiB":      {Statement: base64.StdEncoding.EncodeToString(append([]byte(`{"a":"`), append(bytes.Repeat([]byte("x"), 1100), '"', '}')...)), Signature: envelope.Signature},
		"a signature with whitespace":        {Statement: envelope.Statement, Signature: envelope.Signature + "\n"},
		"a signature of nothing but padding": {Statement: envelope.Statement, Signature: "===="},
	} {
		if _, err := broken.Parse(); err == nil {
			t.Errorf("%s is accepted", name)
		}
	}
	// A statement whose bytes are fine but whose members are not.
	statement := func(text string) RolloverEnvelope {
		return RolloverEnvelope{Statement: base64.StdEncoding.EncodeToString([]byte(text)), Signature: envelope.Signature}
	}
	good, _ := base64.StdEncoding.DecodeString(envelope.Statement)
	for name, text := range map[string]string{
		"another schema":               strings.Replace(string(good), "release-key-rollover.v1", "release-key-rollover.v2", 1),
		"an uppercase from":            strings.Replace(string(good), `"from":"`+oldFingerprint(t, oldKey), `"from":"`+strings.ToUpper(oldFingerprint(t, oldKey)), 1),
		"a short from":                 strings.Replace(string(good), `"from":"`+oldFingerprint(t, oldKey), `"from":"`+oldFingerprint(t, oldKey)[:63], 1),
		"a bad instant":                strings.Replace(string(good), `2026-10-10T00:00:00Z`, `2026-10-10 00:00:00Z`, 1),
		"an extra member":              strings.Replace(string(good), `}`, `,"x":1}`, 1),
		"a missing member":             strings.Replace(string(good), `,"issued_at":"2026-10-10T00:00:00Z"`, "", 1),
		"a duplicate member":           strings.Replace(string(good), `}`, `,"from":"`+oldFingerprint(t, oldKey)+`"}`, 1),
		"a successor that is a number": strings.Replace(string(good), `"to":"`+testPublicKey(t, newKey, "next").Line()+`"`, `"to":1`, 1),
	} {
		if text == string(good) {
			t.Fatalf("%s: the replacement changed nothing", name)
		}
		if _, err := statement(text).Parse(); err == nil {
			t.Errorf("%s is accepted", name)
		}
	}
}

func oldFingerprint(t *testing.T, key ReleasePrivateKey) string {
	t.Helper()
	return key.Fingerprint()
}

func TestRolloverWithAKeyOfSmallOrderIsRefused(t *testing.T) {
	oldKey := testPrivateKey(t, 1)
	small := base64.StdEncoding.EncodeToString(smallOrderEncodings[2][:])
	statement := `{"schema":"vectory.release-key-rollover.v1","from":"` + oldKey.Fingerprint() + `","to":"vectory-release-key ed25519 ` + small + ` small","issued_at":"2026-11-02T09:00:00Z"}`
	signature := oldKey.sign(rolloverSignaturePrefix, []byte(statement))
	_, err := ParseRollover([]byte(statement), signature)
	wantRefusal(t, err, "RELEASE_KEY_INVALID")
}

// A chain follows from a pinned key, one statement after another; the pins and
// the floors move to the successors.
func TestRolloverChain(t *testing.T) {
	private := []ReleasePrivateKey{testPrivateKey(t, 1), testPrivateKey(t, 2), testPrivateKey(t, 3)}
	public := []ReleaseKey{testPublicKey(t, private[0], "a"), testPublicKey(t, private[1], "b"), testPublicKey(t, private[2], "c")}
	first, _ := SignRollover(private[0], public[1], testNow)
	second, _ := SignRollover(private[1], public[2], testNow)

	input := signedBy(t, testManifest, private[2], public[2])
	input.Pins = []ReleaseKey{public[0]}
	input.Floors = map[string]uint64{public[0].Fingerprint(): 4}
	input.Rollovers = []RolloverEnvelope{first, second}
	verified, err := VerifyRelease(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(verified.Pins) != 1 || verified.Pins[0] != public[2] {
		t.Errorf("pins %+v", verified.Pins)
	}
	if !reflect.DeepEqual(verified.Floors, map[string]uint64{public[2].Fingerprint(): 7}) {
		t.Errorf("floors %v: the first key's floor moved on, and the signer's rose to 7", verified.Floors)
	}
	// The floor of the key that was left carries to the end of the chain.
	input.Floors = map[string]uint64{public[0].Fingerprint(): 7}
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "COUNTER_REPLAYED")
	// The statements out of order don't connect.
	input.Floors = nil
	input.Rollovers = []RolloverEnvelope{second, first}
	_, err = VerifyRelease(input)
	wantRefusal(t, err, "KEY_NOT_PINNED")
	// Following a chain changes nothing in the input.
	if len(input.Pins) != 1 || input.Pins[0] != public[0] {
		t.Error("the input's pins changed")
	}
}

func TestRolloverForkNeedsTwoVerifyingStatementsFromOnePinnedKey(t *testing.T) {
	oldKey, nextA, nextB, outsider := testPrivateKey(t, 1), testPrivateKey(t, 2), testPrivateKey(t, 3), testPrivateKey(t, 4)
	oldPublic := testPublicKey(t, oldKey, "old")
	toA, toB := testPublicKey(t, nextA, "a"), testPublicKey(t, nextB, "b")
	statementA, _ := SignRollover(oldKey, toA, testNow)
	statementB, _ := SignRollover(oldKey, toB, testNow)
	forged, _ := SignRollover(outsider, toB, testNow)
	// A statement that names the old key but is signed by another does not verify:
	// swap the "from" of a forged statement for the old key's.
	forgedBytes, _ := base64.StdEncoding.DecodeString(forged.Statement)
	rewritten := strings.Replace(string(forgedBytes), outsider.Fingerprint(), oldKey.Fingerprint(), 1)
	forgedEnvelope := RolloverEnvelope{Statement: base64.StdEncoding.EncodeToString([]byte(rewritten)), Signature: forged.Signature}

	input := signedBy(t, testManifest, nextA, toA)
	input.Pins = []ReleaseKey{oldPublic}
	input.Rollovers = []RolloverEnvelope{statementA, statementB}
	_, err := VerifyRelease(input)
	refusal := wantRefusal(t, err, "KEY_ROLLOVER_CONFLICT")
	want := []string{toA.Fingerprint(), toB.Fingerprint()}
	sort.Strings(want)
	if refusal.From != oldPublic.Fingerprint() || !reflect.DeepEqual(refusal.Successors, want) {
		t.Errorf("%+v", refusal)
	}
	// The same two in the other order name the same two successors, in ascending order.
	input.Rollovers = []RolloverEnvelope{statementB, statementA}
	_, err = VerifyRelease(input)
	if again := wantRefusal(t, err, "KEY_ROLLOVER_CONFLICT"); !reflect.DeepEqual(again.Successors, want) {
		t.Errorf("%+v", again)
	}
	// The same statement twice, and two statements for the same successor, are not a fork.
	input.Rollovers = []RolloverEnvelope{statementA, statementA}
	if _, err = VerifyRelease(input); err != nil {
		t.Errorf("the same statement twice: %v", err)
	}
	// A statement the pinned key did not sign is no fork.
	input.Rollovers = []RolloverEnvelope{statementA, forgedEnvelope}
	if _, err = VerifyRelease(input); err != nil {
		t.Errorf("a forged second statement: %v", err)
	}
	// After A has been followed, a later statement from the old key is ignored.
	input.Rollovers = []RolloverEnvelope{statementA, statementB}
	input.Pins = []ReleaseKey{oldPublic}
	followed := input
	followed.Rollovers = []RolloverEnvelope{statementA}
	if _, err = VerifyRelease(followed); err != nil {
		t.Errorf("one statement: %v", err)
	}
	// A host that already pinned the successor, with the old statements still in the
	// offer, is not frozen: the old key isn't pinned any more.
	already := signedBy(t, testManifest, nextA, toA)
	already.Rollovers = []RolloverEnvelope{statementA, statementB}
	if _, err = VerifyRelease(already); err != nil {
		t.Errorf("a host that left the old key: %v", err)
	}
}

// BuildReleaseManifest writes the form the server writes, and what it writes
// reads back as the manifest it was given.
func TestBuildReleaseManifestWritesTheServersForm(t *testing.T) {
	parsed, err := ParseReleaseManifest([]byte(testManifest))
	if err != nil {
		t.Fatal(err)
	}
	built, err := BuildReleaseManifest(parsed)
	if err != nil || string(built) != testManifest {
		t.Fatalf("%s %v", built, err)
	}
	// Without a minimum version the member is left out.
	parsed.MinFrom = ""
	built, err = BuildReleaseManifest(parsed)
	if err != nil || strings.Contains(string(built), "min_from") || string(built) != strings.Replace(testManifest, `"min_from":"0.1.0",`, "", 1) {
		t.Fatalf("%s %v", built, err)
	}
	// Nothing is written that a host would refuse.
	for name, damage := range map[string]func(*ReleaseManifest){
		"a version with a suffix":    func(m *ReleaseManifest) { m.Version = "0.1.1-rc.1" },
		"a counter of zero":          func(m *ReleaseManifest) { m.Counter = 0 },
		"no builds":                  func(m *ReleaseManifest) { m.Artifacts = nil },
		"a file of another name":     func(m *ReleaseManifest) { m.Artifacts[0].File = "vectory" },
		"a member smuggled in":       func(m *ReleaseManifest) { m.Version = `0.1.1","counter":9,"x":"` },
		"an expiry before the issue": func(m *ReleaseManifest) { m.ExpiresAt = m.IssuedAt },
		"a build over 128 MiB":       func(m *ReleaseManifest) { m.Artifacts[0].Size = 128*1024*1024 + 1 },
	} {
		damaged := parsed
		damaged.Artifacts = append([]ReleaseArtifact(nil), parsed.Artifacts...)
		damage(&damaged)
		if built, err := BuildReleaseManifest(damaged); err == nil {
			t.Errorf("%s: wrote %s", name, built)
		}
	}
	// Every manifest of the vectors that parses is written back as a manifest that
	// parses to the same thing.
	for _, vector := range loadReleaseVectors(t).Cases {
		raw, _ := base64.StdEncoding.DecodeString(vector.ManifestB64)
		manifest, err := ParseReleaseManifest(raw)
		if err != nil {
			continue
		}
		built, err := BuildReleaseManifest(manifest)
		if err != nil {
			t.Fatalf("%s: %v", vector.Name, err)
		}
		again, err := ParseReleaseManifest(built)
		if err != nil || !reflect.DeepEqual(again, manifest) {
			t.Errorf("%s: %+v %v", vector.Name, again, err)
		}
	}
}

// ---------------------------------------------------------------- the published examples

// The tools write what the contract shows. The examples come from a reference
// implementation and the published test key, so the same key, the same bytes and
// the same time give the same files, to the byte.
func TestSigningToolsReproduceThePublishedExamples(t *testing.T) {
	const examples = "contracts/fixtures/agent-release/examples/"
	private, err := ParseReleasePrivateKey(repoFile(t, examples+"team-private-key.txt"))
	if err != nil {
		t.Fatal(err)
	}
	public, err := ParseReleaseKey(strings.TrimSuffix(string(repoFile(t, examples+"team.pub")), "\n"))
	if err != nil || public.Fingerprint() != private.Fingerprint() {
		t.Fatalf("the example's key pair: %v", err)
	}

	// release.json: the builder writes the example from its fields, and the
	// signature covers it without the line feed the example file ends with.
	manifest := bytes.TrimSuffix(repoFile(t, examples+"release.json"), []byte("\n"))
	parsedManifest, err := ParseReleaseManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if built, err := BuildReleaseManifest(parsedManifest); err != nil || !bytes.Equal(built, manifest) {
		t.Errorf("release.json\n got %s\nwant %s (%v)", built, manifest, err)
	}
	file, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(public, private.SignRelease(manifest))})
	if err != nil {
		t.Fatal(err)
	}
	if want := repoFile(t, examples+"release.json.sig"); !bytes.Equal(file, want) {
		t.Errorf("release.json.sig\n got %s\nwant %s", file, want)
	}

	// The rollover statement and its envelope.
	var statement struct {
		To       string `json:"to"`
		IssuedAt string `json:"issued_at"`
	}
	if err := json.Unmarshal(repoFile(t, examples+"rollover.json"), &statement); err != nil {
		t.Fatal(err)
	}
	next, err := ParseReleaseKey(statement.To)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := time.Parse(time.RFC3339, statement.IssuedAt)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := SignRollover(private, next, issued)
	if err != nil {
		t.Fatal(err)
	}
	var published RolloverEnvelope
	if err := json.Unmarshal(repoFile(t, examples+"rollover-envelope.json"), &published); err != nil {
		t.Fatal(err)
	}
	if envelope != published {
		t.Errorf("the rollover envelope\n got %+v\nwant %+v", envelope, published)
	}
	if statementBytes, _ := base64.StdEncoding.DecodeString(envelope.Statement); string(statementBytes) != strings.TrimSuffix(string(repoFile(t, examples+"rollover.json")), "\n") {
		t.Errorf("the statement is %s", statementBytes)
	}
}
