package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The signed files are read by a Rust server and by this code, and a byte string
// that one accepts and the other refuses is a hole. The profile that both
// check is small enough to be written a second way from the standard library's
// token stream, and the fuzz tests hold the parser to that second reading.

// FuzzParseReleaseManifest asserts that ParseReleaseManifest never accepts bytes
// outside the profile of the signed files, and that what it reads is what the
// standard decoder reads from the same bytes. The seeds are every manifest of
// the shared vectors.
func FuzzParseReleaseManifest(f *testing.F) {
	f.Add([]byte(testManifest))
	f.Add([]byte(testManifest + "\n"))
	for _, raw := range vectorFiles(f, func(c releaseCaseVector) string { return c.ManifestB64 }) {
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		manifest, err := ParseReleaseManifest(raw)
		if err != nil {
			var refusal *UpdateRefusal
			if !errors.As(err, &refusal) || refusal.Code != "MANIFEST_INVALID" || refusal.Detail == "" {
				t.Fatalf("a refusal of a manifest is MANIFEST_INVALID with a detail, got %v", err)
			}
			return
		}
		if inside, why := insideTheProfile(raw, MaxReleaseManifest); !inside {
			t.Fatalf("accepted bytes outside the profile (%s): %q", why, raw)
		}
		assertManifestMatchesDecoder(t, raw, manifest)
	})
}

// FuzzReleaseProfile compares the profile parser with the second reading in both
// directions: it accepts exactly the objects the second reading accepts.
func FuzzReleaseProfile(f *testing.F) {
	for _, seed := range []string{
		`{}`, `{ "a" : [ 1 , "x" , { } ] }`, "{}\n", `{"a":1,"a":2}`, `{"a":01}`, `{"a":-0}`, `{"a":1e2}`, `{"a":true}`,
		`{"a":9007199254740991}`, `{"a":9007199254740992}`, `{"a":"x"}x`, "{\"a\":\"\xc3\xa9\"}", `{"a":[1,]}`,
		strings.Repeat(`{"a":`, 16) + `1` + strings.Repeat(`}`, 16), strings.Repeat(`[`, 17) + strings.Repeat(`]`, 17),
		string(rune(92)) + "u0041", `{"a` + string(rune(92)) + `u0041":1}`,
	} {
		f.Add([]byte(seed))
	}
	for _, raw := range vectorFiles(f, func(c releaseCaseVector) string { return c.ManifestB64 }) {
		f.Add(raw)
	}
	for _, raw := range vectorFiles(f, func(c releaseCaseVector) string { return c.SignaturesB64 }) {
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		_, err := parseReleaseProfile(raw, MaxReleaseManifest)
		inside, why := insideTheProfile(raw, MaxReleaseManifest)
		if (err == nil) != inside {
			t.Fatalf("the parser says %v (%v) and the second reading says %v (%s): %q", err == nil, err, inside, why, raw)
		}
	})
}

// FuzzReleaseSignatureAndStatement holds the other two signed files to the same
// profile: whatever they accept is inside it.
func FuzzReleaseSignatureAndStatement(f *testing.F) {
	for _, raw := range vectorFiles(f, func(c releaseCaseVector) string { return c.SignaturesB64 }) {
		f.Add(raw)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if _, err := ParseReleaseSignatures(raw); err == nil {
			if inside, why := insideTheProfile(raw, MaxReleaseSignatures); !inside {
				t.Fatalf("signature file accepted outside the profile (%s): %q", why, raw)
			}
		}
		if _, err := ParseRollover(raw, make([]byte, 64)); err == nil {
			if inside, why := insideTheProfile(raw, MaxRolloverStatement); !inside {
				t.Fatalf("statement accepted outside the profile (%s): %q", why, raw)
			}
		}
	})
}

// FuzzParseReleaseKey holds the key line grammar and the key rule together to a
// second reading in both directions: a line is a key exactly when it has the
// contract's three fields, a canonical base64 of 32 bytes that is a point of the
// curve that is not of small order, and a name of the allowed characters. The
// reading uses a regular expression for the shape and the independent curve
// implementation of the key tests for the point.
func FuzzParseReleaseKey(f *testing.F) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "agent-release", "vectors.json"))
	if err != nil {
		f.Fatal(err)
	}
	var vectors releaseVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		f.Fatal(err)
	}
	for _, vector := range vectors.KeyLines {
		f.Add(vector.Line)
	}
	f.Add("vectory-release-key ed25519 " + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)) + " team")
	pattern := regexp.MustCompile(`^vectory-release-key ed25519 ([A-Za-z0-9+/=]+) ([\x20-\x7e]+)$`)
	f.Fuzz(func(t *testing.T, line string) {
		key, err := ParseReleaseKey(line)
		want := false
		var fingerprint string
		if match := pattern.FindStringSubmatch(line); match != nil {
			raw, decodeErr := base64.StdEncoding.DecodeString(match[1])
			name := match[2]
			var encoded [32]byte
			if decodeErr == nil && len(raw) == 32 && base64.StdEncoding.EncodeToString(raw) == match[1] &&
				len(name) <= 64 && !strings.ContainsAny(name, `"\`) && name[0] != ' ' && name[len(name)-1] != ' ' {
				copy(encoded[:], raw)
				if oracleAccepts(encoded) {
					want = true
					sum := sha256.Sum256(raw)
					fingerprint = hex.EncodeToString(sum[:])
				}
			}
		}
		if (err == nil) != want {
			t.Fatalf("%q: the parser says %v (%v) and the second reading says %v", line, err == nil, err, want)
		}
		if err == nil && (key.Fingerprint() != fingerprint || key.Line() != line) {
			t.Fatalf("%q: the key is %s %q", line, key.Fingerprint(), key.Line())
		}
		if err != nil {
			var refusal *UpdateRefusal
			if !errors.As(err, &refusal) || refusal.Code != "RELEASE_KEY_INVALID" {
				t.Fatalf("%q: %v", line, err)
			}
		}
	})
}

// vectorFiles decodes one base64 member of every case of the shared vectors.
func vectorFiles(f *testing.F, member func(releaseCaseVector) string) [][]byte {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", "agent-release", "vectors.json"))
	if err != nil {
		f.Fatal(err)
	}
	var vectors releaseVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		f.Fatal(err)
	}
	var files [][]byte
	for _, vector := range vectors.Cases {
		decoded, err := base64.StdEncoding.DecodeString(member(vector))
		if err != nil {
			f.Fatal(err)
		}
		files = append(files, decoded)
	}
	return files
}

// insideTheProfile is the profile of the signed files, read with encoding/json's
// token stream and nothing of the parser's code: printable ASCII except one
// final line feed, no backslash, one object that starts at the first byte and
// ends at the last, no member twice in any object, only strings, whole numbers
// written 0 or a digit 1 to 9 followed by digits and at most 2^53-1, arrays and
// objects, nesting of at most 16 levels, and a size within the limit.
func insideTheProfile(raw []byte, limit int) (bool, string) {
	if len(raw) == 0 || len(raw) > limit {
		return false, "the size"
	}
	body := bytes.TrimSuffix(raw, []byte("\n"))
	if len(body) == 0 || body[0] != '{' {
		return false, "the first byte"
	}
	for _, b := range body {
		if b < 0x20 || b > 0x7e || b == '\\' {
			return false, fmt.Sprintf("byte 0x%02x", b)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	type frame struct {
		object bool
		names  map[string]bool
		expect bool // the next token is a member name
	}
	var stack []*frame
	for {
		token, err := decoder.Token()
		if err != nil {
			return false, "the token stream: " + err.Error()
		}
		if len(stack) > 0 {
			if current := stack[len(stack)-1]; current.object && current.expect {
				if name, ok := token.(string); ok {
					if current.names[name] {
						return false, "a duplicate member"
					}
					current.names[name] = true
					current.expect = false
					continue
				}
			}
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{', '[':
				if len(stack) >= 16 {
					return false, "nesting"
				}
				stack = append(stack, &frame{object: value == '{', names: map[string]bool{}, expect: value == '{'})
				continue
			default:
				stack = stack[:len(stack)-1]
			}
		case json.Number:
			text := value.String()
			number, err := strconv.ParseUint(text, 10, 64)
			if err != nil || number > MaxJSONCounter || (len(text) > 1 && text[0] == '0') || strings.ContainsAny(text, "+-.eE") {
				return false, "the number " + text
			}
		case string:
		default:
			return false, fmt.Sprintf("a %T", value)
		}
		if len(stack) == 0 {
			break
		}
		if current := stack[len(stack)-1]; current.object {
			current.expect = true
		}
	}
	if decoder.InputOffset() != int64(len(body)) {
		return false, "data after the object"
	}
	return true, ""
}

// assertManifestMatchesDecoder reads the same bytes into a struct with the
// standard decoder, which refuses unknown members, and compares every field.
func assertManifestMatchesDecoder(t *testing.T, raw []byte, manifest ReleaseManifest) {
	t.Helper()
	var decoded struct {
		Schema            string  `json:"schema"`
		Version           string  `json:"version"`
		Counter           uint64  `json:"counter"`
		IssuedAt          string  `json:"issued_at"`
		ExpiresAt         string  `json:"expires_at"`
		MinFrom           *string `json:"min_from"`
		ServiceDefinition uint64  `json:"service_definition"`
		Artifacts         []struct {
			OS     string `json:"os"`
			Arch   string `json:"arch"`
			Format string `json:"format"`
			File   string `json:"file"`
			Size   uint64 `json:"size"`
			SHA256 string `json:"sha256"`
		} `json:"artifacts"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("the standard decoder refuses an accepted manifest: %v: %q", err, raw)
	}
	minFrom := ""
	if decoded.MinFrom != nil {
		minFrom = *decoded.MinFrom
	}
	if decoded.Schema != "vectory.agent-release.v1" || decoded.Version != manifest.Version || decoded.Counter != manifest.Counter ||
		formatReleaseInstant(manifest.IssuedAt) != decoded.IssuedAt || formatReleaseInstant(manifest.ExpiresAt) != decoded.ExpiresAt ||
		minFrom != manifest.MinFrom || int64(decoded.ServiceDefinition) != manifest.ServiceDefinition || len(decoded.Artifacts) != len(manifest.Artifacts) {
		t.Fatalf("the parser and the standard decoder read different manifests:\n%+v\n%+v\n%q", manifest, decoded, raw)
	}
	for i, artifact := range decoded.Artifacts {
		got := manifest.Artifacts[i]
		if artifact.OS != got.OS || artifact.Arch != got.Arch || artifact.Format != got.Format || artifact.File != got.File || int64(artifact.Size) != got.Size || artifact.SHA256 != got.SHA256 {
			t.Fatalf("artifact %d differs: %+v and %+v", i, artifact, got)
		}
	}
}
