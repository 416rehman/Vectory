package agent

import (
	"errors"
	"fmt"
	"slices"
	"time"
)

// The update policy is a host's consent: whether it takes agent updates from the
// dashboard, on which track, inside which windows, and which release keys it
// pins. It is written only by root (vectory setup, vectory update, and the
// privileged step for the pins after a rollover) in a directory only root can
// write, and it is not in settings.json: that file belongs to the service
// account, and for updates it would turn the service account into root. A host
// with no policy file never updates remotely.
//
// Every reader opens the file through openRootOwned. A server can narrow what a
// host allowed and never widen it, and nothing the service account can write
// changes what this file says.

const (
	// UpdateConsentOff, UpdateConsentAuto and UpdateConsentAsk are the levels a
	// host consents to: nothing, automatic inside its windows, or after someone
	// on the host runs `vectory update apply`.
	UpdateConsentOff  = "off"
	UpdateConsentAuto = "auto"
	UpdateConsentAsk  = "ask"
	// UpdateTrackPatch takes the running major and minor with a newer patch;
	// UpdateTrackMinor takes the running major with a newer minor or patch. There
	// is no major track.
	UpdateTrackPatch = ReleaseTrackPatch
	UpdateTrackMinor = ReleaseTrackMinor

	updatePolicySchema = "vectory.update-policy.v1"
	// maxUpdatePolicy bounds the file: four keys and seven windows are about 1.5 KiB.
	maxUpdatePolicy = 8 * 1024
	maxPinnedKeys   = 4
	// The lock file is persistent: removing it would let another writer lock a
	// different inode while the first writer still holds the old one.
	updatePolicyLockFile = "policy.lock"
)

// ErrUpdatePolicyInvalid is what a policy file that is not what the contract
// says wraps. A host whose policy can't be read takes no update.
var ErrUpdatePolicyInvalid = errors.New("the update policy is invalid")

func invalidPolicy(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrUpdatePolicyInvalid, fmt.Sprintf(format, args...))
}

// PinnedKey is a release key a host trusts to authorize builds, and when it was
// pinned. Pinning a key trusts its holder with root on the host: the installed
// agent runs as the service account, but root runs the same executable.
type PinnedKey struct {
	Key      ReleaseKey
	PinnedAt time.Time
}

// UpdatePolicy is the host's consent, as policy.json holds it. Windows are the
// windows as written (ParseUpdateWindow's grammar); none means any time.
type UpdatePolicy struct {
	Consent   string
	Track     string
	Windows   []string
	Paused    bool
	Keys      []PinnedKey
	UpdatedAt time.Time
}

// DefaultUpdatePolicy is the policy of a host with no policy file: it takes no
// update.
func DefaultUpdatePolicy() UpdatePolicy {
	return UpdatePolicy{Consent: UpdateConsentOff, Track: UpdateTrackPatch}
}

// ParsedWindows parses the policy's windows.
func (p UpdatePolicy) ParsedWindows() (UpdateWindows, error) { return ParseUpdateWindows(p.Windows) }

// PinnedKeys are the keys the policy pins, in order.
func (p UpdatePolicy) PinnedKeys() []ReleaseKey {
	keys := make([]ReleaseKey, len(p.Keys))
	for i, pinned := range p.Keys {
		keys[i] = pinned.Key
	}
	return keys
}

// Fingerprints are the fingerprints of the pinned keys, in order.
func (p UpdatePolicy) Fingerprints() []string {
	fingerprints := make([]string, len(p.Keys))
	for i, pinned := range p.Keys {
		fingerprints[i] = pinned.Key.Fingerprint()
	}
	return fingerprints
}

// SetPinnedKeys makes keys the pinned keys, in that order, for a caller that
// decides the pins and nothing else: the privileged step after a rollover. A key
// that was already pinned keeps the time it was pinned; a new key has none, and
// is pinned when the policy is written. A key listed twice, or more keys than a
// host pins, is refused when the policy is written, not here.
func (p *UpdatePolicy) SetPinnedKeys(keys []ReleaseKey) {
	pinnedAt := make(map[string]time.Time, len(p.Keys))
	for _, pinned := range p.Keys {
		pinnedAt[pinned.Key.Fingerprint()] = pinned.PinnedAt
	}
	pinned := make([]PinnedKey, len(keys))
	for i, key := range keys {
		pinned[i] = PinnedKey{Key: key, PinnedAt: pinnedAt[key.Fingerprint()]}
	}
	p.Keys = pinned
}

type updatePolicyWire struct {
	Schema    string                `json:"schema"`
	Consent   string                `json:"consent"`
	Track     string                `json:"track"`
	Windows   []string              `json:"windows"`
	Paused    *bool                 `json:"paused"`
	Keys      []updatePolicyKeyWire `json:"keys"`
	UpdatedAt string                `json:"updated_at"`
}

type updatePolicyKeyWire struct {
	PublicKey string `json:"public_key"`
	PinnedAt  string `json:"pinned_at"`
}

// ParseUpdatePolicy reads the bytes of a policy.json, strictly: a duplicate or
// unknown member, a value of another type, a consent or track that isn't listed,
// more than 7 windows or 4 keys, a window that doesn't parse, a key that fails
// the key rule, a key pinned twice and a level that takes updates with no key
// are all refused.
func ParseUpdatePolicy(data []byte) (UpdatePolicy, error) {
	var wire updatePolicyWire
	if err := decodeStrictJSON(data, &wire); err != nil {
		return UpdatePolicy{}, invalidPolicy("policy.json %v", err)
	}
	_, trackErr := ParseReleaseTrack(wire.Track)
	switch {
	case wire.Schema != updatePolicySchema:
		return UpdatePolicy{}, invalidPolicy("the schema is %q, and this agent reads %q", wire.Schema, updatePolicySchema)
	case !oneOf(wire.Consent, []string{UpdateConsentOff, UpdateConsentAuto, UpdateConsentAsk}):
		return UpdatePolicy{}, invalidPolicy("consent %q isn't off, auto or ask", wire.Consent)
	case trackErr != nil:
		return UpdatePolicy{}, invalidPolicy("track: %v", trackErr)
	case wire.Windows == nil:
		return UpdatePolicy{}, invalidPolicy("windows isn't a list")
	case wire.Paused == nil:
		return UpdatePolicy{}, invalidPolicy("paused isn't true or false")
	case wire.Keys == nil:
		return UpdatePolicy{}, invalidPolicy("keys isn't a list")
	case len(wire.Keys) > maxPinnedKeys:
		return UpdatePolicy{}, invalidPolicy("%d keys are pinned, and a host pins at most %d", len(wire.Keys), maxPinnedKeys)
	}
	if _, err := ParseUpdateWindows(wire.Windows); err != nil {
		return UpdatePolicy{}, invalidPolicy("%v", err)
	}
	policy := UpdatePolicy{Consent: wire.Consent, Track: wire.Track, Windows: slices.Clone(wire.Windows), Paused: *wire.Paused}
	seen := map[string]bool{}
	for i, entry := range wire.Keys {
		key, err := ParseReleaseKey(entry.PublicKey)
		if err != nil {
			return UpdatePolicy{}, invalidPolicy("key %d: %v", i+1, err)
		}
		if seen[key.Fingerprint()] {
			return UpdatePolicy{}, invalidPolicy("key %d pins %s again", i+1, key.ShortID())
		}
		seen[key.Fingerprint()] = true
		pinnedAt, ok := parseUpdateInstant(entry.PinnedAt, false)
		if !ok {
			return UpdatePolicy{}, invalidPolicy("key %d: pinned_at %q isn't a UTC time like 2026-10-03T12:30:00Z", i+1, entry.PinnedAt)
		}
		policy.Keys = append(policy.Keys, PinnedKey{Key: key, PinnedAt: pinnedAt})
	}
	if policy.Consent != UpdateConsentOff && len(policy.Keys) == 0 {
		return UpdatePolicy{}, invalidPolicy("consent is %s and no key is pinned: a host that takes updates pins at least one release key", policy.Consent)
	}
	updatedAt, ok := parseUpdateInstant(wire.UpdatedAt, false)
	if !ok {
		return UpdatePolicy{}, invalidPolicy("updated_at %q isn't a UTC time like 2026-10-03T12:30:00Z", wire.UpdatedAt)
	}
	policy.UpdatedAt = updatedAt
	return policy, nil
}

// MarshalUpdatePolicy writes a policy.json: one line, in the contract's order,
// refused when a reader would refuse it.
func MarshalUpdatePolicy(p UpdatePolicy) ([]byte, error) {
	updatedAt, err := formatUpdateInstant(p.UpdatedAt, false)
	if err != nil {
		return nil, fmt.Errorf("policy.json: updated_at: %w", err)
	}
	paused := p.Paused
	wire := updatePolicyWire{
		Schema: updatePolicySchema, Consent: p.Consent, Track: p.Track, Windows: p.Windows, Paused: &paused,
		Keys: make([]updatePolicyKeyWire, 0, len(p.Keys)), UpdatedAt: updatedAt,
	}
	if wire.Windows == nil {
		wire.Windows = []string{}
	}
	for i, pinned := range p.Keys {
		if pinned.Key.IsZero() {
			return nil, fmt.Errorf("policy.json: key %d isn't a release key", i+1)
		}
		pinnedAt, err := formatUpdateInstant(pinned.PinnedAt, false)
		if err != nil {
			return nil, fmt.Errorf("policy.json: key %d: pinned_at: %w", i+1, err)
		}
		wire.Keys = append(wire.Keys, updatePolicyKeyWire{PublicKey: pinned.Key.Line(), PinnedAt: pinnedAt})
	}
	data, err := marshalLine(wire)
	if err != nil {
		return nil, err
	}
	if len(data) > maxUpdatePolicy {
		return nil, fmt.Errorf("policy.json would be %d bytes, and at most %d are allowed", len(data), maxUpdatePolicy)
	}
	if _, err := ParseUpdatePolicy(data); err != nil {
		return nil, err
	}
	return data, nil
}

// ReadUpdatePolicy reads the host's policy through the path check: the file and
// every directory above it must belong to root and be writable by nobody else,
// or the read is refused with UNTRUSTED_LOCATION (an *UpdateRefusal). A host with
// no policy file has the default policy, which takes no update; so does one whose
// policy directory is missing. A file that is not what the contract says is an
// error that wraps ErrUpdatePolicyInvalid. Callers treat every error as "this
// host takes no update", and report why.
func ReadUpdatePolicy() (UpdatePolicy, error) {
	policy, _, err := readUpdatePolicy(UpdateLocations())
	return policy, err
}

// readUpdatePolicy also returns what the policy was read from: the SHA-256 of
// the file, or "" when there was no file. ChangeUpdatePolicy writes only over
// that.
func readUpdatePolicy(paths UpdatePaths) (UpdatePolicy, string, error) {
	r, err := openRootOwned(paths.Policy, rootOwnedFile)
	if notExist(err) {
		return DefaultUpdatePolicy(), "", nil
	}
	if err != nil {
		return UpdatePolicy{}, "", err
	}
	defer r.Close()
	data, err := r.ReadFile(maxUpdatePolicy)
	if err != nil {
		return UpdatePolicy{}, "", err
	}
	policy, err := ParseUpdatePolicy(data)
	if err != nil {
		return UpdatePolicy{}, "", fmt.Errorf("%s: %w", paths.Policy, err)
	}
	return policy, Digest(data), nil
}

// ErrUpdatePolicyChanged is what ChangeUpdatePolicy answers when the policy kept
// changing under it.
var ErrUpdatePolicyChanged = errors.New("the update policy changed while it was being edited")

var errUpdatePolicyNeedsRoot = errors.New("the update policy can only be written by root (an Administrator on Windows)")

// changeAttempts is how many times ChangeUpdatePolicy reads and writes before it
// gives up on a policy that other writers keep changing.
const changeAttempts = 4

// WriteUpdatePolicy writes the policy, which only root may do: it makes the
// policy's directory (root's, readable by everyone; on Windows with an access
// list of SYSTEM and the Administrators and read for the agent's service) when it
// isn't there, and replaces policy.json atomically with a file everyone can read
// and only root can change. It refuses to write below a directory that isn't
// root's alone, and a policy a reader would refuse. UpdatedAt is set to now, and a
// key with no PinnedAt is pinned now; the policy a caller read keeps the time
// each key was pinned. It replaces whatever is there, so it is for a caller
// that intentionally resets the whole policy; a caller that edits what is
// there uses ChangeUpdatePolicy.
func WriteUpdatePolicy(p UpdatePolicy) error {
	return writeUpdatePolicy(UpdateLocations(), p, time.Now(), nil)
}

// ChangeUpdatePolicy edits the policy as root. The persistent policy lock spans
// the read, change, basis check, atomic rename and directory sync, so another
// cooperating writer cannot overwrite the edit. The digest check also detects
// an out-of-band replacement made before the check; in that case change is
// repeated on the new policy, at most four times. change must make the same
// edit each time; an error from it leaves policy.json unchanged. A host with no policy file
// is edited from the default policy. Used by `vectory update pause`, `resume`
// and `off`, and by the privileged step after a rollover (the pins only).
func ChangeUpdatePolicy(change func(*UpdatePolicy) error) error {
	return changeUpdatePolicy(change, false)
}

// Explicit setup and withdrawal may repair a malformed policy by replacing it
// from the default. Ordinary local edits still refuse malformed input.
func changeUpdatePolicy(change func(*UpdatePolicy) error, repairMalformed bool) error {
	return changeUpdatePolicyWithState(func(p *UpdatePolicy, _, _ bool) error { return change(p) }, repairMalformed)
}

// changeUpdatePolicyWithState also tells the edit whether policy.json existed
// and whether its contents needed repair. A callback may return a sentinel to
// leave an absent or already-off policy untouched after the locked read.
func changeUpdatePolicyWithState(change func(*UpdatePolicy, bool, bool) error, repairMalformed bool) error {
	if !canWriteRootOwned() {
		return errUpdatePolicyNeedsRoot
	}
	paths := UpdateLocations()
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		return err
	}
	defer dir.Close()
	unlock, err := lockUpdatePolicy(dir)
	if err != nil {
		return err
	}
	defer unlock()
	for attempt := 0; attempt < changeAttempts; attempt++ {
		policy, basis, err := readUpdatePolicy(paths)
		basisToCheck := &basis
		malformed := errors.Is(err, ErrUpdatePolicyInvalid) || errors.Is(err, errRootOwnedTooLarge)
		exists := basis != "" || malformed
		if repairMalformed && malformed {
			policy = DefaultUpdatePolicy()
			basisToCheck = nil
			err = nil
		}
		if err != nil {
			return err
		}
		if err := change(&policy, exists, malformed); err != nil {
			return err
		}
		data, err := prepareUpdatePolicy(policy, time.Now())
		if err != nil {
			return err
		}
		if err := writeUpdatePolicyInDir(dir, data, basisToCheck); !errors.Is(err, ErrUpdatePolicyChanged) {
			return err
		}
	}
	return ErrUpdatePolicyChanged
}

// writeUpdatePolicy writes a full replacement under the same lock used by
// ChangeUpdatePolicy. With a basis, the file there must have the basis digest.
func writeUpdatePolicy(paths UpdatePaths, p UpdatePolicy, now time.Time, basis *string) error {
	if !canWriteRootOwned() {
		return errUpdatePolicyNeedsRoot
	}
	data, err := prepareUpdatePolicy(p, now)
	if err != nil {
		return err
	}
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		return err
	}
	defer dir.Close()
	unlock, err := lockUpdatePolicy(dir)
	if err != nil {
		return err
	}
	defer unlock()
	return writeUpdatePolicyInDir(dir, data, basis)
}

func prepareUpdatePolicy(p UpdatePolicy, now time.Time) ([]byte, error) {
	now = now.UTC().Truncate(time.Second)
	p.UpdatedAt = now
	p.Keys = slices.Clone(p.Keys)
	for i := range p.Keys {
		if p.Keys[i].PinnedAt.IsZero() {
			p.Keys[i].PinnedAt = now
		}
	}
	return MarshalUpdatePolicy(p)
}

// Caller holds policy.lock for the entire transaction. Only an uncooperative
// root writer can change policy.json between this basis check and the rename.
func writeUpdatePolicyInDir(dir *rootOwned, data []byte, basis *string) error {
	if basis != nil {
		current, err := dir.ReadFileAt(updatePolicyFile, maxUpdatePolicy)
		digest := ""
		switch {
		case notExist(err):
		case err != nil:
			return err
		default:
			digest = Digest(current)
		}
		if digest != *basis {
			return ErrUpdatePolicyChanged
		}
	}
	return dir.WriteFile(updatePolicyFile, data, rootReadable)
}
