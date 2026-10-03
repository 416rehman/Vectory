package agent

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"sort"
	"strings"
	"time"
)

// The release format: the manifest a team signs, the detached signatures, the
// rollover statements that replace one key with another, and the one decision
// every host makes about an offered release. It is pure: no network, no clock
// but the one passed in, no files. The same VerifyRelease runs in the agent
// before it downloads, in the privileged step before it swaps, and in
// `vectory release verify`.
//
// A release is one file, release.json, and its signature is over exactly
//
//	"vectory-agent-release-v1\n" || the bytes of release.json
//
// Nobody re-serializes a signed file: the server stores the bytes it built, the
// offline signer signs the bytes it downloaded, and a host verifies the bytes it
// received and only then parses them. The Rust server and this code can't
// disagree about a canonical form because neither computes one. They can
// disagree about what a file is, so the signed files follow a profile that both
// check on the raw bytes (parseReleaseProfile), and the shared vectors in
// contracts/fixtures/agent-release pin every refusal.

const (
	releaseSignaturePrefix  = "vectory-agent-release-v1\n"
	rolloverSignaturePrefix = "vectory-release-key-rollover-v1\n"

	releaseManifestSchema   = "vectory.agent-release.v1"
	releaseSignaturesSchema = "vectory.agent-release-signatures.v1"
	rolloverStatementSchema = "vectory.release-key-rollover.v1"

	// MaxReleaseManifest, MaxReleaseSignatures and MaxRolloverStatement bound
	// the signed files in bytes, a final line feed included.
	MaxReleaseManifest   = 16 * 1024
	MaxReleaseSignatures = 4 * 1024
	MaxRolloverStatement = 1024
	// MaxRolloverChain is the most statements an offer carries and a host follows.
	MaxRolloverChain = 8

	maxReleaseArtifacts = 8
	maxReleaseSigners   = 4
	// releaseBuildLimit is the contract's bound on one agent build, 128 MiB.
	releaseBuildLimit = 128 * 1024 * 1024
	// maxReleaseValidity is the longest a manifest may live, and
	// releaseFutureIssue how far ahead of a host's clock its issue time may be.
	maxReleaseValidity = 400 * 24 * time.Hour
	releaseFutureIssue = 24 * time.Hour
	// maxProfileDepth bounds nesting. The signed files nest three levels deep.
	maxProfileDepth = 16

	// ReleaseTrackPatch takes the running major and minor with a newer patch;
	// ReleaseTrackMinor takes the running major with a newer minor or patch.
	ReleaseTrackPatch = "patch"
	ReleaseTrackMinor = "minor"

	releaseMajorTrackMessage = "This release offers patch and minor tracks. Upgrade to a new major version by hand."
)

// The agent codes this file gives. The contract lists all of them.
const (
	codeManifestInvalid        = "MANIFEST_INVALID"
	codeSignatureInvalid       = "SIGNATURE_INVALID"
	codeReleaseKeyInvalid      = "RELEASE_KEY_INVALID"
	codeKeyNotPinned           = "KEY_NOT_PINNED"
	codeKeyRolloverConflict    = "KEY_ROLLOVER_CONFLICT"
	codeManifestExpired        = "MANIFEST_EXPIRED"
	codePlatformNotInRelease   = "PLATFORM_NOT_IN_RELEASE"
	codeReleaseAlreadyTried    = "RELEASE_ALREADY_TRIED"
	codeCounterReplayed        = "COUNTER_REPLAYED"
	codeAlreadyRunning         = "ALREADY_RUNNING"
	codeDowngradeRefused       = "DOWNGRADE_REFUSED"
	codeVersionNotOnTrack      = "VERSION_NOT_ON_TRACK"
	codeAgentTooOld            = "AGENT_TOO_OLD"
	codeServiceDefinitionStale = "SERVICE_DEFINITION_OUTDATED"
)

// UpdateRefusal is a refusal to take an agent update, with one of the agent
// codes of the contract (MANIFEST_INVALID, KEY_NOT_PINNED,
// UNTRUSTED_LOCATION and so on) and a sentence for people that says what was
// found. Everything that decides an update returns it, so the agent reports
// the code and a person reads the detail.
type UpdateRefusal struct {
	Code   string
	Detail string
	// From and Successors are set only with KEY_ROLLOVER_CONFLICT: the
	// fingerprint of the pinned key that two statements replace, and the
	// fingerprints of the two different successors they name, in ascending
	// order.
	From       string
	Successors []string
}

func (e *UpdateRefusal) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

func newUpdateRefusal(code, format string, args ...any) *UpdateRefusal {
	return &UpdateRefusal{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// ---------------------------------------------------------------- the profile

// A signed file is verified as bytes and then parsed, by a Rust server and this
// code, which must agree on every input. So both check the raw bytes before they
// decode anything: every byte is printable ASCII (0x20 to 0x7E) except at most
// one final line feed, the first byte is {, the only whitespace is the space, a
// backslash occurs nowhere (so no escape sequence, and no string holds a
// quotation mark or a backslash), no member occurs twice in an object, numbers
// are written 0 or a digit 1 to 9 followed by digits and are at most 2^53-1,
// every other value is a string, an array or an object, and nothing follows the
// object but that one line feed. encoding/json is not used: it keeps the last of
// two duplicate members without a word, accepts 1e2 and 7.0 as numbers, accepts
// escapes, and skips whatever follows a value it was not asked to read.

type releaseValueKind int

const (
	releaseString releaseValueKind = iota + 1
	releaseNumber
	releaseArray
	releaseObject
)

type releaseValue struct {
	kind    releaseValueKind
	text    string
	number  uint64
	items   []releaseValue
	members map[string]releaseValue
}

type profileParser struct {
	data []byte
	at   int
}

// parseReleaseProfile checks the bytes against the profile and returns the
// members of the one object they hold.
func parseReleaseProfile(raw []byte, limit int) (map[string]releaseValue, error) {
	if len(raw) == 0 {
		return nil, errors.New("the file is empty")
	}
	if len(raw) > limit {
		return nil, fmt.Errorf("the file is %d bytes and at most %d are allowed", len(raw), limit)
	}
	body := raw
	if body[len(body)-1] == '\n' {
		body = body[:len(body)-1]
	}
	for i, b := range body {
		switch {
		case b == '\\':
			return nil, fmt.Errorf("byte %d is a backslash, and escape sequences aren't allowed", i)
		case b < 0x20 || b > 0x7e:
			return nil, fmt.Errorf("byte %d is 0x%02x: only printable ASCII is allowed, and one line feed may end the file", i, b)
		}
	}
	if len(body) == 0 || body[0] != '{' {
		return nil, errors.New("the file must start with {")
	}
	parser := &profileParser{data: body}
	object, err := parser.object(1)
	if err != nil {
		return nil, err
	}
	if parser.at != len(body) {
		return nil, fmt.Errorf("unexpected data after the object, at byte %d", parser.at)
	}
	return object.members, nil
}

func (p *profileParser) spaces() {
	for p.at < len(p.data) && p.data[p.at] == ' ' {
		p.at++
	}
}

func (p *profileParser) expected(what string) error {
	if p.at >= len(p.data) {
		return fmt.Errorf("the file ends where %s should be", what)
	}
	return fmt.Errorf("expected %s at byte %d", what, p.at)
}

func (p *profileParser) value(depth int) (releaseValue, error) {
	p.spaces()
	if p.at >= len(p.data) {
		return releaseValue{}, p.expected("a value")
	}
	switch c := p.data[p.at]; {
	case c == '"':
		text, err := p.str()
		return releaseValue{kind: releaseString, text: text}, err
	case c == '{':
		return p.object(depth + 1)
	case c == '[':
		return p.array(depth + 1)
	case c >= '0' && c <= '9':
		number, err := p.num()
		return releaseValue{kind: releaseNumber, number: number}, err
	}
	return releaseValue{}, p.expected("a string, a whole number, an array or an object")
}

// str reads a string. There are no escapes, so it ends at the next quotation mark.
func (p *profileParser) str() (string, error) {
	if p.at >= len(p.data) || p.data[p.at] != '"' {
		return "", p.expected(`a string`)
	}
	p.at++
	start := p.at
	for p.at < len(p.data) && p.data[p.at] != '"' {
		p.at++
	}
	if p.at >= len(p.data) {
		return "", errors.New("a string isn't closed")
	}
	text := string(p.data[start:p.at])
	p.at++
	return text, nil
}

// num reads 0, or a digit 1 to 9 followed by digits: no sign, fraction,
// exponent or leading zero, and at most 2^53-1.
func (p *profileParser) num() (uint64, error) {
	start := p.at
	if p.data[p.at] == '0' {
		p.at++
		return 0, nil
	}
	var number uint64
	for p.at < len(p.data) && p.data[p.at] >= '0' && p.data[p.at] <= '9' {
		if p.at-start >= 16 {
			return 0, fmt.Errorf("the number at byte %d is above %d", start, MaxJSONCounter)
		}
		number = number*10 + uint64(p.data[p.at]-'0')
		p.at++
	}
	if number > MaxJSONCounter {
		return 0, fmt.Errorf("the number at byte %d is above %d", start, MaxJSONCounter)
	}
	return number, nil
}

func (p *profileParser) object(depth int) (releaseValue, error) {
	if depth > maxProfileDepth {
		return releaseValue{}, errors.New("the file nests too deeply")
	}
	p.at++ // {
	members := map[string]releaseValue{}
	p.spaces()
	if p.at < len(p.data) && p.data[p.at] == '}' {
		p.at++
		return releaseValue{kind: releaseObject, members: members}, nil
	}
	for {
		p.spaces()
		name, err := p.str()
		if err != nil {
			return releaseValue{}, err
		}
		if _, repeated := members[name]; repeated {
			return releaseValue{}, fmt.Errorf("the member %q occurs twice", name)
		}
		p.spaces()
		if p.at >= len(p.data) || p.data[p.at] != ':' {
			return releaseValue{}, p.expected(`":" after a member's name`)
		}
		p.at++
		value, err := p.value(depth)
		if err != nil {
			return releaseValue{}, err
		}
		members[name] = value
		p.spaces()
		switch {
		case p.at < len(p.data) && p.data[p.at] == ',':
			p.at++
		case p.at < len(p.data) && p.data[p.at] == '}':
			p.at++
			return releaseValue{kind: releaseObject, members: members}, nil
		default:
			return releaseValue{}, p.expected(`"," or "}"`)
		}
	}
}

func (p *profileParser) array(depth int) (releaseValue, error) {
	if depth > maxProfileDepth {
		return releaseValue{}, errors.New("the file nests too deeply")
	}
	p.at++ // [
	items := []releaseValue{}
	p.spaces()
	if p.at < len(p.data) && p.data[p.at] == ']' {
		p.at++
		return releaseValue{kind: releaseArray, items: items}, nil
	}
	for {
		value, err := p.value(depth)
		if err != nil {
			return releaseValue{}, err
		}
		items = append(items, value)
		p.spaces()
		switch {
		case p.at < len(p.data) && p.data[p.at] == ',':
			p.at++
		case p.at < len(p.data) && p.data[p.at] == ']':
			p.at++
			return releaseValue{kind: releaseArray, items: items}, nil
		default:
			return releaseValue{}, p.expected(`"," or "]"`)
		}
	}
}

// ---------------------------------------------------------------- typed members

// checkMembers requires every member in required and refuses any member that is
// neither required nor optional.
func checkMembers(object map[string]releaseValue, what string, required []string, optional ...string) error {
	for _, name := range required {
		if _, found := object[name]; !found {
			return fmt.Errorf("%s has no member %q", what, name)
		}
	}
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !containsString(required, name) && !containsString(optional, name) {
			return fmt.Errorf("%s has the member %q, which the format doesn't have", what, name)
		}
	}
	return nil
}

func containsString(list []string, name string) bool {
	for _, item := range list {
		if item == name {
			return true
		}
	}
	return false
}

func stringMember(object map[string]releaseValue, name string) (string, error) {
	value := object[name]
	if value.kind != releaseString {
		return "", fmt.Errorf("%q must be a string", name)
	}
	return value.text, nil
}

func numberMember(object map[string]releaseValue, name string) (uint64, error) {
	value := object[name]
	if value.kind != releaseNumber {
		return 0, fmt.Errorf("%q must be a whole number", name)
	}
	return value.number, nil
}

func isLowerHex64(text string) bool {
	if len(text) != 64 {
		return false
	}
	for i := 0; i < len(text); i++ {
		c := text[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func hexMember(object map[string]releaseValue, name string) (string, error) {
	text, err := stringMember(object, name)
	if err != nil {
		return "", err
	}
	if !isLowerHex64(text) {
		return "", fmt.Errorf("%q must be 64 lowercase hexadecimal characters", name)
	}
	return text, nil
}

// ---------------------------------------------------------------- versions and instants

// ReleaseVersion is a major.minor.patch version: three numbers, each 0 or one
// to nine digits that start with 1 to 9. A pre-release or build suffix is not a
// version here. 0.1.0 is older than 0.1.10.
type ReleaseVersion struct{ Major, Minor, Patch uint32 }

// ParseReleaseVersion parses a version, and refuses anything else, so a running
// version that isn't one is unknown and never guessed.
func ParseReleaseVersion(text string) (ReleaseVersion, error) {
	parts := strings.Split(text, ".")
	if len(parts) == 3 {
		var numbers [3]uint32
		valid := true
		for i, part := range parts {
			var ok bool
			if numbers[i], ok = versionNumber(part); !ok {
				valid = false
				break
			}
		}
		if valid {
			return ReleaseVersion{numbers[0], numbers[1], numbers[2]}, nil
		}
	}
	return ReleaseVersion{}, fmt.Errorf("%q isn't a version: write major.minor.patch, three numbers without leading zeros", text)
}

func versionNumber(part string) (uint32, bool) {
	if part == "" || len(part) > 9 || (len(part) > 1 && part[0] == '0') {
		return 0, false
	}
	var number uint32
	for i := 0; i < len(part); i++ {
		if part[i] < '0' || part[i] > '9' {
			return 0, false
		}
		number = number*10 + uint32(part[i]-'0')
	}
	return number, true
}

func (v ReleaseVersion) String() string {
	return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
}

// Compare is -1, 0 or 1 as v is older than, equal to or newer than other.
func (v ReleaseVersion) Compare(other ReleaseVersion) int {
	for _, pair := range [3][2]uint32{{v.Major, other.Major}, {v.Minor, other.Minor}, {v.Patch, other.Patch}} {
		if pair[0] != pair[1] {
			if pair[0] < pair[1] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// ParseReleaseTrack checks the version track a host consents to. A major track
// doesn't exist: a new major version is installed by hand.
func ParseReleaseTrack(value string) (string, error) {
	switch value {
	case ReleaseTrackPatch, ReleaseTrackMinor:
		return value, nil
	case "major":
		return "", inputError(releaseMajorTrackMessage)
	}
	return "", inputError(fmt.Sprintf("%q isn't an update track. Use %s or %s.", value, ReleaseTrackPatch, ReleaseTrackMinor))
}

// parseReleaseInstant reads YYYY-MM-DDTHH:MM:SSZ: a UTC instant in whole
// seconds, years 1970 to 9999, written with exactly these characters.
func parseReleaseInstant(text string) (time.Time, bool) {
	if len(text) != 20 || text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':' || text[19] != 'Z' {
		return time.Time{}, false
	}
	field := func(from, to int) (int, bool) {
		value := 0
		for i := from; i < to; i++ {
			if text[i] < '0' || text[i] > '9' {
				return 0, false
			}
			value = value*10 + int(text[i]-'0')
		}
		return value, true
	}
	year, ok1 := field(0, 4)
	month, ok2 := field(5, 7)
	day, ok3 := field(8, 10)
	hour, ok4 := field(11, 13)
	minute, ok5 := field(14, 16)
	second, ok6 := field(17, 19)
	if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 {
		return time.Time{}, false
	}
	instant := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	// time.Date normalizes February 30 to March 2: a day that doesn't exist
	// comes back as another day.
	if instant.Day() != day {
		return time.Time{}, false
	}
	return instant, true
}

func formatReleaseInstant(instant time.Time) string {
	return instant.UTC().Format("2006-01-02T15:04:05Z")
}

// ---------------------------------------------------------------- the manifest

// ReleaseArtifact is one build in a release: the agent executable itself, byte
// for byte, for one operating system and architecture. No archive is ever
// unpacked as root.
type ReleaseArtifact struct {
	OS     string
	Arch   string
	Format string
	File   string
	Size   int64
	SHA256 string
}

// ReleaseManifest is a parsed release.json.
type ReleaseManifest struct {
	Version string
	Counter uint64
	// IssuedAt and ExpiresAt are UTC instants in whole seconds.
	IssuedAt  time.Time
	ExpiresAt time.Time
	// MinFrom is the oldest running version the release can be taken from, or
	// "" when there is no such limit.
	MinFrom string
	// ServiceDefinition is the generation of the unit, plist or service
	// definition the build needs.
	ServiceDefinition int64
	Artifacts         []ReleaseArtifact
}

// ArtifactFor is the build for an operating system and architecture.
func (m ReleaseManifest) ArtifactFor(goos, goarch string) (ReleaseArtifact, bool) {
	for _, artifact := range m.Artifacts {
		if artifact.OS == goos && artifact.Arch == goarch {
			return artifact, true
		}
	}
	return ReleaseArtifact{}, false
}

func invalidManifest(err error) *UpdateRefusal {
	return newUpdateRefusal(codeManifestInvalid, "release.json: %v", err)
}

// ParseReleaseManifest parses release.json under the profile of the signed
// files and the rules of its format. It is the strict reader every host uses on
// bytes whose signature it has verified; it checks nothing about the host.
// Errors are *UpdateRefusal with the code MANIFEST_INVALID.
func ParseReleaseManifest(raw []byte) (ReleaseManifest, error) {
	members, err := parseReleaseProfile(raw, MaxReleaseManifest)
	if err != nil {
		return ReleaseManifest{}, invalidManifest(err)
	}
	manifest, err := manifestFromMembers(members)
	if err != nil {
		return ReleaseManifest{}, invalidManifest(err)
	}
	return manifest, nil
}

var (
	releaseOperatingSystems = []string{"linux", "darwin", "windows"}
	releaseArchitectures    = []string{"amd64", "arm64"}
)

func manifestFromMembers(members map[string]releaseValue) (ReleaseManifest, error) {
	if err := checkMembers(members, "the manifest", []string{"schema", "version", "counter", "issued_at", "expires_at", "service_definition", "artifacts"}, "min_from"); err != nil {
		return ReleaseManifest{}, err
	}
	schema, err := stringMember(members, "schema")
	if err != nil {
		return ReleaseManifest{}, err
	}
	if schema != releaseManifestSchema {
		return ReleaseManifest{}, fmt.Errorf("the schema is %q, and this agent reads %q", schema, releaseManifestSchema)
	}
	var manifest ReleaseManifest
	if manifest.Version, err = stringMember(members, "version"); err != nil {
		return ReleaseManifest{}, err
	}
	if _, err = ParseReleaseVersion(manifest.Version); err != nil {
		return ReleaseManifest{}, fmt.Errorf("the version: %w", err)
	}
	if manifest.Counter, err = numberMember(members, "counter"); err != nil {
		return ReleaseManifest{}, err
	}
	if manifest.Counter < 1 {
		return ReleaseManifest{}, fmt.Errorf("the counter must be from 1 to %d", MaxJSONCounter)
	}
	var ok bool
	issued, err := stringMember(members, "issued_at")
	if err != nil {
		return ReleaseManifest{}, err
	}
	if manifest.IssuedAt, ok = parseReleaseInstant(issued); !ok {
		return ReleaseManifest{}, fmt.Errorf("issued_at %q isn't a UTC time like 2026-10-03T12:00:00Z", issued)
	}
	expires, err := stringMember(members, "expires_at")
	if err != nil {
		return ReleaseManifest{}, err
	}
	if manifest.ExpiresAt, ok = parseReleaseInstant(expires); !ok {
		return ReleaseManifest{}, fmt.Errorf("expires_at %q isn't a UTC time like 2027-04-01T12:00:00Z", expires)
	}
	if !manifest.ExpiresAt.After(manifest.IssuedAt) || manifest.ExpiresAt.Sub(manifest.IssuedAt) > maxReleaseValidity {
		return ReleaseManifest{}, errors.New("expires_at must be after issued_at and at most 400 days later")
	}
	if _, present := members["min_from"]; present {
		if manifest.MinFrom, err = stringMember(members, "min_from"); err != nil {
			return ReleaseManifest{}, err
		}
		if _, err = ParseReleaseVersion(manifest.MinFrom); err != nil {
			return ReleaseManifest{}, fmt.Errorf("min_from: %w", err)
		}
	}
	definition, err := numberMember(members, "service_definition")
	if err != nil {
		return ReleaseManifest{}, err
	}
	if definition < 1 {
		return ReleaseManifest{}, errors.New("service_definition must be 1 or more")
	}
	manifest.ServiceDefinition = int64(definition)
	list := members["artifacts"]
	if list.kind != releaseArray || len(list.items) < 1 || len(list.items) > maxReleaseArtifacts {
		return ReleaseManifest{}, fmt.Errorf("artifacts must list from 1 to %d builds", maxReleaseArtifacts)
	}
	for _, item := range list.items {
		artifact, err := artifactFromValue(item, manifest.Version)
		if err != nil {
			return ReleaseManifest{}, err
		}
		if _, repeated := manifest.ArtifactFor(artifact.OS, artifact.Arch); repeated {
			return ReleaseManifest{}, fmt.Errorf("artifacts lists %s/%s twice", artifact.OS, artifact.Arch)
		}
		manifest.Artifacts = append(manifest.Artifacts, artifact)
	}
	return manifest, nil
}

func artifactFromValue(item releaseValue, version string) (ReleaseArtifact, error) {
	if item.kind != releaseObject {
		return ReleaseArtifact{}, errors.New("every entry of artifacts must be an object")
	}
	if err := checkMembers(item.members, "an artifact", []string{"os", "arch", "format", "file", "size", "sha256"}); err != nil {
		return ReleaseArtifact{}, err
	}
	var artifact ReleaseArtifact
	var err error
	if artifact.OS, err = stringMember(item.members, "os"); err != nil {
		return ReleaseArtifact{}, err
	}
	if artifact.Arch, err = stringMember(item.members, "arch"); err != nil {
		return ReleaseArtifact{}, err
	}
	if artifact.Format, err = stringMember(item.members, "format"); err != nil {
		return ReleaseArtifact{}, err
	}
	if !containsString(releaseOperatingSystems, artifact.OS) {
		return ReleaseArtifact{}, fmt.Errorf("an artifact's os is %q, and the operating systems are linux, darwin and windows", artifact.OS)
	}
	if !containsString(releaseArchitectures, artifact.Arch) {
		return ReleaseArtifact{}, fmt.Errorf("an artifact's arch is %q, and the architectures are amd64 and arm64", artifact.Arch)
	}
	if artifact.Format != "executable" {
		return ReleaseArtifact{}, fmt.Errorf("an artifact's format is %q, and the only format is executable", artifact.Format)
	}
	if artifact.File, err = stringMember(item.members, "file"); err != nil {
		return ReleaseArtifact{}, err
	}
	want := fmt.Sprintf("vectory-%s-%s-%s", version, artifact.OS, artifact.Arch)
	if artifact.OS == "windows" {
		want += ".exe"
	}
	if artifact.File != want {
		return ReleaseArtifact{}, fmt.Errorf("the file of %s/%s is %q and should be %q", artifact.OS, artifact.Arch, artifact.File, want)
	}
	size, err := numberMember(item.members, "size")
	if err != nil {
		return ReleaseArtifact{}, err
	}
	if size < 1 || size > releaseBuildLimit {
		return ReleaseArtifact{}, fmt.Errorf("the size of %s is %d bytes, and a build is from 1 byte to %d", artifact.File, size, releaseBuildLimit)
	}
	artifact.Size = int64(size)
	if artifact.SHA256, err = hexMember(item.members, "sha256"); err != nil {
		return ReleaseArtifact{}, fmt.Errorf("%s: %w", artifact.File, err)
	}
	return artifact, nil
}

// ---------------------------------------------------------------- the detached signatures

// ReleaseSignature is one entry of release.json.sig: the fingerprint of the key
// the signer says made it, and the 64-byte signature. The fingerprint only
// selects which pinned key to try.
type ReleaseSignature struct {
	Key       string
	Signature [64]byte
}

func invalidSignatures(err error) *UpdateRefusal {
	return newUpdateRefusal(codeSignatureInvalid, "release.json.sig: %v", err)
}

// ParseReleaseSignatures parses release.json.sig: 1 to 4 entries with distinct
// keys, at most 4 KiB. Errors are *UpdateRefusal with the code SIGNATURE_INVALID.
func ParseReleaseSignatures(raw []byte) ([]ReleaseSignature, error) {
	members, err := parseReleaseProfile(raw, MaxReleaseSignatures)
	if err != nil {
		return nil, invalidSignatures(err)
	}
	entries, err := signaturesFromMembers(members)
	if err != nil {
		return nil, invalidSignatures(err)
	}
	return entries, nil
}

func signaturesFromMembers(members map[string]releaseValue) ([]ReleaseSignature, error) {
	if err := checkMembers(members, "the file", []string{"schema", "signatures"}); err != nil {
		return nil, err
	}
	schema, err := stringMember(members, "schema")
	if err != nil {
		return nil, err
	}
	if schema != releaseSignaturesSchema {
		return nil, fmt.Errorf("the schema is %q, and this agent reads %q", schema, releaseSignaturesSchema)
	}
	list := members["signatures"]
	if list.kind != releaseArray || len(list.items) < 1 || len(list.items) > maxReleaseSigners {
		return nil, fmt.Errorf("signatures must list from 1 to %d entries", maxReleaseSigners)
	}
	entries := make([]ReleaseSignature, 0, len(list.items))
	for _, item := range list.items {
		if item.kind != releaseObject {
			return nil, errors.New("every entry of signatures must be an object")
		}
		if err := checkMembers(item.members, "a signature entry", []string{"key", "signature"}); err != nil {
			return nil, err
		}
		var entry ReleaseSignature
		if entry.Key, err = hexMember(item.members, "key"); err != nil {
			return nil, err
		}
		for _, earlier := range entries {
			if earlier.Key == entry.Key {
				return nil, fmt.Errorf("the key %s appears twice", entry.Key[:16])
			}
		}
		encoded, err := stringMember(item.members, "signature")
		if err != nil {
			return nil, err
		}
		signature, ok := decodeCanonicalBase64(encoded)
		if !ok || len(signature) != len(entry.Signature) {
			return nil, errors.New("a signature must be the canonical base64 of 64 bytes")
		}
		copy(entry.Signature[:], signature)
		entries = append(entries, entry)
	}
	return entries, nil
}

// BuildReleaseSignatures writes release.json.sig for these entries: one line
// without spaces and a final line feed.
func BuildReleaseSignatures(entries []ReleaseSignature) ([]byte, error) {
	var file strings.Builder
	file.WriteString(`{"schema":"` + releaseSignaturesSchema + `","signatures":[`)
	for i, entry := range entries {
		if i > 0 {
			file.WriteByte(',')
		}
		file.WriteString(`{"key":"` + entry.Key + `","signature":"` + base64.StdEncoding.EncodeToString(entry.Signature[:]) + `"}`)
	}
	file.WriteString("]}\n")
	// A writer must never produce a file that its readers refuse.
	if _, err := ParseReleaseSignatures([]byte(file.String())); err != nil {
		return nil, err
	}
	return []byte(file.String()), nil
}

// ---------------------------------------------------------------- rollover statements

// RolloverEnvelope is a rollover statement and its signature as they travel:
// the base64 of the statement's bytes and of its 64-byte signature.
type RolloverEnvelope struct {
	Statement string `json:"statement"`
	Signature string `json:"signature"`
}

// Rollover is a statement that replaces one release key with another, signed by
// the key it replaces: {"schema":"vectory.release-key-rollover.v1","from":
// "<fingerprint>","to":"<key line>","issued_at":"<instant>"}, over
// "vectory-release-key-rollover-v1\n" || the statement's bytes.
type Rollover struct {
	// From is the fingerprint of the key being replaced.
	From string
	// To is the successor. Its fingerprint is computed from its bytes, and the
	// key passed the key rule.
	To        ReleaseKey
	IssuedAt  time.Time
	Statement []byte
	Signature [64]byte
}

func invalidRollover(err error) *UpdateRefusal {
	return newUpdateRefusal(codeSignatureInvalid, "rollover statement: %v", err)
}

// ParseRollover parses a statement and its signature as bytes. It does not say
// whether the signature verifies: that needs the key it names (VerifiedBy).
// Errors are *UpdateRefusal: RELEASE_KEY_INVALID when the successor is not a
// valid key, SIGNATURE_INVALID for anything else.
func ParseRollover(statement, signature []byte) (Rollover, error) {
	if len(signature) != ed25519.SignatureSize {
		return Rollover{}, invalidRollover(errors.New("a signature is 64 bytes"))
	}
	members, err := parseReleaseProfile(statement, MaxRolloverStatement)
	if err != nil {
		return Rollover{}, invalidRollover(err)
	}
	if err := checkMembers(members, "the statement", []string{"schema", "from", "to", "issued_at"}); err != nil {
		return Rollover{}, invalidRollover(err)
	}
	schema, err := stringMember(members, "schema")
	if err != nil {
		return Rollover{}, invalidRollover(err)
	}
	if schema != rolloverStatementSchema {
		return Rollover{}, invalidRollover(fmt.Errorf("the schema is %q, and this agent reads %q", schema, rolloverStatementSchema))
	}
	rollover := Rollover{Statement: append([]byte(nil), statement...)}
	if rollover.From, err = hexMember(members, "from"); err != nil {
		return Rollover{}, invalidRollover(err)
	}
	line, err := stringMember(members, "to")
	if err != nil {
		return Rollover{}, invalidRollover(err)
	}
	if rollover.To, err = ParseReleaseKey(line); err != nil {
		return Rollover{}, err
	}
	if rollover.To.Fingerprint() == rollover.From {
		return Rollover{}, invalidRollover(errors.New("a key can't replace itself"))
	}
	issued, err := stringMember(members, "issued_at")
	if err != nil {
		return Rollover{}, invalidRollover(err)
	}
	var ok bool
	if rollover.IssuedAt, ok = parseReleaseInstant(issued); !ok {
		return Rollover{}, invalidRollover(fmt.Errorf("issued_at %q isn't a UTC time like 2026-11-02T09:00:00Z", issued))
	}
	copy(rollover.Signature[:], signature)
	return rollover, nil
}

// Parse decodes the envelope's base64, which must be canonical, and parses the
// statement.
func (e RolloverEnvelope) Parse() (Rollover, error) {
	statement, ok := decodeCanonicalBase64(e.Statement)
	if !ok {
		return Rollover{}, invalidRollover(errors.New("the statement isn't canonical base64"))
	}
	signature, ok := decodeCanonicalBase64(e.Signature)
	if !ok {
		return Rollover{}, invalidRollover(errors.New("the signature isn't canonical base64"))
	}
	return ParseRollover(statement, signature)
}

// VerifiedBy reports whether the statement's signature verifies under key, the
// pinned key whose fingerprint the statement names.
func (r Rollover) VerifiedBy(key ReleaseKey) bool {
	return key.Fingerprint() == r.From && key.verify(rolloverSignaturePrefix, r.Statement, r.Signature[:])
}

// SignRollover writes a statement that replaces the key whose private half this
// is with to, and signs it. A key can be replaced by a key of its own custody:
// hosts that pin it follow the statement to the successor.
func SignRollover(from ReleasePrivateKey, to ReleaseKey, issuedAt time.Time) (RolloverEnvelope, error) {
	if from.IsZero() || to.IsZero() {
		return RolloverEnvelope{}, errors.New("a rollover needs the key it replaces and its successor")
	}
	if to.Fingerprint() == from.Fingerprint() {
		return RolloverEnvelope{}, errors.New("the new key is the key it replaces")
	}
	statement := []byte(`{"schema":"` + rolloverStatementSchema + `","from":"` + from.Fingerprint() + `","to":"` + to.Line() + `","issued_at":"` + formatReleaseInstant(issuedAt) + `"}`)
	envelope := RolloverEnvelope{
		Statement: base64.StdEncoding.EncodeToString(statement),
		Signature: base64.StdEncoding.EncodeToString(from.sign(rolloverSignaturePrefix, statement)),
	}
	// A writer must never produce a statement that its readers refuse.
	if _, err := envelope.Parse(); err != nil {
		return RolloverEnvelope{}, err
	}
	return envelope, nil
}

// ---------------------------------------------------------------- the decision

// ReleaseResult is a host's last result: the SHA-256 of the manifest it was
// about and its outcome (committed, rolled_back, failed or refused).
type ReleaseResult struct {
	Release string
	Outcome string
}

// VerifyInput is everything a host decides an offered release from. The first
// group is the offer and the host's keys; VerifyReleaseFiles reads only that
// group.
type VerifyInput struct {
	// Manifest and Signatures are the exact bytes of release.json and
	// release.json.sig as delivered.
	Manifest   []byte
	Signatures []byte
	// Rollovers are the offer's statements in the order a host follows them.
	Rollovers []RolloverEnvelope
	// Pins are the keys the host pins.
	Pins []ReleaseKey
	// Floors is, for each fingerprint, the highest counter the host attempted
	// from that key.
	Floors map[string]uint64
	// Now is the host's clock.
	Now time.Time

	// Last is the host's last result, or nil. The rest is the host's own
	// facts: its running version, its operating system and architecture as Go
	// names them, its track and the generation of its service definition.
	Last              *ReleaseResult
	RunningVersion    string
	OS, Arch          string
	Track             string
	ServiceDefinition int
}

// Verified is a release a host accepts.
type Verified struct {
	Manifest ReleaseManifest
	// ManifestSHA256 is the SHA-256 of the manifest bytes: the digest a host
	// reports as `release`.
	ManifestSHA256 string
	// Signers are the pinned keys whose signature verified, in the file's
	// order. The first is the signer.
	Signers []ReleaseKey
	// Artifact is this host's build. VerifyReleaseFiles leaves it empty.
	Artifact ReleaseArtifact
	// Pins are the keys pinned after following the rollovers, by fingerprint,
	// and Floors the counter floors after them with the floor of every signer
	// raised to the release's counter: what a host holds if it takes the
	// release. Only pinned keys have a floor, and only a floor above 0 is kept.
	Pins   []ReleaseKey
	Floors map[string]uint64
}

// Signer is the first of the signers.
func (v Verified) Signer() ReleaseKey { return v.Signers[0] }

// VerifyRelease decides an offered release in the order of the contract and
// stops at the first refusal. It is the one function the agent (before it
// downloads), the privileged step (before it swaps) and `vectory release
// verify` use:
//
//  1. more than 8 rollover statements: MANIFEST_INVALID
//  2. the signature file doesn't parse: SIGNATURE_INVALID
//  3. the rollover chain: a fork is KEY_ROLLOVER_CONFLICT
//  4. no entry names a pinned key: KEY_NOT_PINNED
//  5. no entry for a pinned key verifies: SIGNATURE_INVALID
//  6. the manifest breaks a rule, or was issued more than 24 hours after the
//     host's clock: MANIFEST_INVALID
//  7. the host's clock is at or after expires_at: MANIFEST_EXPIRED
//  8. no build for this platform: PLATFORM_NOT_IN_RELEASE
//  9. the counter is at or below the floor of a signer: RELEASE_ALREADY_TRIED
//     when the last result names this manifest as rolled back, otherwise
//     COUNTER_REPLAYED
//  10. the running version is the release's: ALREADY_RUNNING; it is newer:
//     DOWNGRADE_REFUSED. A running version that isn't major.minor.patch can't be
//     compared and is refused as DOWNGRADE_REFUSED, never guessed
//  11. the release is not on the host's track: VERSION_NOT_ON_TRACK
//  12. the running version is older than min_from: AGENT_TOO_OLD
//  13. the release needs a newer service definition: SERVICE_DEFINITION_OUTDATED
//
// Errors are *UpdateRefusal. The verification uses the pinned key's own bytes:
// the key named in a signature entry only selects which pinned key to try.
func VerifyRelease(in VerifyInput) (Verified, error) {
	signed, err := verifySigned(in)
	if err != nil {
		return Verified{}, err
	}
	manifest := signed.manifest
	artifact, found := manifest.ArtifactFor(in.OS, in.Arch)
	if !found {
		return Verified{}, newUpdateRefusal(codePlatformNotInRelease, "this release has no build for %s/%s", in.OS, in.Arch)
	}
	for _, signer := range signed.signers {
		if floor := signed.floors[signer.Fingerprint()]; floor >= manifest.Counter {
			if in.Last != nil && in.Last.Outcome == "rolled_back" && in.Last.Release == signed.digest {
				return Verified{}, newUpdateRefusal(codeReleaseAlreadyTried, "This build was tried here and rolled back; publish a new release to try again")
			}
			return Verified{}, newUpdateRefusal(codeCounterReplayed, "counter %d is at or below %d, the highest this host attempted from key %s", manifest.Counter, floor, signer.ShortID())
		}
	}
	running, err := ParseReleaseVersion(in.RunningVersion)
	if err != nil {
		return Verified{}, newUpdateRefusal(codeDowngradeRefused, "this agent's version %q isn't major.minor.patch, so a newer release can't be told from an older one", in.RunningVersion)
	}
	offered, _ := ParseReleaseVersion(manifest.Version)
	switch order := offered.Compare(running); {
	case order == 0:
		return Verified{}, newUpdateRefusal(codeAlreadyRunning, "this host already runs %s", running)
	case order < 0:
		return Verified{}, newUpdateRefusal(codeDowngradeRefused, "%s is older than the %s this host runs, and a host never goes back by an update", offered, running)
	}
	switch in.Track {
	case ReleaseTrackPatch:
		if offered.Major != running.Major || offered.Minor != running.Minor {
			return Verified{}, newUpdateRefusal(codeVersionNotOnTrack, "%s isn't a patch release of %s, and this host takes patch releases only", offered, running)
		}
	case ReleaseTrackMinor:
		if offered.Major != running.Major {
			return Verified{}, newUpdateRefusal(codeVersionNotOnTrack, "%s is a new major version after %s. %s", offered, running, releaseMajorTrackMessage)
		}
	default:
		_, err := ParseReleaseTrack(in.Track)
		return Verified{}, newUpdateRefusal(codeVersionNotOnTrack, "%v", err)
	}
	if manifest.MinFrom != "" {
		minimum, _ := ParseReleaseVersion(manifest.MinFrom)
		if running.Compare(minimum) < 0 {
			return Verified{}, newUpdateRefusal(codeAgentTooOld, "this release is taken from %s or newer, and this host runs %s", minimum, running)
		}
	}
	if manifest.ServiceDefinition > int64(in.ServiceDefinition) {
		return Verified{}, newUpdateRefusal(codeServiceDefinitionStale, "this release needs service definition %d, and this host has %d", manifest.ServiceDefinition, in.ServiceDefinition)
	}
	verified := signed.taken()
	verified.Artifact = artifact
	return verified, nil
}

// VerifyReleaseFiles checks the files alone: steps 1 to 7 of VerifyRelease. It
// is for a tool that has no host to ask (`vectory release verify`), and it says
// nothing about the platform, the counter floors, the running version, the
// track or the service definition. A host decides with VerifyRelease.
func VerifyReleaseFiles(in VerifyInput) (Verified, error) {
	signed, err := verifySigned(in)
	if err != nil {
		return Verified{}, err
	}
	return signed.taken(), nil
}

// signedRelease is a release whose manifest a pinned key signed, and which is
// well formed and unexpired: steps 1 to 7. Its floors are the host's after the
// rollover chain and before this release.
type signedRelease struct {
	manifest ReleaseManifest
	digest   string
	signers  []ReleaseKey
	pins     map[string]ReleaseKey
	floors   map[string]uint64
}

// taken is what a host holds if it takes the release: the pins after the
// chain, and the floor of every signer raised to the counter.
func (s signedRelease) taken() Verified {
	verified := Verified{Manifest: s.manifest, ManifestSHA256: s.digest, Signers: s.signers, Floors: map[string]uint64{}}
	floors := maps.Clone(s.floors)
	for _, signer := range s.signers {
		floors[signer.Fingerprint()] = s.manifest.Counter
	}
	for fingerprint, key := range s.pins {
		verified.Pins = append(verified.Pins, key)
		if floor := floors[fingerprint]; floor > 0 {
			verified.Floors[fingerprint] = floor
		}
	}
	sort.Slice(verified.Pins, func(i, j int) bool { return verified.Pins[i].Fingerprint() < verified.Pins[j].Fingerprint() })
	return verified
}

func verifySigned(in VerifyInput) (signedRelease, error) {
	if len(in.Rollovers) > MaxRolloverChain {
		return signedRelease{}, newUpdateRefusal(codeManifestInvalid, "the offer carries %d rollover statements, and a host follows at most %d", len(in.Rollovers), MaxRolloverChain)
	}
	entries, err := ParseReleaseSignatures(in.Signatures)
	if err != nil {
		return signedRelease{}, err
	}
	pins, floors, err := followRollovers(in.Pins, in.Floors, in.Rollovers)
	if err != nil {
		return signedRelease{}, err
	}
	var signers []ReleaseKey
	named := 0
	for _, entry := range entries {
		key, pinned := pins[entry.Key]
		if !pinned {
			continue
		}
		named++
		if key.verify(releaseSignaturePrefix, in.Manifest, entry.Signature[:]) {
			signers = append(signers, key)
		}
	}
	if named == 0 {
		return signedRelease{}, newUpdateRefusal(codeKeyNotPinned, "none of the keys that signed this release is pinned on this host")
	}
	if len(signers) == 0 {
		return signedRelease{}, newUpdateRefusal(codeSignatureInvalid, "the signature of the pinned key doesn't verify over release.json")
	}
	manifest, err := ParseReleaseManifest(in.Manifest)
	if err != nil {
		return signedRelease{}, err
	}
	if manifest.IssuedAt.Sub(in.Now) > releaseFutureIssue {
		return signedRelease{}, newUpdateRefusal(codeManifestInvalid, "release.json was issued at %s, more than 24 hours after this host's clock; check the clock", formatReleaseInstant(manifest.IssuedAt))
	}
	if !in.Now.Before(manifest.ExpiresAt) {
		return signedRelease{}, newUpdateRefusal(codeManifestExpired, "this release expired at %s", formatReleaseInstant(manifest.ExpiresAt))
	}
	return signedRelease{manifest: manifest, digest: Digest(in.Manifest), signers: signers, pins: pins, floors: floors}, nil
}

// followRollovers follows the statements in order. A statement is ignored when
// it doesn't parse, when its from is not a key pinned at that point of the
// chain, or when its signature doesn't verify under that key. Otherwise the
// host pins the successor, drops the key it replaced and carries that key's
// floor over. A fork is two statements from one pinned key that both verify and
// name different successors, neither followed yet: someone else holds the key.
// Two statements naming the same successor are not a fork, and once a host has
// followed A to B, A is no longer pinned, so a later statement from A is
// ignored and never a conflict: a server that relays old public statements
// can't freeze a fleet.
func followRollovers(pinned []ReleaseKey, floors map[string]uint64, envelopes []RolloverEnvelope) (map[string]ReleaseKey, map[string]uint64, error) {
	pins := make(map[string]ReleaseKey, len(pinned))
	for _, key := range pinned {
		if !key.IsZero() {
			pins[key.Fingerprint()] = key
		}
	}
	held := make(map[string]uint64, len(floors))
	maps.Copy(held, floors)
	statements := make([]*Rollover, len(envelopes))
	for i, envelope := range envelopes {
		if rollover, err := envelope.Parse(); err == nil {
			statements[i] = &rollover
		}
	}
	for index, statement := range statements {
		if statement == nil {
			continue
		}
		replaced, isPinned := pins[statement.From]
		if !isPinned || !statement.VerifiedBy(replaced) {
			continue
		}
		for _, other := range statements[index+1:] {
			if other != nil && other.From == statement.From && other.To.Fingerprint() != statement.To.Fingerprint() && other.VerifiedBy(replaced) {
				successors := []string{statement.To.Fingerprint(), other.To.Fingerprint()}
				sort.Strings(successors)
				return nil, nil, &UpdateRefusal{
					Code:       codeKeyRolloverConflict,
					Detail:     fmt.Sprintf("two statements from key %s name different successors, %s and %s: someone else may hold that key", replaced.ShortID(), successors[0][:16], successors[1][:16]),
					From:       statement.From,
					Successors: successors,
				}
			}
		}
		successor := statement.To.Fingerprint()
		delete(pins, statement.From)
		pins[successor] = statement.To
		held[successor] = max(held[successor], held[statement.From])
		delete(held, statement.From)
	}
	return pins, held, nil
}
