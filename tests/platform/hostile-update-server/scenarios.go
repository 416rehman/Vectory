package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------- the offer

type artifactRef struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Path   string `json:"path"`
}

type rolloverEnvelope struct {
	Statement string `json:"statement"`
	Signature string `json:"signature"`
}

// offer is the manifest member agent_update of the contract: the members in the
// contract's order.
type offer struct {
	RolloutID  string             `json:"rollout_id"`
	ReleaseID  string             `json:"release_id"`
	Manifest   string             `json:"manifest"`
	Signatures string             `json:"signatures"`
	Rollovers  []rolloverEnvelope `json:"rollovers"`
	Artifact   artifactRef        `json:"artifact"`
}

// crafted is one scenario's offer and the code a host must answer it with.
type crafted struct {
	Name  string `json:"name"`
	Code  string `json:"code"`
	About string `json:"about"`
	Offer offer  `json:"offer"`
}

// ---------------------------------------------------------------- keys and signed files

const (
	releaseSignaturePrefix  = "vectory-agent-release-v1\n"
	rolloverSignaturePrefix = "vectory-release-key-rollover-v1\n"
	privateKeyPrefix        = "vectory-release-private-key ed25519 "
)

type releaseKey struct {
	private ed25519.PrivateKey
	name    string
}

func (k releaseKey) public() ed25519.PublicKey { return k.private.Public().(ed25519.PublicKey) }

func (k releaseKey) fingerprint() string {
	sum := sha256.Sum256(k.public())
	return hex.EncodeToString(sum[:])
}

func (k releaseKey) line() string {
	return "vectory-release-key ed25519 " + base64.StdEncoding.EncodeToString(k.public()) + " " + k.name
}

func (k releaseKey) sign(prefix string, message []byte) []byte {
	return ed25519.Sign(k.private, append([]byte(prefix), message...))
}

// readReleaseKey reads a private key file as `vectory release keygen` writes it: one
// line, the prefix and the base64 of the 32-byte seed.
func readReleaseKey(path, name string) (releaseKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return releaseKey{}, err
	}
	rest, ok := strings.CutPrefix(strings.TrimSpace(string(data)), privateKeyPrefix)
	if !ok {
		return releaseKey{}, fmt.Errorf("%s isn't a release private key", path)
	}
	seed, err := base64.StdEncoding.DecodeString(rest)
	if err != nil || len(seed) != ed25519.SeedSize {
		return releaseKey{}, fmt.Errorf("%s doesn't hold a 32-byte seed", path)
	}
	return releaseKey{private: ed25519.NewKeyFromSeed(seed), name: name}, nil
}

func freshKey(name string) releaseKey {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return releaseKey{private: private, name: name}
}

func signWith(seed []byte, message []byte) []byte {
	return ed25519.Sign(ed25519.NewKeyFromSeed(seed), message)
}

func instant(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

type artifact struct {
	OS, Arch, File string
	Size           int64
	SHA256         string
}

type releaseSpec struct {
	Version         string
	Counter         uint64
	Issued, Expires time.Time
	MinFrom         string
	Artifacts       []artifact
}

// bytes writes the manifest as the server does: one line, the members in the
// contract's order, no space and no final line feed.
func (r releaseSpec) bytes() []byte {
	var out strings.Builder
	fmt.Fprintf(&out, `{"schema":"vectory.agent-release.v1","version":%q,"counter":%d,"issued_at":%q,"expires_at":%q,`, r.Version, r.Counter, instant(r.Issued), instant(r.Expires))
	if r.MinFrom != "" {
		fmt.Fprintf(&out, `"min_from":%q,`, r.MinFrom)
	}
	out.WriteString(`"service_definition":1,"artifacts":[`)
	for i, a := range r.Artifacts {
		if i > 0 {
			out.WriteString(",")
		}
		fmt.Fprintf(&out, `{"os":%q,"arch":%q,"format":"executable","file":%q,"size":%d,"sha256":%q}`, a.OS, a.Arch, a.File, a.Size, a.SHA256)
	}
	out.WriteString("]}")
	return []byte(out.String())
}

func signatureFile(manifest []byte, signers ...releaseKey) []byte {
	var out strings.Builder
	out.WriteString(`{"schema":"vectory.agent-release-signatures.v1","signatures":[`)
	for i, key := range signers {
		if i > 0 {
			out.WriteString(",")
		}
		fmt.Fprintf(&out, `{"key":%q,"signature":%q}`, key.fingerprint(), base64.StdEncoding.EncodeToString(key.sign(releaseSignaturePrefix, manifest)))
	}
	out.WriteString("]}")
	return []byte(out.String())
}

// rollover is a statement that from hands over to to, signed by from.
func rollover(from, to releaseKey, at time.Time) rolloverEnvelope {
	statement := []byte(`{"schema":"vectory.release-key-rollover.v1","from":"` + from.fingerprint() + `","to":"` + to.line() + `","issued_at":"` + instant(at) + `"}`)
	return rolloverEnvelope{
		Statement: base64.StdEncoding.EncodeToString(statement),
		Signature: base64.StdEncoding.EncodeToString(from.sign(rolloverSignaturePrefix, statement)),
	}
}

// ---------------------------------------------------------------- what the scenarios are made from

type buildFile struct {
	size   int64
	sha256 string
}

func readBuild(path string) (buildFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return buildFile{}, err
	}
	sum := sha256.Sum256(data)
	return buildFile{size: int64(len(data)), sha256: hex.EncodeToString(sum[:])}, nil
}

// craft is what one scenario is made from: the keys, the build, the time and the
// facts about the host that decide what a refusal needs (the floor, the release it
// rolled back).
type craft struct {
	cfg                *config
	now                time.Time
	pinned, other, old releaseKey
	build              buildFile
	floor              uint64
	tried              *triedRelease
}

type triedRelease struct {
	manifest, signatures []byte
}

func (c *craft) platform() (string, string) { return c.cfg.goos, c.cfg.goarch }

func (c *craft) fileName(version, goos, goarch string) string {
	name := fmt.Sprintf("vectory-%s-%s-%s", version, goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

func (c *craft) entry(version, goos, goarch string) artifact {
	return artifact{OS: goos, Arch: goarch, File: c.fileName(version, goos, goarch), Size: c.build.size, SHA256: c.build.sha256}
}

// genuine is a release in every way a host takes: signed by the key it pins, newer
// than what runs, with a counter above its floor, issued an hour ago.
func (c *craft) genuine() releaseSpec {
	goos, goarch := c.platform()
	return releaseSpec{
		Version: "0.1.99", Counter: c.floor + 100, Issued: c.now.Add(-time.Hour), Expires: c.now.Add(180 * 24 * time.Hour),
		MinFrom: "0.1.0", Artifacts: []artifact{c.entry("0.1.99", goos, goarch)},
	}
}

func newID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	raw[6], raw[8] = raw[6]&0x0f|0x40, raw[8]&0x3f|0x80
	h := hex.EncodeToString(raw[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// ref is the artifact member for the host's platform of a release.
func (c *craft) ref(spec releaseSpec) artifactRef {
	goos, goarch := c.platform()
	for _, a := range spec.Artifacts {
		if a.OS == goos && a.Arch == goarch {
			return artifactRef{SHA256: a.SHA256, Size: a.Size, Path: "/agent/v1/agent-releases/" + a.SHA256}
		}
	}
	return artifactRef{SHA256: c.build.sha256, Size: c.build.size, Path: "/agent/v1/agent-releases/" + c.build.sha256}
}

// signed is the offer of a release signed by signers, with statements.
func (c *craft) signed(spec releaseSpec, statements []rolloverEnvelope, signers ...releaseKey) offer {
	manifest := spec.bytes()
	if statements == nil {
		statements = []rolloverEnvelope{}
	}
	return offer{
		RolloutID: newID(), ReleaseID: newID(),
		Manifest: base64.StdEncoding.EncodeToString(manifest), Signatures: base64.StdEncoding.EncodeToString(signatureFile(manifest, signers...)),
		Rollovers: statements, Artifact: c.ref(spec),
	}
}

// ---------------------------------------------------------------- the scenarios

type scenario struct {
	name  string
	code  string
	about string
	build func(*craft) (offer, error)
}

var scenarios = []scenario{
	{"genuine", "", "A release in every way a host takes. No check sends it: the other scenarios are measured against it.",
		func(c *craft) (offer, error) { return c.signed(c.genuine(), nil, c.pinned), nil }},
	{"wrong_key", "KEY_NOT_PINNED", "Signed by a key the host doesn't pin.",
		func(c *craft) (offer, error) { return c.signed(c.genuine(), nil, c.other), nil }},
	{"flipped_byte", "SIGNATURE_INVALID", "Signed by the pinned key, then one digit of the manifest changed.",
		func(c *craft) (offer, error) {
			spec := c.genuine()
			good := spec.bytes()
			at := strings.Index(string(good), `"size":`)
			if at < 0 {
				return offer{}, errors.New("the manifest has no size")
			}
			at += len(`"size":`)
			flipped := append([]byte(nil), good...)
			flipped[at] = '1' + (flipped[at]-'1'+1)%9
			made := c.signed(spec, nil, c.pinned)
			made.Manifest = base64.StdEncoding.EncodeToString(flipped)
			return made, nil
		}},
	{"lower_counter", "COUNTER_REPLAYED", "Signed by the pinned key, with a counter at the floor the host holds for it.",
		func(c *craft) (offer, error) {
			if c.floor == 0 {
				return offer{}, errors.New("the host holds no counter floor yet: run this after an update has been tried on it")
			}
			spec := c.genuine()
			spec.Counter = c.floor
			return c.signed(spec, nil, c.pinned), nil
		}},
	{"expired", "MANIFEST_EXPIRED", "Signed by the pinned key, and expired an hour ago.",
		func(c *craft) (offer, error) {
			spec := c.genuine()
			spec.Issued, spec.Expires = c.now.Add(-100*24*time.Hour), c.now.Add(-time.Hour)
			return c.signed(spec, nil, c.pinned), nil
		}},
	{"issued_ahead", "MANIFEST_INVALID", "Signed by the pinned key, and issued a day and an hour in the future.",
		func(c *craft) (offer, error) {
			spec := c.genuine()
			spec.Issued = c.now.Add(25 * time.Hour)
			spec.Expires = spec.Issued.Add(180 * 24 * time.Hour)
			return c.signed(spec, nil, c.pinned), nil
		}},
	{"wrong_platform", "PLATFORM_NOT_IN_RELEASE", "Signed by the pinned key, with a build for another operating system only.",
		func(c *craft) (offer, error) {
			spec := c.genuine()
			goos, goarch := "windows", "amd64"
			if c.cfg.goos == "windows" {
				goos = "linux"
			}
			spec.Artifacts = []artifact{c.entry(spec.Version, goos, goarch)}
			return c.signed(spec, nil, c.pinned), nil
		}},
	{"artifact_path_elsewhere", "MANIFEST_INVALID", "Signed by the pinned key; the offer's artifact member names the manifest's digest and a path to another one.",
		func(c *craft) (offer, error) {
			made := c.signed(c.genuine(), nil, c.pinned)
			other := sha256.Sum256([]byte("another build"))
			made.Artifact.Path = "/agent/v1/agent-releases/" + hex.EncodeToString(other[:])
			return made, nil
		}},
	{"artifact_disagrees", "MANIFEST_INVALID", "Signed by the pinned key; the offer's artifact member isn't the manifest's entry for this platform.",
		func(c *craft) (offer, error) {
			made := c.signed(c.genuine(), nil, c.pinned)
			other := sha256.Sum256([]byte("another build"))
			made.Artifact = artifactRef{SHA256: hex.EncodeToString(other[:]), Size: c.build.size + 1, Path: "/agent/v1/agent-releases/" + hex.EncodeToString(other[:])}
			return made, nil
		}},
	{"old_statement", "KEY_NOT_PINNED", "A statement from a key the host already left, relayed with a release that key signed.",
		func(c *craft) (offer, error) {
			return c.signed(c.genuine(), []rolloverEnvelope{rollover(c.old, c.pinned, c.now.Add(-48*time.Hour))}, c.old), nil
		}},
	{"unpinned_rollover", "KEY_NOT_PINNED", "A statement between two keys the host never pinned, and a release the second one signed.",
		func(c *craft) (offer, error) {
			first, second := freshKey("stranger"), freshKey("stranger-next")
			return c.signed(c.genuine(), []rolloverEnvelope{rollover(first, second, c.now.Add(-time.Hour))}, second), nil
		}},
	{"already_tried", "RELEASE_ALREADY_TRIED", "The release that rolled back on this host, offered again under a new rollout.",
		func(c *craft) (offer, error) {
			if c.tried == nil {
				return offer{}, errors.New("no rolled back release was given (--tried-release)")
			}
			var parsed struct {
				Artifacts []struct {
					OS     string `json:"os"`
					Arch   string `json:"arch"`
					Size   int64  `json:"size"`
					SHA256 string `json:"sha256"`
				} `json:"artifacts"`
			}
			if err := json.Unmarshal(c.tried.manifest, &parsed); err != nil {
				return offer{}, fmt.Errorf("the rolled back release's manifest: %w", err)
			}
			goos, goarch := c.platform()
			for _, a := range parsed.Artifacts {
				if a.OS == goos && a.Arch == goarch {
					return offer{
						RolloutID: newID(), ReleaseID: newID(),
						Manifest: base64.StdEncoding.EncodeToString(c.tried.manifest), Signatures: base64.StdEncoding.EncodeToString(c.tried.signatures),
						Rollovers: []rolloverEnvelope{}, Artifact: artifactRef{SHA256: a.SHA256, Size: a.Size, Path: "/agent/v1/agent-releases/" + a.SHA256},
					}, nil
				}
			}
			return offer{}, errors.New("the rolled back release has no build for this platform")
		}},
	{"consent_off", "UPDATES_OFF", "A release in every way a host takes, offered to a host whose consent is off.",
		func(c *craft) (offer, error) { return c.signed(c.genuine(), nil, c.pinned), nil }},
	// A fork freezes the host until it is pinned again, so it goes last.
	{"fork", "KEY_ROLLOVER_CONFLICT", "Two statements from the pinned key naming different successors, and a release one successor signed.",
		func(c *craft) (offer, error) {
			first, second := freshKey("successor-a"), freshKey("successor-b")
			statements := []rolloverEnvelope{rollover(c.pinned, first, c.now.Add(-time.Hour)), rollover(c.pinned, second, c.now.Add(-time.Hour))}
			return c.signed(c.genuine(), statements, first), nil
		}},
}

func scenarioByName(name string) (scenario, bool) {
	for _, s := range scenarios {
		if s.name == name {
			return s, true
		}
	}
	return scenario{}, false
}

// ---------------------------------------------------------------- crafting from a running server

// loadCraft reads what scenarios are made from: the keys, the build, the host's
// floor for the pinned key and the release that rolled back.
func (cfg *config) loadCraft(now time.Time) (*craft, error) {
	c := &craft{cfg: cfg, now: now}
	var err error
	if c.pinned, err = readReleaseKey(cfg.pinnedKey, "team"); err != nil {
		return nil, err
	}
	if c.other, err = readReleaseKey(cfg.otherKey, "stranger"); err != nil {
		return nil, err
	}
	if c.old, err = readReleaseKey(cfg.oldKey, "team-old"); err != nil {
		return nil, err
	}
	if c.build, err = readBuild(cfg.build); err != nil {
		return nil, err
	}
	if cfg.triedDir != "" {
		manifest, err := os.ReadFile(filepath.Join(cfg.triedDir, "release.json"))
		if err != nil {
			return nil, err
		}
		signatures, err := os.ReadFile(filepath.Join(cfg.triedDir, "release.json.sig"))
		if err != nil {
			return nil, err
		}
		c.tried = &triedRelease{manifest: manifest, signatures: signatures}
	}
	return c, nil
}

// floorOf is the floor the step reports for a key in its status file.
func floorOf(statusFile, fingerprint string) (uint64, error) {
	data, err := os.ReadFile(statusFile)
	if err != nil {
		return 0, err
	}
	var status struct {
		Floors map[string]json.Number `json:"highest_counters"`
	}
	if err := json.Unmarshal(data, &status); err != nil {
		return 0, fmt.Errorf("%s: %w", statusFile, err)
	}
	value, found := status.Floors[fingerprint]
	if !found {
		return 0, nil
	}
	return strconv.ParseUint(value.String(), 10, 64)
}

// craftLocked makes (once) the offer of a scenario from what the host is now.
func (s *server) craftLocked(name string) (*crafted, error) {
	if done := s.crafted[name]; done != nil {
		return done, nil
	}
	spec, known := scenarioByName(name)
	if !known {
		return nil, fmt.Errorf("no scenario %q", name)
	}
	c, err := s.cfg.loadCraft(s.now())
	if err != nil {
		return nil, err
	}
	if c.floor, err = floorOf(s.cfg.statusFile, c.pinned.fingerprint()); err != nil {
		return nil, err
	}
	made, err := spec.build(c)
	if err != nil {
		return nil, err
	}
	done := &crafted{Name: spec.name, Code: spec.code, About: spec.about, Offer: made}
	s.crafted[name] = done
	return done, nil
}

// ---------------------------------------------------------------- the key bundle

// bundle is the answer of GET /agent/v1/release-keys. An honest one lists the key
// the host is to pin. One that lies lists another key under the pinned key's
// fingerprint: a setup that matched on the member instead of the key would pin it.
func (s *server) bundle(mode string) ([]byte, error) {
	c, err := s.cfg.loadCraft(s.now())
	if err != nil {
		return nil, err
	}
	return bundleFor(c, mode), nil
}

func bundleFor(c *craft, mode string) []byte {
	key, fingerprint := c.pinned, c.pinned.fingerprint()
	if mode == "lies" {
		key = c.other
	}
	return []byte(fmt.Sprintf(`{"schema":"vectory.release-keys.v1","keys":[{"public_key":%q,"fingerprint":%q,"state":"current"}],"rollovers":[]}`, key.line(), fingerprint))
}

// ---------------------------------------------------------------- the dump

// dump writes every scenario's offer, with what a host that took them would have
// to hold for the code to be the one given, so that a test of the agent can check
// each against the verification a host runs.
func dump(cfg *config) error {
	if cfg.out == "" || cfg.pinnedKey == "" || cfg.otherKey == "" || cfg.oldKey == "" || cfg.build == "" {
		return errors.New("dump needs --out, --pinned-key, --other-key, --old-key and --build")
	}
	now := time.Now().UTC().Truncate(time.Second)
	if cfg.now != "" {
		var err error
		if now, err = time.Parse(time.RFC3339, cfg.now); err != nil {
			return err
		}
	}
	c, err := cfg.loadCraft(now)
	if err != nil {
		return err
	}
	c.floor = cfg.floor
	type host struct {
		OS             string `json:"os"`
		Arch           string `json:"arch"`
		RunningVersion string `json:"running_version"`
		Track          string `json:"track"`
		Now            string `json:"now"`
	}
	out := struct {
		Host      host              `json:"host"`
		Pins      []string          `json:"pins"`
		Floors    map[string]uint64 `json:"floors"`
		Tried     string            `json:"tried_manifest_sha256,omitempty"`
		Bundles   map[string]string `json:"bundles"`
		Scenarios []crafted         `json:"scenarios"`
	}{
		Host:    host{OS: cfg.goos, Arch: cfg.goarch, RunningVersion: cfg.runningVersion, Track: "patch", Now: instant(now)},
		Pins:    []string{c.pinned.line()},
		Floors:  map[string]uint64{c.pinned.fingerprint(): cfg.floor},
		Bundles: map[string]string{"honest": string(bundleFor(c, "honest")), "lies": string(bundleFor(c, "lies"))},
	}
	if c.tried != nil {
		sum := sha256.Sum256(c.tried.manifest)
		out.Tried = hex.EncodeToString(sum[:])
	}
	for _, spec := range scenarios {
		made, err := spec.build(c)
		if err != nil {
			if spec.name == "already_tried" && c.tried == nil {
				continue
			}
			return fmt.Errorf("%s: %w", spec.name, err)
		}
		out.Scenarios = append(out.Scenarios, crafted{Name: spec.name, Code: spec.code, About: spec.about, Offer: made})
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfg.out, append(data, '\n'), 0o644)
}
