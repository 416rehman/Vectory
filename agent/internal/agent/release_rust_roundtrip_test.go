package agent

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The server builds the manifest of a release in Rust and this package reads it
// in Go, so both must read the same bytes the same way.
// testdata/rust-built-release.json is what the server builds for one fixed
// input. The server's own tests fail when the file is stale, and
// VECTORY_UPDATE_GOLDEN=1 cargo test --lib agent_release, run in server/,
// rewrites it.

const rustBuiltReleaseCounter = 4503599627370497

func rustBuiltRelease(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "rust-built-release.json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func rustBuiltArtifacts() []ReleaseArtifact {
	return []ReleaseArtifact{
		{OS: "linux", Arch: "amd64", Format: "executable", File: "vectory-1.12.345-linux-amd64", Size: 15204352, SHA256: "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"},
		{OS: "linux", Arch: "arm64", Format: "executable", File: "vectory-1.12.345-linux-arm64", Size: 1, SHA256: strings.Repeat("0", 64)},
		{OS: "darwin", Arch: "arm64", Format: "executable", File: "vectory-1.12.345-darwin-arm64", Size: releaseBuildLimit, SHA256: strings.Repeat("f", 64)},
		{OS: "windows", Arch: "amd64", Format: "executable", File: "vectory-1.12.345-windows-amd64.exe", Size: 15892480, SHA256: "25043433d22cf8f6f5ffb531abb6a0b0fe0952af2bb946586b5868b4bdf4e201"},
	}
}

func TestRustBuiltReleaseIsReadFieldForField(t *testing.T) {
	raw := rustBuiltRelease(t)
	if raw[0] != '{' || raw[len(raw)-1] != '}' {
		t.Fatalf("the server writes one object with no final line feed, and the file is %q ... %q", raw[:1], raw[len(raw)-1:])
	}
	manifest, err := ParseReleaseManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Version != "1.12.345" {
		t.Errorf("version %q", manifest.Version)
	}
	if manifest.Counter != rustBuiltReleaseCounter {
		t.Errorf("counter %d, a number above 2^52 that every reader must keep exactly", manifest.Counter)
	}
	if want := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC); !manifest.IssuedAt.Equal(want) {
		t.Errorf("issued_at %s, want %s", manifest.IssuedAt, want)
	}
	if want := time.Date(2027, 4, 1, 12, 0, 0, 0, time.UTC); !manifest.ExpiresAt.Equal(want) {
		t.Errorf("expires_at %s, want %s", manifest.ExpiresAt, want)
	}
	if manifest.MinFrom != "1.12.0" {
		t.Errorf("min_from %q", manifest.MinFrom)
	}
	if manifest.ServiceDefinition != 2 {
		t.Errorf("service_definition %d", manifest.ServiceDefinition)
	}
	if want := rustBuiltArtifacts(); !slices.Equal(manifest.Artifacts, want) {
		t.Errorf("artifacts\n got %+v\nwant %+v", manifest.Artifacts, want)
	}

	// The platforms the server listed are found, and the ones it did not are not.
	windows, found := manifest.ArtifactFor("windows", "amd64")
	if !found || windows.File != "vectory-1.12.345-windows-amd64.exe" {
		t.Errorf("windows/amd64: %+v, %v", windows, found)
	}
	if _, found := manifest.ArtifactFor("darwin", "amd64"); found {
		t.Error("darwin/amd64 is not in the release")
	}
}

// A host that pins the key that signed the release takes it, and the decision
// reads the same artifact, counter and floors that the parser did.
func TestRustBuiltReleaseIsTakenByAHostThatPinsItsSigner(t *testing.T) {
	raw := rustBuiltRelease(t)
	key, err := GenerateReleasePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	public, err := key.Public("team")
	if err != nil {
		t.Fatal(err)
	}
	entry := ReleaseSignature{Key: public.Fingerprint()}
	copy(entry.Signature[:], key.SignRelease(raw))
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{entry})
	if err != nil {
		t.Fatal(err)
	}
	host := func(mutate func(*VerifyInput)) (Verified, error) {
		input := VerifyInput{
			Manifest:          raw,
			Signatures:        signatures,
			Pins:              []ReleaseKey{public},
			Floors:            map[string]uint64{public.Fingerprint(): rustBuiltReleaseCounter - 1},
			Now:               time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC),
			RunningVersion:    "1.12.344",
			OS:                "windows",
			Arch:              "amd64",
			Track:             ReleaseTrackPatch,
			ServiceDefinition: 2,
		}
		mutate(&input)
		return VerifyRelease(input)
	}

	verified, err := host(func(*VerifyInput) {})
	if err != nil {
		t.Fatal(err)
	}
	if want := rustBuiltArtifacts()[3]; verified.Artifact != want {
		t.Errorf("artifact %+v, want %+v", verified.Artifact, want)
	}
	if verified.ManifestSHA256 != Digest(raw) {
		t.Errorf("manifest digest %s, want %s", verified.ManifestSHA256, Digest(raw))
	}
	if got := verified.Floors[public.Fingerprint()]; got != rustBuiltReleaseCounter {
		t.Errorf("the signer's floor is %d, want the release's counter", got)
	}

	// The same bytes are refused for the reasons the file holds, by the code the
	// contract names.
	for name, c := range map[string]struct {
		mutate func(*VerifyInput)
		code   string
	}{
		"a platform the server did not build":  {func(in *VerifyInput) { in.OS, in.Arch = "darwin", "amd64" }, codePlatformNotInRelease},
		"a counter the host already attempted": {func(in *VerifyInput) { in.Floors[public.Fingerprint()] = rustBuiltReleaseCounter }, codeCounterReplayed},
		"a host older than min_from": {func(in *VerifyInput) {
			in.RunningVersion, in.Track = "1.11.9", ReleaseTrackMinor
		}, codeAgentTooOld},
		"a service definition that is older": {func(in *VerifyInput) { in.ServiceDefinition = 1 }, codeServiceDefinitionStale},
		"a clock after expiry":               {func(in *VerifyInput) { in.Now = time.Date(2027, 4, 1, 12, 0, 0, 0, time.UTC) }, codeManifestExpired},
	} {
		_, err := host(c.mutate)
		var refusal *UpdateRefusal
		if !errors.As(err, &refusal) || refusal.Code != c.code {
			t.Errorf("%s: %v, want %s", name, err, c.code)
		}
	}
}
