package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Consent in setup. A host takes agent updates only when the command that
// installs or upgrades it says so: --updates auto|ask, the fingerprint of the
// release key to pin (--update-key-sha256), the version track (--update-track)
// and the windows an update may start in (--update-window). Setup checks every
// one of them, and that updates can work here, before it changes anything; it
// writes the policy (a root-owned file outside the state directory) and
// installs the privileged step only after the agent is installed and enrolled.
// A command without update flags touches none of it.

// SetupUpdates is what setup did about agent updates, for --json.
type SetupUpdates struct {
	Consent string   `json:"consent"`
	Track   string   `json:"track,omitempty"`
	Windows []string `json:"windows,omitempty"`
	// Keys are the fingerprints the host pins now.
	Keys   []string `json:"keys,omitempty"`
	Paused bool     `json:"paused,omitempty"`
}

// updatePlan is the update flags of one setup run, checked.
type updatePlan struct {
	consent string
	track   string
	windows []string
	// wanted are the fingerprints the operator gave, in order, each once.
	wanted []string
	// pins are the keys the server's list holds for them, found in a real run.
	pins []ReleaseKey
}

// CheckUpdates refuses update flags that can't work on any host, before setup
// does anything: the command ends with the usage exit code for them.
func (o SetupOptions) CheckUpdates() error {
	_, err := planUpdates(o)
	return err
}

func planUpdates(o SetupOptions) (*updatePlan, error) {
	var given []string
	if len(o.UpdateKeys) > 0 {
		given = append(given, "--update-key-sha256")
	}
	if o.UpdateTrack != "" {
		given = append(given, "--update-track")
	}
	if len(o.UpdateWindows) > 0 {
		given = append(given, "--update-window")
	}
	if o.Updates == "" && len(given) == 0 {
		return nil, nil
	}
	switch o.Updates {
	case UpdateConsentAuto, UpdateConsentAsk, UpdateConsentOff:
	case "":
		return nil, inputError(quoteList(given) + " go with --updates auto or --updates ask. Add --updates, or leave them out.")
	default:
		return nil, inputError(fmt.Sprintf("--updates takes auto, ask or off, and %q isn't one.", o.Updates))
	}
	plan := &updatePlan{consent: o.Updates}
	if plan.consent == UpdateConsentOff {
		if len(given) > 0 {
			return nil, inputError("--updates off turns updates off. It doesn't take " + quoteList(given) + ".")
		}
		return plan, nil
	}
	if len(o.UpdateKeys) == 0 {
		return nil, inputError("--updates " + plan.consent + " needs --update-key-sha256: the SHA-256 fingerprint of the release key this host pins. Add device writes it into the command.")
	}
	for _, value := range o.UpdateKeys {
		fingerprint, err := parseKeyFingerprint(value)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(plan.wanted, fingerprint) {
			plan.wanted = append(plan.wanted, fingerprint)
		}
	}
	if len(plan.wanted) > maxPinnedKeys {
		return nil, inputError(fmt.Sprintf("A host pins at most %d release keys, and %d were given with --update-key-sha256.", maxPinnedKeys, len(plan.wanted)))
	}
	plan.track = UpdateTrackPatch
	if o.UpdateTrack != "" {
		track, err := ParseReleaseTrack(o.UpdateTrack)
		if err != nil {
			return nil, err
		}
		plan.track = track
	}
	if _, err := ParseUpdateWindows(o.UpdateWindows); err != nil {
		return nil, err
	}
	plan.windows = slices.Clone(o.UpdateWindows)
	return plan, nil
}

// parseKeyFingerprint reads a release key's SHA-256 fingerprint as 64
// hexadecimal characters, written as Add device shows it or in groups of eight.
func parseKeyFingerprint(value string) (string, error) {
	clean := strings.ToLower(strings.NewReplacer(" ", "", ":", "", "-", "").Replace(strings.TrimSpace(value)))
	if !isLowerHex64(clean) {
		return "", inputError("--update-key-sha256 needs the 64-character SHA-256 fingerprint of a release key, as Add device and Settings → Agent updates show it.")
	}
	return clean, nil
}

// refuseUpdates ends setup at the Updates step with the reason and the fix.
func (r *setupRun) refuseUpdates(detail, fix string) error {
	_, err := r.fail("updates", "Updates", detail, fix)
	return err
}

// preflightUpdates refuses consent where updates can't work, with the reason and
// the fix, before anything on the host changes. A refusal has no other effect.
func (r *setupRun) preflightUpdates(plan *updatePlan, choice serviceChoice, platform PlatformInfo, agentPath, dir string) error {
	if plan.consent == UpdateConsentOff {
		return r.preflightWithdraw(dir)
	}
	switch {
	case choice.kind == "none" && choice.explicit:
		return r.refuseUpdates("Agent updates need a service. The update step restarts the agent through its service manager, and --service none leaves that to you.", "Leave out --updates, or leave out --service none.")
	case choice.kind == "none":
		return r.refuseUpdates("Agent updates need a service manager, and this host has none ("+choice.reason+").", "Leave out --updates here, or run the agent on a host that has a service manager.")
	}
	switch r.host.updateEligibility(dir) {
	case "PLATFORM_NOT_IN_RELEASE":
		return r.refuseUpdates("Agent updates aren't in this release for "+platformName(platform.OS)+". "+byHand(), "Leave out --updates, and upgrade this host with the Upgrade agent command when a new agent is out.")
	case "PACKAGE_MANAGED":
		return r.refuseUpdates("This agent is installed from a package, and the package manager owns its file.", "Leave out --updates, and upgrade it with the package manager.")
	}
	if problem := untrustedDirectory(filepath.Dir(agentPath)); problem != nil {
		return r.refuseUpdates("Agent updates need an install directory that only "+updateRootWord()+" can change. "+untrustedDetail(problem)+".", installDirectoryFix(agentPath))
	}
	paths := UpdateLocations()
	for _, dir := range []string{paths.PolicyDir, paths.StepDir} {
		if problem := untrustedDirectory(dir); problem != nil {
			return r.refuseUpdates("Agent updates keep what decides an install where only "+updateRootWord()+" can change it. "+untrustedDetail(problem)+".",
				"Make "+dir+" and every directory above it "+updateRootWord()+"'s alone, then run the command again. Or leave out --updates.")
		}
	}
	return nil
}

// installDirectoryFix says what to do about an install directory that others can
// write. The place the agent usually goes is the example, unless that is the
// directory that was refused (Homebrew on an Intel Mac takes /usr/local/bin): the
// fix is then another directory, which the installer takes with --install-dir.
func installDirectoryFix(agentPath string) string {
	if filepath.Dir(agentPath) == filepath.Dir(DefaultPaths().Binary) {
		return "Install the agent in another directory only " + updateRootWord() + " can write, with the installer's --install-dir, then run the command again. Or leave out --updates."
	}
	return "Install the agent in a directory only " + updateRootWord() + " can write, such as " + DefaultPaths().Binary + ", then run the command again. Or leave out --updates."
}

// untrustedDirectory says why the nearest directory that exists on the way to
// path can't be trusted with what decides an install, or nil when it can. A
// directory that isn't there yet is made by the step that needs it, below one
// that passed.
func untrustedDirectory(path string) error {
	for {
		held, err := openRootOwned(path, rootOwnedDirectory)
		if err == nil {
			_ = held.Close()
			return nil
		}
		if !notExist(err) {
			return err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}

// untrustedDetail is the sentence part of a path that failed the check, or of
// an error that kept the check from running.
func untrustedDetail(err error) string {
	var refusal *UpdateRefusal
	if errors.As(err, &refusal) {
		return strings.TrimSuffix(refusal.Detail, ".")
	}
	return "It couldn't be checked: " + strings.TrimSuffix(sentence(err.Error()), ".")
}

// preflightWithdraw checks that turning updates off can go through: a host with
// something to withdraw needs an administrator, and not while an update is
// being tried.
func (r *setupRun) preflightWithdraw(dir string) error {
	if !updatesInstalled(dir) {
		return nil
	}
	if err := updateInProgress(); err != nil {
		return r.refuseUpdates(sentence(err.Error()), "Run the command again after that.")
	}
	if !r.options.DryRun && !r.host.isElevated() {
		return r.refuseUpdates("Turning agent updates off needs administrator rights.", elevationHint)
	}
	return nil
}

// updatesInstalled reports whether this host holds anything that updates left:
// a policy that takes updates, the privileged step's directory, or what the agent
// staged. Reading is all it does.
func updatesInstalled(dir string) bool {
	paths := UpdateLocations()
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentOff {
		return true
	}
	for _, path := range []string{paths.StepDir, UpdateExchangeFor(dir).Dir} {
		if _, err := os.Lstat(path); err == nil {
			return true
		}
	}
	return false
}

// resolveUpdateKeys fetches the server's list of release keys over the
// connection setup already verified (no token, no client certificate), and finds
// the keys the operator named by their fingerprints. Nothing on the host changes
// until every one is found.
func (r *setupRun) resolveUpdateKeys(ctx context.Context, plan *updatePlan, origin string, trust releaseKeyTrust) error {
	raw, err := fetchReleaseKeyBundle(ctx, origin, trust)
	if errors.Is(err, errServerHasNoUpdates) {
		return r.refuseUpdates("This server doesn't offer agent updates.", "Turn them on in Settings → Agent updates, or leave out --updates.")
	}
	if err != nil {
		var refusal *UpdateRefusal
		if errors.As(err, &refusal) {
			return r.refuseUpdates(bundleProblem(refusal), bundleFix)
		}
		_, failure := r.failErr("updates", "Updates", err, "")
		return failure
	}
	offered, err := ParseReleaseKeyBundle(raw)
	if err != nil {
		return r.refuseUpdates(bundleProblem(err), bundleFix)
	}
	pins, missing := matchReleaseKeys(offered, plan.wanted)
	if len(missing) > 0 {
		return r.refuseUpdates(missingKeysDetail(missing, offered), "Compare it with the key in Settings → Agent updates, and copy the command again from Add device. If it still doesn't match, this address may lead to a different server; don't continue.")
	}
	plan.pins = pins
	return nil
}

const bundleFix = "Don't continue: the server is faulty, or this address leads to another server. Check Settings → Agent updates."

func bundleProblem(err error) string {
	var refusal *UpdateRefusal
	if errors.As(err, &refusal) {
		return "The server's list of release keys is invalid (" + refusal.Code + "): " + strings.TrimSuffix(refusal.Detail, ".") + ". Nothing was pinned."
	}
	return "The server's list of release keys can't be read: " + strings.TrimSuffix(sentence(err.Error()), ".") + ". Nothing was pinned."
}

// missingKeysDetail says which fingerprints the server doesn't offer, and the
// ones it does, in the words --ca-sha256 uses for a certificate that doesn't match.
func missingKeysDetail(missing []string, offered []BundleKey) string {
	var lines []string
	if len(missing) == 1 {
		lines = append(lines, "The server offers no release key with the fingerprint this command pins:")
	} else {
		lines = append(lines, "The server offers none of the release keys with the fingerprints this command pins:")
	}
	for _, fingerprint := range missing {
		lines = append(lines, "expected "+fingerprintLine(fingerprint))
	}
	if len(offered) == 0 {
		return strings.Join(append(lines, "The server's list of release keys is empty."), "\n")
	}
	for i, key := range offered {
		label := "offered  "
		if i > 0 {
			label = "         "
		}
		lines = append(lines, label+fingerprintLine(key.Key.Fingerprint())+"  "+key.State+" · "+key.Key.Name())
	}
	return strings.Join(lines, "\n")
}

// releaseKeyTrust says how the server was trusted: the choice setup verified.
type releaseKeyTrust struct {
	// pinned is the server CA that --ca-sha256 named and setup checked: the only
	// root. Otherwise caFile is a CA file added to the host's roots, or "" for
	// the host's roots alone.
	pinned *x509.Certificate
	caFile string
}

// errServerHasNoUpdates is the answer of a server with agent updates off.
var errServerHasNoUpdates = errors.New("the server doesn't offer agent updates")

const (
	releaseKeysPath      = "/agent/v1/release-keys"
	releaseKeysSchema    = "vectory.release-keys.v1"
	maxReleaseKeyBundle  = 64 * 1024
	releaseKeysFetchTime = 30 * time.Second
)

// fetchReleaseKeyBundle reads GET /agent/v1/release-keys: public keys, no token and
// no client certificate, at most 64 KiB, never a redirect.
func fetchReleaseKeyBundle(ctx context.Context, origin string, trust releaseKeyTrust) ([]byte, error) {
	base, err := NormalizeServer(origin)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if trust.pinned != nil {
		roots.AddCert(trust.pinned)
	} else {
		if system, err := x509.SystemCertPool(); err == nil {
			roots = system
		}
		if trust.caFile != "" {
			pem, err := os.ReadFile(trust.caFile)
			if err != nil || !roots.AppendCertsFromPEM(pem) {
				return nil, errors.New("can't read the trusted CA file " + trust.caFile + "; check the path and the agent account's read access")
			}
		}
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		DisableCompression:    true,
		DisableKeepAlives:     true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: releaseKeysFetchTime, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects forbidden") }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base+releaseKeysPath, nil)
	if err != nil {
		return nil, errors.New("invalid server address")
	}
	request.Header.Set("User-Agent", "Vectory/"+Version)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	target, _ := url.Parse(base)
	if err != nil {
		proxy, _ := http.ProxyFromEnvironment(request)
		return nil, classifyTransport(target, proxy, false, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxReleaseKeyBundle+1))
	switch {
	case response.StatusCode == http.StatusNotFound:
		return nil, errServerHasNoUpdates
	case response.StatusCode != http.StatusOK:
		return nil, classifyStatus(target, releaseKeysPath, response.StatusCode, retryAfter(response), body)
	case err != nil:
		return nil, errors.New("the server's list of release keys was cut off")
	case len(body) > maxReleaseKeyBundle:
		return nil, newUpdateRefusal(codeReleaseKeyInvalid, "the list is longer than %d KiB", maxReleaseKeyBundle/1024)
	}
	return body, nil
}

// BundleKey is one entry of the server's list of release keys: a key that
// passed the key rule, and whether it is the one new releases are signed with
// (current) or one it replaced (retired).
type BundleKey struct {
	Key   ReleaseKey
	State string
}

// ParseReleaseKeyBundle reads the server's list of release keys. Setup never
// takes a fingerprint from it: each entry's key must pass the key rule, and the
// entry's fingerprint member must equal the one computed from the key's own
// bytes, or the whole list is malformed (RELEASE_KEY_INVALID) and nothing is
// pinned. Members setup doesn't know are ignored.
func ParseReleaseKeyBundle(raw []byte) ([]BundleKey, error) {
	var bundle struct {
		Schema string `json:"schema"`
		Keys   []struct {
			PublicKey   *string `json:"public_key"`
			Fingerprint *string `json:"fingerprint"`
			State       string  `json:"state"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(raw, &bundle); err != nil {
		return nil, newUpdateRefusal(codeReleaseKeyInvalid, "it isn't a JSON object")
	}
	switch {
	case bundle.Schema != releaseKeysSchema:
		return nil, newUpdateRefusal(codeReleaseKeyInvalid, "its schema is %q, and this agent reads %q", safeText(bundle.Schema, 64), releaseKeysSchema)
	case bundle.Keys == nil:
		return nil, newUpdateRefusal(codeReleaseKeyInvalid, "it has no list of keys")
	}
	offered := make([]BundleKey, 0, len(bundle.Keys))
	for i, entry := range bundle.Keys {
		if entry.PublicKey == nil {
			return nil, newUpdateRefusal(codeReleaseKeyInvalid, "key %d has no public_key", i+1)
		}
		key, err := ParseReleaseKey(*entry.PublicKey)
		if err != nil {
			var refusal *UpdateRefusal
			if errors.As(err, &refusal) {
				return nil, newUpdateRefusal(codeReleaseKeyInvalid, "key %d: %s", i+1, strings.TrimSuffix(refusal.Detail, "."))
			}
			return nil, err
		}
		switch {
		case entry.Fingerprint == nil:
			return nil, newUpdateRefusal(codeReleaseKeyInvalid, "key %d (%s) has no fingerprint", i+1, key.ShortID())
		case *entry.Fingerprint != key.Fingerprint():
			return nil, newUpdateRefusal(codeReleaseKeyInvalid, "the fingerprint of key %d isn't the fingerprint of its key (%s)", i+1, key.ShortID())
		case entry.State != "current" && entry.State != "retired":
			return nil, newUpdateRefusal(codeReleaseKeyInvalid, "key %d (%s) is %q, and a key is current or retired", i+1, key.ShortID(), safeText(entry.State, 32))
		}
		offered = append(offered, BundleKey{Key: key, State: entry.State})
	}
	return offered, nil
}

// matchReleaseKeys finds the entries whose computed fingerprint is one the
// operator gave, in the order given, and the fingerprints that no entry has.
func matchReleaseKeys(offered []BundleKey, wanted []string) (pins []ReleaseKey, missing []string) {
	for _, fingerprint := range wanted {
		index := slices.IndexFunc(offered, func(entry BundleKey) bool { return entry.Key.Fingerprint() == fingerprint })
		if index < 0 {
			missing = append(missing, fingerprint)
			continue
		}
		pins = append(pins, offered[index].Key)
	}
	return pins, missing
}

// applyUpdates is the Updates step of setup, after the agent is installed and
// enrolled and before the service starts: it writes the policy, then installs
// the privileged step. A failure here says what was saved and what wasn't.
func (r *setupRun) applyUpdates(plan *updatePlan, agentPath, dir string) error {
	if plan.consent == UpdateConsentOff {
		return r.withdrawUpdates(dir)
	}
	existing, err := ReadUpdatePolicy()
	if err != nil {
		existing = DefaultUpdatePolicy()
	}
	// The flags decide the level, the track, the windows and the pins. A pause is a
	// person's decision on this host, so running setup again doesn't lift it.
	policy := existing
	policy.Consent, policy.Track, policy.Windows = plan.consent, plan.track, slices.Clone(plan.windows)
	policy.SetPinnedKeys(plan.pins)
	saved := "The agent is installed and enrolled, but updates weren't turned on"
	if !sameUpdatePolicy(existing, policy) {
		if err := WriteUpdatePolicy(policy); err != nil {
			return r.refuseUpdates(saved+": the update policy couldn't be written ("+strings.TrimSuffix(sentence(err.Error()), ".")+").", "Fix the cause, then run the same command again; setup resumes where it stopped.")
		}
	}
	if err := r.host.installUpdateStep(dir, agentPath); err != nil {
		return r.refuseUpdates("The agent is installed and enrolled and the update policy is saved, but the update step couldn't be installed ("+strings.TrimSuffix(sentence(err.Error()), ".")+"). Until it is, this host takes no update.", "Fix the cause, then run the same command again; setup resumes where it stopped.")
	}
	words := UpdatePolicyWords(policy) + " (pinned)"
	if policy.Paused {
		words += " · paused on this host: " + CommandFor(dir, "sudo vectory update resume")
	}
	r.add("updates", "ok", "Updates", words, "")
	r.result.Updates = &SetupUpdates{Consent: policy.Consent, Track: policy.Track, Windows: policy.Windows, Keys: policy.Fingerprints(), Paused: policy.Paused}
	return nil
}

// sameUpdatePolicy reports whether two policies say the same: the instants they
// were written and pinned at don't count.
func sameUpdatePolicy(a, b UpdatePolicy) bool {
	return a.Consent == b.Consent && a.Track == b.Track && a.Paused == b.Paused && slices.Equal(a.Windows, b.Windows) && slices.Equal(a.Fingerprints(), b.Fingerprints())
}

// withdrawUpdates is --updates off.
func (r *setupRun) withdrawUpdates(dir string) error {
	done, err := withdrawUpdates(dir, r.host.removeUpdateStep)
	if err != nil {
		return r.refuseUpdates("The agent is installed and enrolled, but turning updates off didn't finish: "+strings.TrimSuffix(sentence(err.Error()), ".")+". "+done.saved(), "Fix the cause, then run the same command again; setup resumes where it stopped.")
	}
	r.add("updates", "ok", "Updates", done.line(), "")
	r.result.Updates = &SetupUpdates{Consent: UpdateConsentOff}
	return nil
}

// planUpdateStep is what a dry run says about updates.
func (r *setupRun) planUpdateStep(plan *updatePlan, dir string) {
	if plan.consent == UpdateConsentOff {
		if updatesInstalled(dir) {
			r.add("updates", "plan", "Updates", "Would turn agent updates off on this host: the consent is withdrawn, the update step is removed and the pinned keys are kept.", "")
		} else {
			r.add("updates", "plan", "Updates", "Agent updates are off on this host; nothing to turn off.", "")
		}
		return
	}
	var shown []string
	for _, fingerprint := range plan.wanted {
		shown = append(shown, fingerprint[:16])
	}
	keys := "key " + shown[0]
	if len(shown) > 1 {
		keys = "keys " + strings.Join(shown, ", ")
	}
	r.add("updates", "plan", "Updates", "Would turn on updates: "+strings.Join([]string{UpdateConsentWords(plan.consent), UpdateTrackWords(plan.track), UpdateWindowsWords(plan.windows), keys}, " · ")+".",
		"A real run checks the key against the server's own list before it changes anything.")
}
