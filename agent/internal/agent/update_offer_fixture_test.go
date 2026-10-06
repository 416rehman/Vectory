package agent

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The fixture of the tests of an offer of an agent build: a device that has
// consented (a policy in a tree the test owns, with the key of a release signer
// pinned), a privileged step that "runs" (a status the test writes), and a control
// plane that offers a release signed by that key and serves its build on the
// route the contract names. Each test changes one thing and says what the agent
// did about it.

const defaultRollout = "c3a1d5e8-6f0b-4a53-9a84-52d7f0a1b6e4"

type offerRig struct {
	*checkDevice
	t       *testing.T
	paths   UpdatePaths
	private ReleasePrivateKey
	public  ReleaseKey
	said    []string

	// The release in the offer.
	build      []byte
	manifest   []byte
	signatures []byte
	rollovers  []RolloverEnvelope
	releaseSHA string
	buildSHA   string

	mu sync.Mutex
	// serveBuild answers the download; the default sends the build whole.
	serveBuild func(w http.ResponseWriter, r *http.Request)
	hits       int
}

func platformArtifact(build []byte, version string) ReleaseArtifact {
	file := "vectory-" + version + "-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	return ReleaseArtifact{OS: runtime.GOOS, Arch: runtime.GOARCH, Format: "executable", File: file, Size: int64(len(build)), SHA256: Digest(build)}
}

// newOfferRig is a device whose host consented (auto, patch releases, any time),
// whose step ran a moment ago and is idle, and that is offered agent 0.1.1.
func newOfferRig(t *testing.T) *offerRig {
	t.Helper()
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("a release names builds for amd64 and arm64")
	}
	requireRootOwnedWriter(t) // the host's policy and the step's status are root's to write
	d := newCheckDevice(t)
	rig := &offerRig{checkDevice: d, t: t, paths: useUpdateRoots(t)}
	rig.private = testPrivateKey(t, 1)
	rig.public = testPublicKey(t, rig.private, "team")
	rig.build = bytes.Repeat([]byte("a build of the agent. "), 20_000)
	d.e.Notice = func(line string) { rig.said = append(rig.said, line) }
	d.e.BootID = RandomID()
	d.e.State.Agent = &AgentBuild{Version: Version, SHA256: Digest([]byte("the running build"))}
	features := []string{featureValidation, featureAgentUpdate}
	d.plane.with(func(m *Manifest) { m.Features = features })
	d.e.State.ServerFeatures = features
	rig.consent(UpdateConsentAuto)
	rig.step(nil)
	d.plane.Config.Handler = http.HandlerFunc(rig.handle)
	rig.release(nil)
	return rig
}

func (r *offerRig) handle(w http.ResponseWriter, req *http.Request) {
	if strings.HasPrefix(req.URL.Path, updateReleasePath) {
		r.mu.Lock()
		r.hits++
		serve := r.serveBuild
		r.mu.Unlock()
		if serve == nil {
			serve = r.sendBuild
		}
		serve(w, req)
		return
	}
	r.plane.serve(w, req)
}

// sendBuild is the route as the contract says: the build, with its length.
func (r *offerRig) sendBuild(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(r.build)))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(r.build)
}

// requests is how many times the build was asked for.
func (r *offerRig) requests() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hits
}

func (r *offerRig) answerWith(serve func(w http.ResponseWriter, req *http.Request)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.serveBuild = serve
}

// consent writes the host's policy: the signer's key pinned, with the level.
func (r *offerRig) consent(level string, windows ...string) {
	r.t.Helper()
	r.policy(func(p *UpdatePolicy) {
		*p = UpdatePolicy{Consent: level, Track: UpdateTrackPatch, Windows: windows, Keys: []PinnedKey{{Key: r.public, PinnedAt: time.Now().UTC().Truncate(time.Second)}}}
	})
}

// policy changes the host's policy as root would.
func (r *offerRig) policy(change func(*UpdatePolicy)) {
	r.t.Helper()
	policy := DefaultUpdatePolicy()
	if have, _, err := readUpdatePolicy(r.paths); err == nil {
		policy = have
	}
	change(&policy)
	if err := WriteUpdatePolicy(policy); err != nil {
		r.t.Fatal(err)
	}
}

// step writes what the privileged step writes at each run: it ran a moment ago,
// the host can take updates and it is idle, unless the test says otherwise.
func (r *offerRig) step(change func(*UpdateStatus)) {
	r.t.Helper()
	status := UpdateStatus{RunAt: time.Now().UTC().Truncate(time.Second), Stage: UpdateStageIdle, Eligibility: UpdateEligible, ServiceDefinition: 1, HighestCounters: map[string]uint64{}}
	if change != nil {
		change(&status)
	}
	dir, err := ensureRootOwnedDir(r.paths.StepDir, rootReadable)
	if err != nil {
		r.t.Fatal(err)
	}
	defer dir.Close()
	if err := WriteUpdateStatus(dir, status); err != nil {
		r.t.Fatal(err)
	}
}

// readStatus is what the step last wrote.
func (r *offerRig) readStatus() UpdateStatus {
	r.t.Helper()
	status, err := ReadUpdateStatus()
	if err != nil {
		r.t.Fatal(err)
	}
	return status
}

// release signs a release of agent 0.1.1 for this platform (counter 7, issued an
// hour ago, valid for 90 days), after the test changed it, and has the manifest
// offer it.
func (r *offerRig) release(change func(*ReleaseManifest)) {
	r.t.Helper()
	manifest := r.defaultRelease()
	if change != nil {
		change(&manifest)
	}
	bytes, err := BuildReleaseManifest(manifest)
	if err != nil {
		r.t.Fatal(err)
	}
	r.offerSigned(bytes, r.private, r.public)
}

// offerSigned signs manifest bytes as they are, and offers them.
func (r *offerRig) offerSigned(manifest []byte, private ReleasePrivateKey, public ReleaseKey) {
	r.t.Helper()
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(public, private.SignRelease(manifest))})
	if err != nil {
		r.t.Fatal(err)
	}
	r.offer(manifest, signatures, nil)
}

// sign is the signature file of manifest bytes by the signer the host pins.
func (r *offerRig) sign(manifest []byte) []byte {
	r.t.Helper()
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(r.public, r.private.SignRelease(manifest))})
	if err != nil {
		r.t.Fatal(err)
	}
	return signatures
}

// craft offers the default release with its bytes changed, signed as they are:
// a release that breaks a rule of its format and is signed anyway.
func (r *offerRig) craft(change func(manifest string) string) {
	r.t.Helper()
	manifest, err := BuildReleaseManifest(r.defaultRelease())
	if err != nil {
		r.t.Fatal(err)
	}
	crafted := []byte(change(string(manifest)))
	r.offer(crafted, r.sign(crafted), nil)
}

// defaultRelease is the manifest release offers when a test changes nothing.
func (r *offerRig) defaultRelease() ReleaseManifest {
	return ReleaseManifest{
		Version: "0.1.1", Counter: 7, IssuedAt: time.Now().UTC().Add(-time.Hour).Truncate(time.Second), ExpiresAt: time.Now().UTC().Add(90 * 24 * time.Hour).Truncate(time.Second),
		ServiceDefinition: 1, Artifacts: []ReleaseArtifact{platformArtifact(r.build, "0.1.1")},
	}
}

// offer has the manifest carry the offer of exactly these bytes, with the artifact
// the manifest names for this platform (when it parses).
func (r *offerRig) offer(manifest, signatures []byte, rollovers []RolloverEnvelope) {
	r.t.Helper()
	r.manifest, r.signatures, r.rollovers = manifest, signatures, rollovers
	r.releaseSHA = Digest(manifest)
	artifact := map[string]any{"sha256": Digest(r.build), "size": len(r.build), "path": updateReleasePath + Digest(r.build)}
	if parsed, err := ParseReleaseManifest(manifest); err == nil {
		if mine, ok := parsed.ArtifactFor(runtime.GOOS, runtime.GOARCH); ok {
			artifact = map[string]any{"sha256": mine.SHA256, "size": mine.Size, "path": updateReleasePath + mine.SHA256}
			r.buildSHA = mine.SHA256
		}
	}
	r.offerMember(map[string]any{"artifact": artifact})
}

// offerMember writes the manifest member from the current release, with the
// members the test overrides (a nil value removes one).
func (r *offerRig) offerMember(override map[string]any) {
	r.t.Helper()
	rollovers := r.rollovers
	if rollovers == nil {
		rollovers = []RolloverEnvelope{}
	}
	member := map[string]any{
		"rollout_id": defaultRollout, "release_id": "7d2b9c40-1e35-4f6a-8b17-0c9e4d3a5f21",
		"manifest": base64.StdEncoding.EncodeToString(r.manifest), "signatures": base64.StdEncoding.EncodeToString(r.signatures),
		"rollovers": rollovers,
	}
	for name, value := range override {
		if value == nil {
			delete(member, name)
		} else {
			member[name] = value
		}
	}
	raw, err := json.Marshal(member)
	if err != nil {
		r.t.Fatal(err)
	}
	r.plane.with(func(m *Manifest) { m.AgentUpdate = raw })
}

// withdraw has the manifest stop offering anything.
func (r *offerRig) withdraw() { r.plane.with(func(m *Manifest) { m.AgentUpdate = nil }) }

// settle polls until the transfer in the background has ended and its result was
// taken in. It fails the test when it doesn't end.
func (r *offerRig) settle() {
	r.t.Helper()
	r.poll()
	for i := 0; i < 5 && r.e.update.download != nil; i++ {
		select {
		case <-r.e.update.download.done:
		case <-time.After(10 * time.Second):
			r.t.Fatal("the transfer didn't end")
		}
		r.poll()
	}
}

// beat is the report the newest heartbeat carried, or nil.
func (r *offerRig) beat() map[string]any {
	member, _ := r.plane.last()["agent_update"].(map[string]any)
	return member
}

// exchangeDir is where the agent stages for the step.
func (r *offerRig) exchange() UpdateExchange { return UpdateExchangeFor(r.state) }

// staged lists the digests the agent has staged builds for.
func (r *offerRig) staged() []string {
	r.t.Helper()
	entries, err := os.ReadDir(r.exchange().Incoming)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		r.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// stagedFile is the path of a file of the build staged for this release.
func (r *offerRig) stagedFile(name string) string {
	return filepath.Join(r.exchange().Incoming, r.releaseSHA, name)
}

func (r *offerRig) said1(want string) bool {
	for _, line := range r.said {
		if strings.Contains(line, want) {
			return true
		}
	}
	return false
}

// nothingUnderUpdates fails the test when the agent made anything in its state
// directory for updates.
func (r *offerRig) nothingUnderUpdates() {
	r.t.Helper()
	if _, err := os.Lstat(r.exchange().Dir); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(r.exchange().Dir)
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		r.t.Fatalf("the agent made %s (%v) where it should have made nothing: %v", r.exchange().Dir, names, err)
	}
}
