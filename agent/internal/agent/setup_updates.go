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
//
// The key, the track and the windows can also be given without --updates. They
// then amend what the host already agreed to: they change the parts they name
// in the policy the host has, and keep the rest (the level, the parts they don't
// name, a pause). Where the host agreed to nothing there is nothing to amend, and
// setup refuses before it changes anything. The dashboard therefore never has to
// say again what a host chose: whoever generates a command names only the part
// to change, and the host keeps the choices it made itself.

// SetupUpdates is what setup did about agent updates, for --json.
type SetupUpdates struct {
	Consent string   `json:"consent"`
	Track   string   `json:"track,omitempty"`
	Windows []string `json:"windows,omitempty"`
	// Keys are the fingerprints the host pins now.
	Keys   []string `json:"keys,omitempty"`
	Paused bool     `json:"paused,omitempty"`
	// StagedLeft is set when --updates off left the files the agent staged where
	// they are: root won't delete through a directory that others can change.
	StagedLeft *UpdateLeft `json:"staged_left,omitempty"`
}

// updatePlan is the update flags of one setup run, checked.
type updatePlan struct {
	// consent is the level the host takes updates at when the run is done. For an
	// amendment it is the level the host has, which the run keeps.
	consent string
	track   string
	windows []string
	// wanted are the fingerprints the operator gave, in order, each once.
	wanted []string
	// pins are the keys the server's list holds for them, found in a real run.
	pins []ReleaseKey

	// amend says the command has update flags and no --updates. It changes the
	// parts the flags name, in the policy the host already has (base): the pinned
	// keys when wanted isn't empty, the track when setTrack, the windows when
	// setWindows. Everything else in the policy stays as it is.
	amend                bool
	setTrack, setWindows bool
	base                 UpdatePolicy
}

// The refusals of an amendment: a host that agreed to nothing has nothing to
// change, and one whose policy can't be used can't be amended either. Both end
// with what gives the host's consent: a command with --updates and the key.
const (
	withKeyWords   = "Add --updates auto or --updates ask, with --update-key-sha256"
	notAgreedWords = "This host hasn't agreed to agent updates, so there is nothing to change. " + withKeyWords + "."
)

// readBase reads what the host agreed to, through the root-owned path check, for
// an amendment. It refuses, with the usage exit code, a host with no policy or a
// policy that takes no update, and one whose policy can't be used, and changes
// nothing.
func (plan *updatePlan) readBase() error {
	policy, basis, err := readUpdatePolicy(UpdateLocations())
	switch {
	case err == nil && basis != "" && policy.Consent != UpdateConsentOff:
		plan.base, plan.consent = policy, policy.Consent
		return nil
	case err == nil:
		return inputError(notAgreedWords)
	case errors.Is(err, ErrUpdatePolicyInvalid):
		return inputError("The update policy on this host can't be used (" + invalidPolicyWords(err) + "), so there is nothing to change. " + withKeyWords + ", to write it again.")
	}
	return inputError("The update policy on this host can't be read safely (" + untrustedDetail(err) + "), so there is nothing to change. Make " + onTheWay("it, and every directory above it,", "the directory the message names") + " writable by " + updateRootWord() + " alone, then run the command again.")
}

// leaveOut is what an operator who doesn't want the update step leaves out of the
// command: --updates, or, for an amendment, the update flags.
func (plan *updatePlan) leaveOut() string {
	if plan.amend {
		return "the update flags"
	}
	return "--updates"
}

// CheckUpdates refuses update flags that can't work, before setup does anything:
// the command ends with the usage exit code for them. Flags that can't work on
// any host are refused for what they say. Flags without --updates change what
// the host agreed to, so a host that agreed to nothing is refused too.
func (o SetupOptions) CheckUpdates() error {
	plan, err := planUpdates(o)
	if err != nil || plan == nil || !plan.amend {
		return err
	}
	return plan.readBase()
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
	case UpdateConsentAuto, UpdateConsentAsk, UpdateConsentOff, "":
	default:
		return nil, inputError(fmt.Sprintf("--updates takes auto, ask or off, and %q isn't one.", o.Updates))
	}
	// With no --updates the flags amend what the host agreed to; which host that is
	// isn't known here (readBase asks it), and what they say is checked as for any
	// other command.
	plan := &updatePlan{consent: o.Updates, amend: o.Updates == ""}
	if plan.consent == UpdateConsentOff {
		if len(given) > 0 {
			return nil, inputError("--updates off turns updates off. It doesn't take " + quoteList(given) + ".")
		}
		return plan, nil
	}
	if !plan.amend && len(o.UpdateKeys) == 0 {
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
	switch {
	case o.UpdateTrack != "":
		track, err := ParseReleaseTrack(o.UpdateTrack)
		if err != nil {
			return nil, err
		}
		plan.track, plan.setTrack = track, true
	case !plan.amend:
		plan.track = UpdateTrackPatch
	}
	if _, err := ParseUpdateWindows(o.UpdateWindows); err != nil {
		return nil, err
	}
	plan.windows, plan.setWindows = slices.Clone(o.UpdateWindows), len(o.UpdateWindows) > 0
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
	leave := plan.leaveOut()
	switch {
	case choice.kind == "none" && choice.explicit:
		return r.refuseUpdates("Agent updates need a service. The update step restarts the agent through its service manager, and --service none leaves that to you.", "Leave out "+leave+", or leave out --service none.")
	case choice.kind == "none":
		return r.refuseUpdates("Agent updates need a service manager, and this host has none ("+choice.reason+").", "Leave out "+leave+" here, or run the agent on a host that has a service manager.")
	}
	switch r.host.updateEligibility(dir) {
	case "PLATFORM_NOT_IN_RELEASE":
		return r.refuseUpdates("Agent updates aren't in this release for "+platformName(platform.OS)+". "+byHand(), "Leave out "+leave+", and upgrade this host with the Upgrade agent command when a new agent is out.")
	case "PACKAGE_MANAGED":
		return r.refuseUpdates("This agent is installed from a package, and the package manager owns its file.", "Leave out "+leave+", and upgrade it with the package manager.")
	}
	install := filepath.Dir(agentPath)
	if problem := untrustedDirectory(install); problem != nil {
		// The fix names the directory the agent is in, whichever directory on its way
		// failed (the detail says which): making it, and every directory above it,
		// writable by root alone puts it right. On Windows the detail names the one to
		// put right, because a drive root and ProgramData are left as they are.
		root := updateRootWord()
		return r.refuseUpdates("Agent updates need an install directory that only "+root+" can change. "+untrustedDetail(problem)+".",
			"Make "+onTheWay(install+", and every directory above it,", "the directory the message names")+" writable by "+root+" alone, or install the agent in a directory that already is (the installer takes --install-dir for that), then run the command again. Or leave out "+leave+".")
	}
	paths := UpdateLocations()
	for _, dir := range []string{paths.PolicyDir, paths.StepDir} {
		if problem := untrustedDirectory(dir); problem != nil {
			return r.refuseUpdates("Agent updates keep what decides an install where only "+updateRootWord()+" can change it. "+untrustedDetail(problem)+".",
				"Make "+onTheWay(dir+" and every directory above it", "the directory the message names")+" "+updateRootWord()+"'s alone, then run the command again. Or leave out "+leave+".")
		}
	}
	return nil
}

// untrustedDirectory says why the part of path that exists can't be trusted with
// what decides an install, or nil when it can. A directory that isn't there yet is
// made by the step that needs it, below one that passed (untrustedPrefix, which each
// platform's path check has).
func untrustedDirectory(path string) error {
	return untrustedPrefix(path)
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
	if _, err := updateInProgress(); err != nil {
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
		return r.refuseUpdates("This server doesn't offer agent updates.", "Turn them on in Settings → Agent updates, or leave out "+plan.leaveOut()+".")
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

// pendingUpdateStep is the half of turning updates on that waits for the service.
// The policy is written before the service is registered or started, so that
// consent is in place before its first check-in. The privileged step is installed
// once the service is registered: it checks the registered service and restarts
// the agent through its service manager, and a fresh install has no service until
// setup registers it. The order is the same for every service manager (a systemd
// unit, a launchd job, a Windows service), so it belongs to setup.
type pendingUpdateStep struct {
	// words is the Updates step as it reads once the update step is installed.
	words string
	// updates is what the run did, for --json.
	updates SetupUpdates
}

// finishUpdates installs the privileged update step for a run that turned updates
// on or amended them, and says what is now in force. The service path calls it
// right after it registers the service, with its definition in the form the step
// checks, and before it starts or restarts the service. A failure says what was
// saved and what wasn't, and stops setup before the service is started; running
// the same command again resumes here, with nothing to write twice.
func (r *setupRun) finishUpdates(agentPath, dir string) error {
	pending := r.updateStep
	if pending == nil {
		return nil
	}
	r.updateStep = nil
	if err := r.host.installUpdateStep(dir, agentPath); err != nil {
		return r.refuseUpdates("The agent is installed and enrolled, the update policy is saved and the service is registered, but the update step couldn't be installed ("+strings.TrimSuffix(sentence(err.Error()), ".")+"). Setup stopped before it started or restarted the service. Until the step is installed, this host takes no update.", "Fix the cause, then run the same command again; setup resumes where it stopped.")
	}
	r.add("updates", "ok", "Updates", pending.words, "")
	updates := pending.updates
	r.result.Updates = &updates
	return nil
}

// updatesWaitForTheService says, when the service couldn't be registered, that the
// update policy is saved and the update step isn't installed, since it can only be
// installed once the service is.
func (r *setupRun) updatesWaitForTheService() {
	if r.updateStep == nil {
		return
	}
	r.updateStep = nil
	r.add("updates", "warn", "Updates", "The update policy is saved, but the update step isn't installed: it can only be installed once the service is registered. Run the same command again when the service is fixed; setup resumes where it stopped.", "")
}

// applyUpdates is the Updates step of setup, after the agent is installed and
// enrolled and before the service is registered or started: it writes the policy
// and leaves the privileged step for the service path (finishUpdates). A failure
// here says what was saved and what wasn't.
func (r *setupRun) applyUpdates(plan *updatePlan, dir string) error {
	if plan.consent == UpdateConsentOff {
		return r.withdrawUpdates(dir)
	}
	if plan.amend {
		return r.amendUpdates(plan, dir)
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
	words := UpdatePolicyWords(policy) + " (pinned)"
	if policy.Paused {
		words += " · paused on this host: " + AdminCommandFor(dir, "vectory update resume")
	}
	r.updateStep = &pendingUpdateStep{words: words, updates: SetupUpdates{Consent: policy.Consent, Track: policy.Track, Windows: policy.Windows, Keys: policy.Fingerprints(), Paused: policy.Paused}}
	return nil
}

// sameUpdatePolicy reports whether two policies say the same: the instants they
// were written and pinned at don't count.
func sameUpdatePolicy(a, b UpdatePolicy) bool {
	return a.Consent == b.Consent && a.Track == b.Track && a.Paused == b.Paused && slices.Equal(a.Windows, b.Windows) && slices.Equal(a.Fingerprints(), b.Fingerprints())
}

var (
	// errAmendNotAgreed is what the edit of an amendment answers when the policy it
	// finds no longer takes updates: a person withdrew the consent while setup ran,
	// and an amendment never gives it back.
	errAmendNotAgreed = errors.New("the host's consent to agent updates was withdrawn")
	// errAmendNothing is what the edit answers when the policy already says what
	// the flags name: nothing is written.
	errAmendNothing = errors.New("the policy already says this")
)

// amended is p with the parts this command names changed, and nothing else: the
// pinned keys (each key already pinned keeps the time it was pinned), the track
// and the windows. The level, a pause and the parts not named stay as they are.
func (plan *updatePlan) amended(p UpdatePolicy) UpdatePolicy {
	next := p
	if len(plan.wanted) > 0 {
		next.SetPinnedKeys(plan.pins)
	}
	if plan.setTrack {
		next.Track = plan.track
	}
	if plan.setWindows {
		next.Windows = slices.Clone(plan.windows)
	}
	return next
}

// amendedParts names what differs between two policies, in the words of the step
// line: "pinned keys", "track" and "windows".
func amendedParts(before, after UpdatePolicy) []string {
	var parts []string
	if !slices.Equal(before.Fingerprints(), after.Fingerprints()) {
		parts = append(parts, "pinned keys")
	}
	if before.Track != after.Track {
		parts = append(parts, "track")
	}
	if !slices.Equal(before.Windows, after.Windows) {
		parts = append(parts, "windows")
	}
	return parts
}

// amendUpdates is the Updates step of a command with update flags and no
// --updates: it changes, in the policy the host has, the parts the flags name,
// and leaves the privileged step to be installed (or installed again, where it is
// missing) once the service is registered (finishUpdates). The policy is edited
// where it is written (ChangeUpdatePolicy reads it again and writes only over what
// it read), so a consent withdrawn in the meantime stays withdrawn and a write of
// the update step isn't lost. A policy that already says what the flags name is
// left as it is. The counter floors and the step's own state are never touched here.
func (r *setupRun) amendUpdates(plan *updatePlan, dir string) error {
	saved := "The agent is installed and enrolled, but the update choices weren't changed"
	var now UpdatePolicy
	var parts []string
	err := ChangeUpdatePolicy(func(p *UpdatePolicy) error {
		if p.Consent == UpdateConsentOff {
			return errAmendNotAgreed
		}
		next := plan.amended(*p)
		now, parts = next, amendedParts(*p, next)
		if len(parts) == 0 {
			now = *p
			return errAmendNothing
		}
		*p = next
		return nil
	})
	switch {
	case err == nil || errors.Is(err, errAmendNothing):
	case errors.Is(err, errAmendNotAgreed):
		return r.refuseUpdates(saved+": the consent to agent updates was withdrawn while setup ran.", withKeyWords+", to turn them on again.")
	default:
		return r.refuseUpdates(saved+": the update policy couldn't be changed ("+strings.TrimSuffix(sentence(err.Error()), ".")+").", "Fix the cause, then run the same command again; setup resumes where it stopped.")
	}
	words := UpdatePolicyWords(now) + " (pinned)"
	if len(parts) == 0 {
		words += " · nothing changed"
	} else {
		words += " · changed: " + quoteList(parts)
	}
	if now.Paused {
		words += " · paused on this host: " + AdminCommandFor(dir, "vectory update resume")
	}
	r.updateStep = &pendingUpdateStep{words: words, updates: SetupUpdates{Consent: now.Consent, Track: now.Track, Windows: now.Windows, Keys: now.Fingerprints(), Paused: now.Paused}}
	return nil
}

// fingerprintsWords names keys by the short IDs of their fingerprints: "key
// 3f9a1c0277de9b41", or "keys 3f9a1c0277de9b41, 05cc6c02351af0cb".
func fingerprintsWords(fingerprints []string) string {
	shown := make([]string, len(fingerprints))
	for i, fingerprint := range fingerprints {
		shown[i] = fingerprintPrefix(fingerprint)
	}
	if len(shown) == 1 {
		return "key " + shown[0]
	}
	return "keys " + strings.Join(shown, ", ")
}

// withdrawUpdates is --updates off.
func (r *setupRun) withdrawUpdates(dir string) error {
	done, err := withdrawUpdates(dir, r.host.removeUpdateStep)
	if err != nil {
		return r.refuseUpdates("The agent is installed and enrolled, but turning updates off didn't finish: "+strings.TrimSuffix(sentence(err.Error()), ".")+". "+done.saved(), "Fix the cause, then run the same command again; setup resumes where it stopped.")
	}
	r.add("updates", "ok", "Updates", done.line(), "")
	r.result.Updates = &SetupUpdates{Consent: UpdateConsentOff, StagedLeft: done.StagedLeft}
	if done.StagedLeft != nil {
		// Updates are off all the same; the files the agent staged are for a person to
		// delete, and the step says so in its own words.
		r.add("updates-staged", "warn", "Updates", done.StagedLeft.Message(), "")
	}
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
	if plan.amend {
		r.planAmendment(plan)
		return
	}
	r.add("updates", "plan", "Updates", "Would turn on updates: "+strings.Join([]string{UpdateConsentWords(plan.consent), UpdateTrackWords(plan.track), UpdateWindowsWords(plan.windows), fingerprintsWords(plan.wanted)}, " · ")+".",
		"A real run checks the key against the server's own list before it changes anything.")
}

// planAmendment is what a dry run says about an amendment: the parts it would
// change, each against what the host has now, or that it would change nothing.
func (r *setupRun) planAmendment(plan *updatePlan) {
	base := plan.base
	var changes []string
	if len(plan.wanted) > 0 && !slices.Equal(plan.wanted, base.Fingerprints()) {
		changes = append(changes, "pin "+fingerprintsWords(plan.wanted)+" instead of "+UpdateKeysWords(base.PinnedKeys()))
	}
	if plan.setTrack && plan.track != base.Track {
		changes = append(changes, "take "+UpdateTrackWords(plan.track)+" instead of "+UpdateTrackWords(base.Track))
	}
	if plan.setWindows && !slices.Equal(plan.windows, base.Windows) {
		changes = append(changes, "start an update in "+UpdateWindowsWords(plan.windows)+" instead of "+UpdateWindowsWords(base.Windows))
	}
	if len(changes) == 0 {
		r.add("updates", "plan", "Updates", "Would change nothing about updates: this host already has "+UpdatePolicyWords(base)+".", "")
		return
	}
	fix := ""
	if len(plan.wanted) > 0 {
		fix = "A real run checks the key against the server's own list before it changes anything."
	}
	r.add("updates", "plan", "Updates", "Would change updates: "+strings.Join(changes, "; ")+". The rest of what this host agreed to stays as it is.", fix)
}
