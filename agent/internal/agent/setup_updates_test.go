package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// testReleaseKey is a fresh release key with a name.
func testReleaseKey(t *testing.T, name string) ReleaseKey {
	t.Helper()
	private, err := GenerateReleasePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	public, err := private.Public(name)
	if err != nil {
		t.Fatal(err)
	}
	return public
}

// releaseKeyList is what GET /agent/v1/release-keys answers for these keys, each
// with the fingerprint a server writes.
func releaseKeyList(t *testing.T, entries ...BundleKey) []byte {
	t.Helper()
	type wire struct {
		PublicKey   string `json:"public_key"`
		Fingerprint string `json:"fingerprint"`
		State       string `json:"state"`
	}
	list := struct {
		Schema    string `json:"schema"`
		Keys      []wire `json:"keys"`
		Rollovers []any  `json:"rollovers"`
	}{Schema: releaseKeysSchema, Keys: []wire{}, Rollovers: []any{}}
	for _, entry := range entries {
		list.Keys = append(list.Keys, wire{entry.Key.Line(), entry.Key.Fingerprint(), entry.State})
	}
	return mustJSON(t, list)
}

// consentFixture is a host that can take updates, a server that offers them and
// a setup that is given every way to reach the host: the privileged step, the
// service manager and the privileges are fakes that record what setup asks of
// them, in order. The update paths are a tree the test owns.
type consentFixture struct {
	t       *testing.T
	server  *setupServer
	options SetupOptions
	dir     string
	managed string
	paths   UpdatePaths
	root    string
	agent   string
	key     ReleaseKey
	manager *fakeServiceManager
	host    serviceHost
	events  []string
	tokens  int
	// installFails and eligibility let a test change what the fake step says.
	installFails error
	eligibility  string
	// registered is what the fake service manager registered: the service for an
	// executable, a state directory and an account, once setup has registered it. The
	// fake step reads it as the real one reads the registered service.
	registered    bool
	registeredFor [3]string
	// consentAtRegistration is the level the policy file said when the service was
	// registered: the policy is in place before the service exists, so before its first
	// check-in.
	consentAtRegistration string
}

// serviceAccountForTests is an unprivileged account the service step can name:
// setup checks that the account exists, and that it can run Vector, as it would
// for any account.
//
// Run by anyone but root, the account is the one that runs the tests. It owns
// everything the fixture builds, so what other accounts may do in the temporary
// directory decides nothing (macOS keeps the temporary directory private to its
// user, and a stranger would be refused there for good reason). Run as root, the
// account is nobody, whom setup really starts Vector as; for that the temporary
// directory has to be open to other accounts.
func serviceAccountForTests(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return ""
	}
	if os.Geteuid() != 0 {
		current, err := user.Current()
		if err != nil || CheckServiceAccountName(current.Username) != nil {
			t.Skipf("setup with a service needs an account to name, and the account that runs the tests can't be one: %v", err)
		}
		return current.Username
	}
	if _, err := user.Lookup("nobody"); err != nil {
		t.Skip("setup with a service needs an unprivileged account to name, and this host has no nobody")
	}
	if problem := accountAccessProblem(context.Background(), "nobody", os.TempDir(), false); problem != "" {
		t.Skipf("the temporary directory isn't open to the account the service runs as: %s", problem)
	}
	return "nobody"
}

// openTo makes every directory from path up to the temporary directory (not
// including it, which isn't the test's to change) searchable by everyone, so
// that nobody can reach what setup checks that it can run.
func openTo(t *testing.T, path string) {
	t.Helper()
	stop := filepath.Clean(os.TempDir())
	for p := filepath.Clean(path); p != filepath.Dir(p) && p != stop; p = filepath.Dir(p) {
		_ = os.Chmod(p, 0o755)
	}
}

func newConsentFixture(t *testing.T) *consentFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake service and account are POSIX; the Windows service is covered by its own tests")
	}
	paths := useUpdateRoots(t)
	root := filepath.Dir(filepath.Dir(filepath.Dir(paths.PolicyDir)))
	f := &consentFixture{t: t, server: newSetupServer(t), paths: paths, root: root, key: testReleaseKey(t, "team"), eligibility: UpdateEligible}
	options, dir, managed := setupFixture(t)
	// No link on the way to the state directory. Withdrawing updates deletes what
	// the agent staged there only through a path that root alone can change, and
	// that check refuses a link at any depth: on macOS the temporary directory is
	// behind /var, which is one.
	if real, err := filepath.EvalSymlinks(filepath.Dir(dir)); err == nil {
		dir, managed = filepath.Join(real, filepath.Base(dir)), filepath.Join(real, "managed", "vector.json")
		options.StateDir, options.ManagedConfig = dir, managed
	}
	f.options, f.dir, f.managed = options, dir, managed
	f.agent = filepath.Join(root, "usr", "local", "bin", "vectory")
	vector := fakeVector(t, VectorVersion)
	openTo(t, vector)
	f.options.Server, f.options.CASHA256, f.options.VectorBinary = f.server.url, f.server.pin, vector
	f.options.Service, f.options.ServiceUser, f.options.AgentPath = "", serviceAccountForTests(t), f.agent
	f.options.KeepExistingVector = true
	f.options.CheckIn = 3 * time.Second
	f.options.Token = func() (string, error) { f.tokens++; return "synthetic-setup-token", nil }
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "current"})
	f.manager = &fakeServiceManager{registration: ServiceCreated, dir: dir, build: &AgentBuild{Version: Version, SHA256: "built"}}
	f.host = serviceHost{
		systemd:  func() bool { return true },
		why:      func() string { return "systemd isn't running" },
		elevated: func() bool { return true },
		eligibility: func(string) string {
			f.events = append(f.events, "eligibility")
			return f.eligibility
		},
		installUpdates: func(dir, executable string) error {
			// Setup installs the step after enrolling, with the policy written.
			if f.server.enrolls.Load() != 1 {
				t.Error("the update step was installed before the host enrolled")
			}
			policy, err := ReadUpdatePolicy()
			if err != nil || policy.Consent == UpdateConsentOff {
				t.Errorf("the update step was installed before the policy took updates: %+v %v", policy, err)
			}
			if executable != f.agent {
				t.Errorf("the step was given %q, and the agent is at %q", executable, f.agent)
			}
			if err := f.serviceProblem(dir, executable); err != nil {
				return err
			}
			f.events = append(f.events, "install-step")
			return f.installFails
		},
		removeUpdates: func() error {
			f.events = append(f.events, "remove-step")
			// The step's removal takes its directory away, which is what reports it removed.
			return os.RemoveAll(f.paths.StepDir)
		},
	}
	return f
}

// serviceProblem is what the real step says of the service the manager registered:
// it refuses a host with none (NO_SERVICE), and one whose service runs another
// executable or another state directory.
func (f *consentFixture) serviceProblem(dir, executable string) error {
	switch {
	case !f.registered:
		return newUpdateRefusal("NO_SERVICE", "no agent service is registered (%s doesn't exist)", "/etc/systemd/system/vectory.service")
	case f.registeredFor[0] != executable || f.registeredFor[1] != dir:
		return newUpdateRefusal("NO_SERVICE", "the registered service doesn't run %s for %s", executable, dir)
	}
	return nil
}

// consent sets the update flags a command carries.
func (f *consentFixture) consent(level string, keys ...ReleaseKey) {
	f.options.Updates = level
	f.options.UpdateKeys = nil
	for _, key := range keys {
		f.options.UpdateKeys = append(f.options.UpdateKeys, key.Fingerprint())
	}
}

func (f *consentFixture) run() (SetupResult, error) {
	f.t.Helper()
	ops := f.manager.ops()
	control, install := ops.control, ops.install
	ops.control = func(action string) error {
		f.events = append(f.events, "service-"+action)
		return control(action)
	}
	ops.install = func(exe, dir, account string) (ServiceRegistration, error) {
		f.consentAtRegistration = ""
		if policy, err := ReadUpdatePolicy(); err == nil {
			f.consentAtRegistration = policy.Consent
		}
		registration, err := install(exe, dir, account)
		if err == nil {
			f.events = append(f.events, "service-register")
			f.registered, f.registeredFor = true, [3]string{exe, dir, account}
		}
		return registration, err
	}
	return setupWith(context.Background(), f.options, ops, f.host)
}

// untouched fails the test unless nothing on the host changed: no state, no
// policy, no update step, no enrollment and no service call.
func (f *consentFixture) untouched() {
	f.t.Helper()
	for _, path := range []string{f.dir, filepath.Dir(f.managed), f.paths.PolicyDir, f.paths.StepDir} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			f.t.Errorf("%s exists: %v", path, err)
		}
	}
	for _, event := range f.events {
		if event != "eligibility" {
			f.t.Errorf("setup asked for %q before it refused", event)
		}
	}
	// A read-only check that the service can be registered is no change.
	for _, action := range f.manager.actions {
		if action != "check" {
			f.t.Errorf("the service was asked to %q", action)
		}
	}
	if f.server.enrolls.Load() != 0 || f.tokens != 0 {
		f.t.Errorf("enrollments %d, tokens %d", f.server.enrolls.Load(), f.tokens)
	}
}

func lastStep(result SetupResult) SetupStep { return result.Steps[len(result.Steps)-1] }

// On a fresh install setup writes the policy first, so that consent is in place
// before the service exists and before its first check-in. It installs the
// privileged step once the service is registered, which the step needs, and before
// the service starts, so that its first run already has the step.
func TestSetupTurnsUpdatesOnAfterEnrollmentWithTheStepInstalledOnceTheServiceIsRegistered(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAuto, f.key)
	f.options.UpdateWindows = []string{"Mon-Fri 02:00-04:00"}
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if strings.Join(f.events, ",") != "eligibility,service-register,install-step,service-start" {
		t.Fatalf("the order of what setup asked for: %v", f.events)
	}
	if f.consentAtRegistration != UpdateConsentAuto {
		t.Fatalf("the policy said %q when the service was registered; consent has to be in place before the service exists", f.consentAtRegistration)
	}
	step := lastUpdatesStep(t, result)
	if want := "automatic · patch releases · Mon–Fri 02:00–04:00 · key " + f.key.ShortID() + " (pinned)"; step.Detail != want || step.Status != "ok" || step.Label != "Updates" {
		t.Fatalf("the step: %+v, want %q", step, want)
	}
	policy, err := ReadUpdatePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if policy.Consent != UpdateConsentAuto || policy.Track != UpdateTrackPatch || len(policy.Windows) != 1 || policy.Windows[0] != "Mon-Fri 02:00-04:00" || policy.Paused || len(policy.Keys) != 1 || policy.Keys[0].Key.Line() != f.key.Line() {
		t.Fatalf("the policy: %+v", policy)
	}
	if result.Updates == nil || result.Updates.Consent != UpdateConsentAuto || len(result.Updates.Keys) != 1 || result.Updates.Keys[0] != f.key.Fingerprint() {
		t.Fatalf("the JSON result: %+v", result.Updates)
	}
	// The list of keys is public: no token, no client certificate.
	if f.server.keyRequests.Load() != 1 || f.server.keyRequestCerts.Load() != 0 {
		t.Fatalf("%d requests for the key list, %d with a client certificate", f.server.keyRequests.Load(), f.server.keyRequestCerts.Load())
	}
	// Nothing about updates was put in the agent's settings, which belong to the
	// service account.
	var settings map[string]any
	raw, err := os.ReadFile(filepath.Join(f.dir, "settings.json"))
	if err != nil || json.Unmarshal(raw, &settings) != nil {
		t.Fatalf("settings.json: %v", err)
	}
	for key := range settings {
		if strings.Contains(key, "update") || strings.Contains(key, "consent") || strings.Contains(key, "pin") {
			t.Errorf("settings.json carries %q: the service account could change what updates install", key)
		}
	}
}

func lastUpdatesStep(t *testing.T, result SetupResult) SetupStep {
	t.Helper()
	for i := len(result.Steps) - 1; i >= 0; i-- {
		if result.Steps[i].ID == "updates" {
			return result.Steps[i]
		}
	}
	t.Fatalf("no Updates step:\n%s", serviceDetail(result))
	return SetupStep{}
}

func TestSetupAsksAndTakesTheMinorTrack(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAsk, f.key)
	f.options.UpdateTrack = "minor"
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if got, want := lastUpdatesStep(t, result).Detail, "ask on this host · minor and patch releases · any time · key "+f.key.ShortID()+" (pinned)"; got != want {
		t.Fatalf("%q, want %q", got, want)
	}
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentAsk || policy.Track != UpdateTrackMinor || len(policy.Windows) != 0 {
		t.Fatalf("%+v %v", policy, err)
	}
}

// The key is found by the fingerprint computed from its bytes. The server's list
// carries a fingerprint member too; setup never reads a fingerprint from it.
func TestSetupPinsTheKeyWhoseComputedFingerprintMatches(t *testing.T) {
	f := newConsentFixture(t)
	other := testReleaseKey(t, "team-old")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "current"}, BundleKey{Key: other, State: "retired"})
	f.consent(UpdateConsentAuto, other)
	if result, err := f.run(); err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	policy, err := ReadUpdatePolicy()
	if err != nil || len(policy.Keys) != 1 || policy.Keys[0].Key.Line() != other.Line() {
		t.Fatalf("a retired key can be pinned, and only the key named: %+v %v", policy, err)
	}
}

func TestSetupPinsSeveralKeysInTheOrderGiven(t *testing.T) {
	f := newConsentFixture(t)
	second := testReleaseKey(t, "team-next")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "retired"}, BundleKey{Key: second, State: "current"})
	f.consent(UpdateConsentAuto, second, f.key)
	// The same fingerprint twice, and a fingerprint written in groups of eight.
	f.options.UpdateKeys = append(f.options.UpdateKeys, f.key.Fingerprint(), GroupFingerprint(second.Fingerprint()))
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	policy, _ := ReadUpdatePolicy()
	if got := policy.Fingerprints(); len(got) != 2 || got[0] != second.Fingerprint() || got[1] != f.key.Fingerprint() {
		t.Fatalf("%v", got)
	}
	if want := "automatic · patch releases · any time · keys " + second.ShortID() + ", " + f.key.ShortID() + " (pinned)"; lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q, want %q", lastUpdatesStep(t, result).Detail, want)
	}
}

// What the server's list says about itself decides nothing. An entry whose
// fingerprint member isn't the fingerprint of its key makes the whole list
// malformed, and nothing is pinned, installed, enrolled or written.
func TestSetupRefusesAListWhoseFingerprintMemberLies(t *testing.T) {
	f := newConsentFixture(t)
	attacker := testReleaseKey(t, "team")
	list := releaseKeyList(t, BundleKey{Key: attacker, State: "current"})
	// The entry claims the fingerprint the operator gave but holds the attacker's key.
	list = []byte(strings.ReplaceAll(string(list), attacker.Fingerprint(), f.key.Fingerprint()))
	f.server.releaseKeys = list
	f.consent(UpdateConsentAuto, f.key)
	result, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if !strings.HasPrefix(failed.Step.Detail, "The server's list of release keys is invalid (RELEASE_KEY_INVALID): the fingerprint of key 1 isn't the fingerprint of its key") || !strings.HasSuffix(failed.Step.Detail, "Nothing was pinned.") {
		t.Fatalf("%q", failed.Step.Detail)
	}
	if failed.Step.Fix != "Don't continue: the server is faulty, or this address leads to another server. Check Settings → Agent updates." {
		t.Fatalf("%q", failed.Step.Fix)
	}
	f.untouched()
}

func TestSetupNamesTheFingerprintsTheServerOffersWhenOneIsMissing(t *testing.T) {
	f := newConsentFixture(t)
	retired := testReleaseKey(t, "team-old")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "current"}, BundleKey{Key: retired, State: "retired"})
	stranger := testReleaseKey(t, "stranger")
	f.consent(UpdateConsentAuto, stranger)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) {
		t.Fatal(err)
	}
	want := "The server offers no release key with the fingerprint this command pins:\n" +
		"expected " + GroupFingerprint(stranger.Fingerprint()) + "\n" +
		"offered  " + GroupFingerprint(f.key.Fingerprint()) + "  current · team\n" +
		"         " + GroupFingerprint(retired.Fingerprint()) + "  retired · team-old"
	if failed.Step.Detail != want {
		t.Fatalf("\n%s\nwant\n%s", failed.Step.Detail, want)
	}
	if failed.Step.Fix != "Compare it with the key in Settings → Agent updates, and copy the command again from Add device. If it still doesn't match, this address may lead to a different server; don't continue." {
		t.Fatalf("%q", failed.Step.Fix)
	}
	f.untouched()
}

func TestSetupSaysWhichOfSeveralFingerprintsTheServerLacks(t *testing.T) {
	f := newConsentFixture(t)
	stranger := testReleaseKey(t, "stranger")
	f.consent(UpdateConsentAuto, f.key, stranger)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || !strings.Contains(failed.Step.Detail, "expected "+GroupFingerprint(stranger.Fingerprint())) || strings.Contains(failed.Step.Detail, "expected "+GroupFingerprint(f.key.Fingerprint())) {
		t.Fatalf("%v", err)
	}
	f.untouched()
}

func TestSetupRefusesWhenTheServerHasNoUpdates(t *testing.T) {
	f := newConsentFixture(t)
	f.server.releaseKeys = nil
	f.consent(UpdateConsentAuto, f.key)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" {
		t.Fatal(err)
	}
	if want := "This server doesn't offer agent updates. Turn them on in Settings → Agent updates, or leave out --updates."; failed.Error() != want {
		t.Fatalf("%q", failed.Error())
	}
	f.untouched()
}

func TestSetupRefusesAnUnusableListWithoutChangingAnything(t *testing.T) {
	big := append([]byte(`{"schema":"vectory.release-keys.v1","keys":[],"rollovers":[],"padding":"`), make([]byte, maxReleaseKeyBundle)...)
	for i := range big[len(big)-maxReleaseKeyBundle:] {
		big[len(big)-maxReleaseKeyBundle+i] = 'x'
	}
	big = append(big, '"', '}')
	for name, tc := range map[string]struct {
		bundle []byte
		status int
		want   string
	}{
		"not JSON":           {bundle: []byte("<html>"), want: "The server's list of release keys is invalid (RELEASE_KEY_INVALID): it isn't a JSON object. Nothing was pinned."},
		"another schema":     {bundle: []byte(`{"schema":"vectory.release-keys.v2","keys":[]}`), want: `its schema is "vectory.release-keys.v2"`},
		"no keys":            {bundle: []byte(`{"schema":"vectory.release-keys.v1"}`), want: "it has no list of keys"},
		"too large":          {bundle: big, want: "the list is longer than 64 KiB"},
		"the server is busy": {status: 503, want: "The server is busy (HTTP 503)."},
		"an error":           {status: 500, want: "The server had an internal error (HTTP 500)."},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConsentFixture(t)
			f.server.releaseKeys, f.server.releaseKeysStatus = tc.bundle, tc.status
			f.consent(UpdateConsentAuto, f.key)
			_, err := f.run()
			var failed *SetupError
			if !errors.As(err, &failed) || !strings.Contains(failed.Error(), tc.want) {
				t.Fatalf("%v, want %q", err, tc.want)
			}
			f.untouched()
		})
	}
}

// A list with an entry whose key breaks the key rule (here, a point of small
// order) is malformed even though its fingerprint member is the key's own.
func TestSetupRefusesAKeyThatBreaksTheKeyRule(t *testing.T) {
	f := newConsentFixture(t)
	small := "vectory-release-key ed25519 " + base64.StdEncoding.EncodeToString(make([]byte, 32)) + " small"
	f.server.releaseKeys = []byte(`{"schema":"vectory.release-keys.v1","keys":[{"public_key":"` + small + `","fingerprint":"66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925","state":"current"}],"rollovers":[]}`)
	f.consent(UpdateConsentAuto, f.key)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || !strings.Contains(failed.Step.Detail, "RELEASE_KEY_INVALID") || !strings.Contains(failed.Step.Detail, "key 1:") {
		t.Fatalf("%v", err)
	}
	f.untouched()
}

// refusals is every reason setup refuses consent before it changes anything, with
// the words it says them in.
func TestSetupRefusesConsentWhereUpdatesCantWork(t *testing.T) {
	// What setup says to do about an install directory that others can write, on
	// any system: name the directory, and say how to make it right.
	const installFix = "Make INSTALLDIR, and every directory above it, writable by root alone, or install the agent in a directory that already is (the installer takes --install-dir for that), then run the command again. Or leave out --updates."
	for name, tc := range map[string]struct {
		// prepare gets the test of its own case: it may skip it or fail it.
		prepare func(t *testing.T, f *consentFixture)
		detail  string
		fix     string
	}{
		"--service none": {
			prepare: func(t *testing.T, f *consentFixture) { f.options.Service = "none" },
			detail:  "Agent updates need a service. The update step restarts the agent through its service manager, and --service none leaves that to you.",
			fix:     "Leave out --updates, or leave out --service none.",
		},
		"no service manager": {
			prepare: func(t *testing.T, f *consentFixture) {
				f.host.systemd = func() bool { return false }
				f.host.why = func() string { return "systemd isn't running in this container" }
				if runtime.GOOS != "linux" {
					t.Skip("--service auto finds launchd or the Windows service manager elsewhere")
				}
			},
			detail: "Agent updates need a service manager, and this host has none (systemd isn't running in this container).",
			fix:    "Leave out --updates here, or run the agent on a host that has a service manager.",
		},
		"an operating system whose updates are not in this release": {
			prepare: func(t *testing.T, f *consentFixture) { f.eligibility = "PLATFORM_NOT_IN_RELEASE" },
			detail:  "Agent updates aren't in this release for " + platformName(runtime.GOOS) + ". Hosts of this kind update by hand in this release.",
			fix:     "Leave out --updates, and upgrade this host with the Upgrade agent command when a new agent is out.",
		},
		"a package-managed agent": {
			prepare: func(t *testing.T, f *consentFixture) { f.eligibility = "PACKAGE_MANAGED" },
			detail:  "This agent is installed from a package, and the package manager owns its file.",
			fix:     "Leave out --updates, and upgrade it with the package manager.",
		},
		// The detail names the directory that failed, whichever one it is; the fix names
		// the directory the agent is in. Both are what a person reads when the install
		// directory of a hosted runner is writable by everyone.
		"an install directory others can write": {
			prepare: func(t *testing.T, f *consentFixture) { loosen(t, filepath.Dir(f.agent), 0o775) },
			detail:  "Agent updates need an install directory that only root can change. INSTALLDIR is writable by its group (mode 0775).",
			fix:     installFix,
		},
		"an install directory everyone can write": {
			prepare: func(t *testing.T, f *consentFixture) { loosen(t, filepath.Dir(f.agent), 0o777) },
			detail:  "Agent updates need an install directory that only root can change. INSTALLDIR is writable by its group and by everyone (mode 0777).",
			fix:     installFix,
		},
		"a directory above the install directory that others can write": {
			prepare: func(t *testing.T, f *consentFixture) {
				loosen(t, filepath.Dir(f.agent), 0o755)
				loosen(t, filepath.Dir(filepath.Dir(f.agent)), 0o775)
			},
			detail: "Agent updates need an install directory that only root can change. ABOVEDIR is writable by its group (mode 0775).",
			fix:    installFix,
		},
		"a policy directory others can write": {
			prepare: func(t *testing.T, f *consentFixture) { loosen(t, f.paths.PolicyDir, 0o777) },
			detail:  "Agent updates keep what decides an install where only root can change it. POLICYDIR is writable by its group and by everyone (mode 0777).",
			fix:     "Make POLICYDIR and every directory above it root's alone, then run the command again. Or leave out --updates.",
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConsentFixture(t)
			f.consent(UpdateConsentAuto, f.key)
			tc.prepare(t, f)
			result, err := f.run()
			var failed *SetupError
			if !errors.As(err, &failed) || failed.Step.ID != "updates" || result.OK {
				t.Fatalf("%v\n%s", err, serviceDetail(result))
			}
			install := filepath.Dir(f.agent)
			places := strings.NewReplacer("INSTALLDIR", install, "ABOVEDIR", filepath.Dir(install), "POLICYDIR", f.paths.PolicyDir)
			detail, fix := places.Replace(tc.detail), places.Replace(tc.fix)
			if failed.Step.Detail != detail || failed.Step.Fix != fix {
				t.Fatalf("detail %q\nfix %q\nwant %q\n and %q", failed.Step.Detail, failed.Step.Fix, detail, fix)
			}
			// The server is asked for its keys only after the host passed.
			if f.server.keyRequests.Load() != 0 || f.server.enrolls.Load() != 0 || f.tokens != 0 || len(f.manager.actions) != 0 {
				t.Fatalf("setup went on: %d key requests, %d enrollments, %d tokens, %v", f.server.keyRequests.Load(), f.server.enrolls.Load(), f.tokens, f.manager.actions)
			}
			for _, path := range []string{f.dir, f.paths.StepDir} {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatalf("%s exists", path)
				}
			}
			for _, event := range f.events {
				if event != "eligibility" {
					t.Fatalf("%v", f.events)
				}
			}
		})
	}
}

// loosen makes dir exist, with mode.
func loosen(t *testing.T, dir string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, mode); err != nil {
		t.Fatal(err)
	}
}

// The step this build ships says no operating system takes updates until its
// native proof is green: setup then refuses consent everywhere.
func TestSetupRefusesConsentOnAnOperatingSystemWhoseStepIsNotBuilt(t *testing.T) {
	if UpdateEligibility(t.TempDir()) != "PLATFORM_NOT_IN_RELEASE" {
		t.Skip("this build has the privileged step for this operating system")
	}
	f := newConsentFixture(t)
	f.host.eligibility = nil
	f.consent(UpdateConsentAuto, f.key)
	if _, err := f.run(); err == nil || !strings.Contains(err.Error(), "Hosts of this kind update by hand in this release.") {
		t.Fatal(err)
	}
	f.events = nil
	f.untouched()
}

func TestSetupRefusesUpdateFlagsThatCantWorkOnAnyHost(t *testing.T) {
	good := strings.Repeat("ab", 32)
	for name, tc := range map[string]struct {
		options SetupOptions
		want    string
	}{
		"a major track":                {SetupOptions{Updates: "auto", UpdateKeys: []string{good}, UpdateTrack: "major"}, "This release offers patch and minor tracks. Upgrade to a new major version by hand."},
		"another track":                {SetupOptions{Updates: "auto", UpdateKeys: []string{good}, UpdateTrack: "weekly"}, `"weekly" isn't an update track. Use patch or minor.`},
		"another level":                {SetupOptions{Updates: "always", UpdateKeys: []string{good}}, `--updates takes auto, ask or off, and "always" isn't one.`},
		"no key":                       {SetupOptions{Updates: "auto"}, "--updates auto needs --update-key-sha256: the SHA-256 fingerprint of the release key this host pins. Add device writes it into the command."},
		"no key with ask":              {SetupOptions{Updates: "ask"}, "--updates ask needs --update-key-sha256"},
		"a short fingerprint":          {SetupOptions{Updates: "auto", UpdateKeys: []string{"3f9a1c0277de9b41"}}, "--update-key-sha256 needs the 64-character SHA-256 fingerprint of a release key"},
		"a fingerprint that isn't hex": {SetupOptions{Updates: "auto", UpdateKeys: []string{strings.Repeat("zz", 32)}}, "--update-key-sha256 needs the 64-character SHA-256 fingerprint"},
		"five keys":                    {SetupOptions{Updates: "auto", UpdateKeys: []string{strings.Repeat("01", 32), strings.Repeat("02", 32), strings.Repeat("03", 32), strings.Repeat("04", 32), strings.Repeat("05", 32)}}, "A host pins at most 4 release keys, and 5 were given with --update-key-sha256."},
		"a window that isn't one":      {SetupOptions{Updates: "auto", UpdateKeys: []string{good}, UpdateWindows: []string{"Mon-Mon 02:00-04:00"}}, `"Mon-Mon 02:00-04:00" isn't an update window`},
		"eight windows":                {SetupOptions{Updates: "auto", UpdateKeys: []string{good}, UpdateWindows: strings.Fields("daily daily daily daily daily daily daily daily")}, "A host takes at most 7 update windows, and 8 were given."},
		// Flags without a level amend what a host agreed to; what they say is checked
		// as anywhere else, before the host is looked at.
		"a short fingerprint alone":     {SetupOptions{UpdateKeys: []string{"3f9a1c0277de9b41"}}, "--update-key-sha256 needs the 64-character SHA-256 fingerprint of a release key"},
		"five keys alone":               {SetupOptions{UpdateKeys: []string{strings.Repeat("01", 32), strings.Repeat("02", 32), strings.Repeat("03", 32), strings.Repeat("04", 32), strings.Repeat("05", 32)}}, "A host pins at most 4 release keys, and 5 were given with --update-key-sha256."},
		"a major track alone":           {SetupOptions{UpdateTrack: "major"}, "This release offers patch and minor tracks. Upgrade to a new major version by hand."},
		"another track alone":           {SetupOptions{UpdateTrack: "weekly"}, `"weekly" isn't an update track. Use patch or minor.`},
		"a window alone that isn't one": {SetupOptions{UpdateWindows: []string{"Mon-Mon 02:00-04:00"}}, `"Mon-Mon 02:00-04:00" isn't an update window`},
		"eight windows alone":           {SetupOptions{UpdateWindows: strings.Fields("daily daily daily daily daily daily daily daily")}, "A host takes at most 7 update windows, and 8 were given."},
		"off with a key":                {SetupOptions{Updates: "off", UpdateKeys: []string{good}}, "--updates off turns updates off. It doesn't take --update-key-sha256."},
		"off with a track and a window": {SetupOptions{Updates: "off", UpdateTrack: "patch", UpdateWindows: []string{"daily 01:00-03:00"}}, "--updates off turns updates off. It doesn't take --update-track and --update-window."},
	} {
		t.Run(name, func(t *testing.T) {
			err := tc.options.CheckUpdates()
			if err == nil || !IsInputError(err) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("%v, want %q as an input error", err, tc.want)
			}
			// Setup itself checks them first, before it looks at the host.
			result, setupErr := Setup(context.Background(), tc.options)
			var failed *SetupError
			if !errors.As(setupErr, &failed) || failed.Step.ID != "updates" || len(result.Steps) != 1 {
				t.Fatalf("%v %+v", setupErr, result.Steps)
			}
		})
	}
	if err := (SetupOptions{}).CheckUpdates(); err != nil {
		t.Fatalf("no update flag is not an error: %v", err)
	}
}

// A command without update flags touches nothing of updates: it doesn't ask for
// the list of keys, read or write the policy, or reach the step.
func TestSetupWithoutUpdateFlagsTouchesNothingOfUpdates(t *testing.T) {
	f := newConsentFixture(t)
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if f.server.keyRequests.Load() != 0 || result.Updates != nil || stepStatus(result, "updates") != "" {
		t.Fatalf("updates were mentioned: %d key requests, %+v", f.server.keyRequests.Load(), result.Steps)
	}
	for _, event := range f.events {
		if event != "service-register" && event != "service-start" {
			t.Fatalf("setup reached for %q", event)
		}
	}
	for _, path := range []string{f.paths.PolicyDir, f.paths.StepDir} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s exists", path)
		}
	}
}

func TestSetupDryRunPlansUpdatesWithoutAskingTheServerOrChangingAnything(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAuto, f.key)
	f.options.DryRun = true
	f.options.UpdateWindows = []string{"daily 01:00-03:00 UTC"}
	f.options.Token = func() (string, error) { t.Fatal("a dry run asked for the token"); return "", nil }
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	step := lastUpdatesStep(t, result)
	if want := "Would turn on updates: automatic · patch releases · daily 01:00–03:00 UTC · key " + f.key.ShortID() + "."; step.Status != "plan" || step.Detail != want {
		t.Fatalf("%+v want %q", step, want)
	}
	if step.Fix != "A real run checks the key against the server's own list before it changes anything." {
		t.Fatalf("%q", step.Fix)
	}
	if f.server.keyRequests.Load() != 0 {
		t.Fatal("a dry run fetched the list of keys")
	}
	f.events = nil
	f.untouched()
}

// A dry run refuses what a real run would refuse for the host and the flags,
// and only what needs the server waits for the real run.
func TestSetupDryRunRefusesAHostThatCantTakeUpdates(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAsk, f.key)
	f.options.DryRun = true
	f.options.Service = "none"
	if _, err := f.run(); err == nil || !strings.Contains(err.Error(), "Agent updates need a service.") {
		t.Fatal(err)
	}
	f.events = nil
	f.untouched()
}

// Setting up again with another fingerprint replaces the pin set (that is how a
// host is re-pinned after a key was stolen), keeps what a person set on the
// host (a pause), and doesn't rewrite a policy that already says the same.
func TestSetupAgainReplacesThePinSetAndKeepsAPause(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAuto, f.key)
	if result, err := f.run(); err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if err := ChangeUpdatePolicy(func(p *UpdatePolicy) error { p.Paused = true; return nil }); err != nil {
		t.Fatal(err)
	}
	next := testReleaseKey(t, "team-next")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "retired"}, BundleKey{Key: next, State: "current"})
	f.consent(UpdateConsentAuto, next)
	f.options.Token = func() (string, error) { t.Fatal("an enrolled host asked for a token"); return "", nil }
	f.events = nil
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	policy, _ := ReadUpdatePolicy()
	if got := policy.Fingerprints(); len(got) != 1 || got[0] != next.Fingerprint() || !policy.Paused {
		t.Fatalf("%+v", policy)
	}
	if want := "automatic · patch releases · any time · key " + next.ShortID() + " (pinned) · paused on this host: " + asAdmin("vectory update resume") + " --state-dir " + ShellQuote(f.dir); lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q want %q", lastUpdatesStep(t, result).Detail, want)
	}
	// The same flags again change nothing in the policy file, and keep when each
	// key was pinned.
	before, _ := os.ReadFile(f.paths.Policy)
	time.Sleep(1100 * time.Millisecond)
	if _, err := f.run(); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(f.paths.Policy); string(after) != string(before) {
		t.Fatalf("a policy that says the same was rewritten:\n%s\n%s", before, after)
	}
}

// Setup must read the pause while holding the policy write lock. Otherwise a
// pause made just before its write could be replaced by setup's stale snapshot.
func TestSetupPolicyEditKeepsAPauseCommittedWhileItWaitsForTheLock(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	if err := writeUpdatePolicy(paths, samplePolicy(t), time.Now(), nil); err != nil {
		t.Fatal(err)
	}
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	unlock, err := lockUpdatePolicy(dir)
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(unlock)
	defer release()

	plan := &updatePlan{consent: UpdateConsentAuto, track: UpdateTrackMinor, pins: []ReleaseKey{testKey(t, nextKeyLine)}}
	run := &setupRun{}
	stateDir := t.TempDir()
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		done <- run.applyUpdates(plan, stateDir)
	}()
	<-started
	select {
	case err := <-done:
		t.Fatalf("setup completed while the policy lock was held: %v", err)
	case <-time.After(250 * time.Millisecond):
	}

	current, basis, err := readUpdatePolicy(paths)
	if err != nil {
		t.Fatal(err)
	}
	current.Paused = true
	data, err := prepareUpdatePolicy(current, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := writeUpdatePolicyInDir(dir, data, &basis); err != nil {
		t.Fatal(err)
	}
	release()
	if err := waitForPolicyWrite(t, done, "setup"); err != nil {
		t.Fatal(err)
	}
	got, err := ReadUpdatePolicy()
	if err != nil || !got.Paused || got.Track != UpdateTrackMinor || len(got.Keys) != 1 || got.Keys[0].Key.Fingerprint() != nextFingerprint {
		t.Fatalf("setup should keep the newly committed pause: %+v, %v", got, err)
	}
	if run.updateStep == nil || !run.updateStep.updates.Paused || !strings.Contains(run.updateStep.words, "paused on this host") {
		t.Fatalf("setup should report the committed pause: %+v", run.updateStep)
	}
}

func TestSetupCanRepairAMalformedPolicyUnderThePolicyLock(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := dir.WriteFile(updatePolicyFile, []byte(`{"schema":"vectory.update-policy.v1","consent":"yes"}`), rootReadable); err != nil {
		t.Fatal(err)
	}
	plan := &updatePlan{consent: UpdateConsentAuto, track: UpdateTrackPatch, pins: []ReleaseKey{testKey(t, teamKeyLine)}}
	var run setupRun
	if err := run.applyUpdates(plan, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	got, err := ReadUpdatePolicy()
	if err != nil || got.Consent != UpdateConsentAuto || len(got.Keys) != 1 || got.Keys[0].Key.Fingerprint() != teamFingerprint {
		t.Fatalf("explicit setup should repair malformed consent: %+v, %v", got, err)
	}
}

// Setup keeps the time a key was pinned for a key that stays.
func TestSetupKeepsWhenAKeyThatStaysWasPinned(t *testing.T) {
	f := newConsentFixture(t)
	second := testReleaseKey(t, "team-next")
	f.server.releaseKeys = releaseKeyList(t, BundleKey{Key: f.key, State: "current"}, BundleKey{Key: second, State: "current"})
	f.consent(UpdateConsentAuto, f.key)
	if _, err := f.run(); err != nil {
		t.Fatal(err)
	}
	first, _ := ReadUpdatePolicy()
	time.Sleep(1100 * time.Millisecond)
	f.consent(UpdateConsentAuto, f.key, second)
	if _, err := f.run(); err != nil {
		t.Fatal(err)
	}
	again, _ := ReadUpdatePolicy()
	if len(again.Keys) != 2 || !again.Keys[0].PinnedAt.Equal(first.Keys[0].PinnedAt) || !again.Keys[1].PinnedAt.After(first.Keys[0].PinnedAt) {
		t.Fatalf("%+v then %+v", first.Keys, again.Keys)
	}
}

// A failure to install the step, which comes after the service is registered, says
// what was saved and what wasn't, and stops before the service is started.
func TestSetupSaysWhatWasSavedWhenTheUpdateStepCantBeInstalled(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAuto, f.key)
	f.installFails = errors.New("systemd refused the unit")
	result, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" || result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if want := "The agent is installed and enrolled, the update policy is saved and the service is registered, but the update step couldn't be installed (Systemd refused the unit). Setup stopped before it started or restarted the service. Until the step is installed, this host takes no update."; failed.Step.Detail != want {
		t.Fatalf("%q", failed.Step.Detail)
	}
	if !f.registered || strings.Contains(strings.Join(f.events, ","), "service-start") {
		t.Fatalf("the service is registered and not started: %v", f.events)
	}
	if failed.Step.Fix != "Fix the cause, then run the same command again; setup resumes where it stopped." {
		t.Fatalf("%q", failed.Step.Fix)
	}
	// The host is enrolled: running the command again needs no token.
	if f.server.enrolls.Load() != 1 || !Installed(f.dir) {
		t.Fatal("the failure undid the enrollment")
	}
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentAuto {
		t.Fatalf("the policy: %+v %v", policy, err)
	}
	f.installFails = nil
	f.options.Token = func() (string, error) { t.Fatal("asked for a token again"); return "", nil }
	f.events = nil
	if again, err := f.run(); err != nil || !again.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(again))
	}
	// It resumes: the step is installed, and then the service starts.
	if got := strings.Join(f.events, ","); got != "eligibility,service-register,install-step,service-start" {
		t.Fatalf("%s", got)
	}
}

// A service that can't be registered leaves the policy saved and the step not
// installed, and says so; the step waits for the service, so nothing asks for it
// first. Run again once the service can be registered, setup finishes.
func TestSetupSaysSoWhenTheServiceCantBeRegisteredForTheUpdateStep(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAuto, f.key)
	f.manager.fail = map[string]error{"install": errors.New("systemctl daemon-reload failed")}
	result, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "service" || result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if got := lastUpdatesStep(t, result); got.Status != "warn" || got.Detail != "The update policy is saved, but the update step isn't installed: it can only be installed once the service is registered. Run the same command again when the service is fixed; setup resumes where it stopped." {
		t.Fatalf("%+v", got)
	}
	if f.stepInstalls() != 0 || f.registered || result.Updates != nil {
		t.Fatalf("%v %v", f.events, result.Updates)
	}
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentAuto {
		t.Fatalf("the policy: %+v %v", policy, err)
	}
	f.manager.fail = nil
	f.options.Token = func() (string, error) { t.Fatal("asked for a token again"); return "", nil }
	f.events = nil
	if again, err := f.run(); err != nil || !again.OK || strings.Join(f.events, ",") != "eligibility,service-register,install-step,service-start" {
		t.Fatalf("%v %v\n%s", err, f.events, serviceDetail(again))
	}
}

// The fake step answers as the real one does when no service is registered, so
// that a setup that asks for the step first can't pass.
func TestTheFakeStepRefusesAHostWhoseServiceIsNotRegistered(t *testing.T) {
	f := newConsentFixture(t)
	if err := f.serviceProblem(f.dir, f.agent); err == nil || err.Error() != "NO_SERVICE: no agent service is registered (/etc/systemd/system/vectory.service doesn't exist)" {
		t.Fatalf("%v", err)
	}
	f.registered, f.registeredFor = true, [3]string{"/usr/local/bin/other", f.dir, "nobody"}
	if err := f.serviceProblem(f.dir, f.agent); err == nil || !strings.HasPrefix(err.Error(), "NO_SERVICE: the registered service doesn't run ") {
		t.Fatalf("%v", err)
	}
}

func TestSetupSaysSoWhenThePolicyCantBeWritten(t *testing.T) {
	f := newConsentFixture(t)
	f.consent(UpdateConsentAuto, f.key)
	// A policy directory that is a file: the policy can't be made.
	if err := os.MkdirAll(filepath.Dir(f.paths.PolicyDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.paths.PolicyDir, []byte("in the way"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.ID != "updates" {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	// The preflight sees a policy directory that isn't a directory before it
	// changes anything.
	if !strings.Contains(failed.Step.Detail, f.paths.PolicyDir) {
		t.Fatalf("%q", failed.Step.Detail)
	}
	f.events = nil
	for _, path := range []string{f.dir, f.paths.StepDir} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s exists", path)
		}
	}
}

// ---------------------------------------------------------------- off

func (f *consentFixture) turnedOn() {
	f.t.Helper()
	f.consent(UpdateConsentAuto, f.key)
	if result, err := f.run(); err != nil || !result.OK {
		f.t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	f.events = nil
	f.manager.actions = nil
	f.options.Token = func() (string, error) { f.t.Fatal("an enrolled host asked for a token"); return "", nil }
}

func TestSetupOffWithdrawsConsentKeepsThePinsAndRemovesTheStep(t *testing.T) {
	f := newConsentFixture(t)
	f.turnedOn()
	// The step's directory exists once it is installed, and the agent staged a build.
	if err := os.MkdirAll(f.paths.StepDir, 0o755); err != nil {
		t.Fatal(err)
	}
	exchange := UpdateExchangeFor(f.dir)
	if err := os.MkdirAll(filepath.Join(exchange.Incoming, strings.Repeat("a", 64)), 0o700); err != nil {
		t.Fatal(err)
	}
	f.options.Updates, f.options.UpdateKeys = UpdateConsentOff, nil
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	policy, err := ReadUpdatePolicy()
	if err != nil || policy.Consent != UpdateConsentOff || len(policy.Keys) != 1 || policy.Keys[0].Key.Line() != f.key.Line() || policy.Track != UpdateTrackPatch {
		t.Fatalf("consent off keeps the pins: %+v %v", policy, err)
	}
	if want := "off · the policy says off · the staged build is deleted · the update step is removed · the pinned key is kept"; lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q", lastUpdatesStep(t, result).Detail)
	}
	// The step goes before the service is looked after, and nothing installs one.
	if len(f.events) == 0 || f.events[0] != "remove-step" || strings.Contains(strings.Join(f.events, ","), "install-step") {
		t.Fatalf("%v", f.events)
	}
	if _, err := os.Lstat(exchange.Dir); !os.IsNotExist(err) {
		t.Fatalf("the staged build was kept: %v", err)
	}
	if f.server.keyRequests.Load() != 1 {
		t.Fatalf("turning updates off asked the server for keys: %d requests", f.server.keyRequests.Load())
	}
	if result.Updates == nil || result.Updates.Consent != UpdateConsentOff {
		t.Fatalf("%+v", result.Updates)
	}
}

func TestSetupOffOnAHostThatNeverTookUpdatesChangesNothing(t *testing.T) {
	f := newConsentFixture(t)
	f.options.Updates = UpdateConsentOff
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if got := lastUpdatesStep(t, result).Detail; got != "off on this host" {
		t.Fatalf("%q", got)
	}
	for _, event := range f.events {
		if event == "remove-step" || event == "install-step" {
			t.Fatalf("setup reached for the step: %v", f.events)
		}
	}
	for _, path := range []string{f.paths.PolicyDir, f.paths.StepDir} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("turning off made %s", path)
		}
	}
	if f.server.keyRequests.Load() != 0 {
		t.Fatal("asked for the list of keys")
	}
}

func TestSetupOffIsRefusedWhileAnUpdateIsBeingTried(t *testing.T) {
	f := newConsentFixture(t)
	f.turnedOn()
	deadline := time.Now().Add(4 * time.Minute).UTC().Truncate(time.Second)
	dir, err := ensureRootOwnedDir(f.paths.StepDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	status := UpdateStatus{RunAt: time.Now().UTC().Truncate(time.Second), Stage: UpdateStageTrial, Eligibility: UpdateEligible, ServiceDefinition: 1, Release: strings.Repeat("c", 64), FromVersion: "0.1.0", ToVersion: "0.1.1", Deadline: deadline}
	if err := WriteUpdateStatus(dir, status); err != nil {
		t.Fatal(err)
	}
	f.options.Updates, f.options.UpdateKeys = UpdateConsentOff, nil
	before, _ := os.ReadFile(f.paths.Policy)
	_, err = f.run()
	var failed *SetupError
	if !errors.As(err, &failed) {
		t.Fatal(err)
	}
	if want := "An update is being tried on this host; it ends by " + humanClock(deadline) + "."; failed.Step.Detail != want || failed.Step.Fix != "Run the command again after that." {
		t.Fatalf("%q %q", failed.Step.Detail, failed.Step.Fix)
	}
	if after, _ := os.ReadFile(f.paths.Policy); string(after) != string(before) {
		t.Fatal("the policy changed")
	}
	for _, event := range f.events {
		if event == "remove-step" {
			t.Fatal("the step was removed during a trial")
		}
	}
}

func TestSetupOffNeedsAdministratorRightsWhenThereIsSomethingToWithdraw(t *testing.T) {
	f := newConsentFixture(t)
	f.turnedOn()
	f.host.elevated = func() bool { return false }
	f.options.Service = "none"
	f.options.Updates, f.options.UpdateKeys = UpdateConsentOff, nil
	before, _ := os.ReadFile(f.paths.Policy)
	_, err := f.run()
	var failed *SetupError
	if !errors.As(err, &failed) || failed.Step.Detail != "Turning agent updates off needs administrator rights." || failed.Step.Fix != elevationHint {
		t.Fatalf("%v", err)
	}
	if after, _ := os.ReadFile(f.paths.Policy); string(after) != string(before) {
		t.Fatal("the policy changed")
	}
}

func TestSetupOffDryRunSaysWhatItWouldDo(t *testing.T) {
	f := newConsentFixture(t)
	f.turnedOn()
	f.options.DryRun = true
	f.options.Updates, f.options.UpdateKeys = UpdateConsentOff, nil
	result, err := f.run()
	if err != nil || !result.OK {
		t.Fatalf("%v\n%s", err, serviceDetail(result))
	}
	if want := "Would turn agent updates off on this host: the consent is withdrawn, the update step is removed and the pinned keys are kept."; lastUpdatesStep(t, result).Detail != want {
		t.Fatalf("%q", lastUpdatesStep(t, result).Detail)
	}
	if policy, _ := ReadUpdatePolicy(); policy.Consent != UpdateConsentAuto {
		t.Fatal("a dry run changed the policy")
	}
}

// Whether turning updates off can go through is looked at before anything changes. A real run looks
// at a rollback through the step's lock, and waits for the run that is trying to start the previous
// build; a dry run must change nothing and wait for nothing, so it never takes the lock (taking it
// makes the file in the step's private directory), and reads the step's files as they are.
func TestSetupOffDryRunLooksAtARollbackWithoutTakingTheStepsLock(t *testing.T) {
	f := newConsentFixture(t)
	f.turnedOn()
	step, err := ensureRootOwnedDir(f.paths.StepDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer step.Close()
	private, err := ensureRootOwnedDir(f.paths.Private, rootPrivate)
	if err != nil {
		t.Fatal(err)
	}
	defer private.Close()
	status := UpdateStatus{RunAt: time.Now().UTC().Truncate(time.Second), Stage: UpdateStageRollingBack, Eligibility: UpdateEligible, ServiceDefinition: 1, Release: strings.Repeat("c", 64), FromVersion: "0.1.0", ToVersion: "0.1.1", Deadline: time.Now().Add(4 * time.Minute).UTC().Truncate(time.Second)}
	if err := WriteUpdateStatus(step, status); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(f.paths.Private, updateLockFile)
	f.options.Updates, f.options.UpdateKeys = UpdateConsentOff, nil

	f.options.DryRun = true
	_, _ = f.run()
	if _, err := os.Lstat(lock); !os.IsNotExist(err) {
		t.Errorf("a dry run took the step's lock: %v", err)
	}
	if policy, _ := ReadUpdatePolicy(); policy.Consent != UpdateConsentAuto {
		t.Error("a dry run changed the policy")
	}

	// A real run takes it, which is what makes the dry run's difference mean something.
	f.options.DryRun = false
	_, _ = f.run()
	if _, err := os.Lstat(lock); err != nil {
		t.Errorf("a real run didn't take the step's lock, so the test shows nothing: %v", err)
	}
}

// ---------------------------------------------------------------- the list of keys

func TestTheListOfKeysIsReadAsTheSharedVectorsSayAndPinsOnlyByComputedFingerprint(t *testing.T) {
	for _, vector := range loadReleaseVectors(t).Bundles {
		t.Run(vector.Name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(vector.BundleB64)
			if err != nil {
				t.Fatal(err)
			}
			offered, err := ParseReleaseKeyBundle(raw)
			if vector.Expect.Result == "refused" {
				var refusal *UpdateRefusal
				if !errors.As(err, &refusal) || refusal.Code != vector.Expect.Code {
					t.Fatalf("%v, want %s (%s)", err, vector.Expect.Code, vector.About)
				}
				return
			}
			if err != nil {
				t.Fatalf("%v (%s)", err, vector.About)
			}
			pins, missing := matchReleaseKeys(offered, []string{vector.Fingerprint})
			switch vector.Expect.Result {
			case "absent":
				if len(pins) != 0 || len(missing) != 1 {
					t.Fatalf("pinned %v (%s)", pins, vector.About)
				}
			default:
				if len(pins) != 1 || pins[0].Line() != vector.Expect.PublicKey || len(missing) != 0 {
					t.Fatalf("pinned %v, want %s (%s)", pins, vector.Expect.PublicKey, vector.About)
				}
			}
		})
	}
}

// ---------------------------------------------------------------- withdrawing

func TestWithdrawingWithNoPolicyLeavesPolicyFileAbsent(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	done, err := withdrawUpdatesReporting("", func() (bool, error) { return false, nil })
	if err != nil || done.PolicyOff || done.KeysKept != 0 {
		t.Fatalf("a host with no update policy: %+v, %v", done, err)
	}
	if _, err := os.Stat(paths.Policy); !os.IsNotExist(err) {
		t.Fatalf("withdrawal created policy.json: %v", err)
	}
	if _, err := os.Stat(paths.PolicyDir); !os.IsNotExist(err) {
		t.Fatalf("withdrawal created a policy directory on a host that never enabled updates: %v", err)
	}
}

// withdrawUpdates is WithdrawUpdates with a removal of the step that says nothing of a rollback.
func withdrawUpdates(dir string, removeStep func() error) (UpdateWithdrawal, error) {
	return withdrawUpdatesReporting(dir, func() (bool, error) { return false, removeStep() })
}

func TestWithdrawingUpdatesFromAnInvalidPolicyWritesOne(t *testing.T) {
	requireRootOwnedWriter(t) // the invalid policy is written as a root-owned file
	paths := useUpdateRoots(t)
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteFile(updatePolicyFile, []byte(`{"schema":"vectory.update-policy.v1","consent":"yes"}`), rootReadable); err != nil {
		t.Fatal(err)
	}
	dir.Close()
	done, err := withdrawUpdates(t.TempDir(), func() error { t.Fatal("no step is installed"); return nil })
	if err != nil || !done.PolicyOff || done.StepRemoved {
		t.Fatalf("%+v %v", done, err)
	}
	if policy, err := ReadUpdatePolicy(); err != nil || policy.Consent != UpdateConsentOff {
		t.Fatalf("%+v %v", policy, err)
	}
}

func TestWithdrawingAMalformedPolicyKeepsAConcurrentSetupRepair(t *testing.T) {
	requireRootOwnedWriter(t)
	paths := useUpdateRoots(t)
	dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := dir.WriteFile(updatePolicyFile, []byte(`{"schema":"vectory.update-policy.v1","consent":"yes"}`), rootReadable); err != nil {
		t.Fatal(err)
	}
	unlock, err := lockUpdatePolicy(dir)
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(unlock)
	defer release()
	started := make(chan struct{})
	results := make(chan struct {
		withdrawal UpdateWithdrawal
		err        error
	}, 1)
	stateDir := t.TempDir()
	go func() {
		close(started)
		withdrawal, err := withdrawUpdatesReporting(stateDir, func() (bool, error) { return false, nil })
		results <- struct {
			withdrawal UpdateWithdrawal
			err        error
		}{withdrawal, err}
	}()
	<-started
	select {
	case result := <-results:
		t.Fatalf("withdrawal completed while the policy lock was held: %+v, %v", result.withdrawal, result.err)
	case <-time.After(250 * time.Millisecond):
	}

	repaired := samplePolicy(t)
	repaired.Paused = true
	data, err := prepareUpdatePolicy(repaired, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := writeUpdatePolicyInDir(dir, data, nil); err != nil {
		t.Fatal(err)
	}
	release()
	select {
	case result := <-results:
		if result.err != nil || !result.withdrawal.PolicyOff || result.withdrawal.KeysKept != 1 {
			t.Fatalf("withdrawal should keep the concurrent pins: %+v, %v", result.withdrawal, result.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("withdrawal did not finish")
	}
	got, err := ReadUpdatePolicy()
	if err != nil || got.Consent != UpdateConsentOff || !got.Paused || len(got.Keys) != 1 || got.Keys[0].Key.Fingerprint() != teamFingerprint {
		t.Fatalf("withdrawal should preserve repaired pins and pause: %+v, %v", got, err)
	}
}

func TestWithdrawalChecksForNewConsentAfterWaitingForThePolicyLock(t *testing.T) {
	for _, alreadyOff := range []bool{false, true} {
		name := "no policy"
		if alreadyOff {
			name = "off policy"
		}
		t.Run(name, func(t *testing.T) {
			requireRootOwnedWriter(t)
			paths := useUpdateRoots(t)
			if alreadyOff {
				p := samplePolicy(t)
				p.Consent = UpdateConsentOff
				if err := writeUpdatePolicy(paths, p, time.Now(), nil); err != nil {
					t.Fatal(err)
				}
			}
			dir, err := ensureRootOwnedDir(paths.PolicyDir, rootReadable)
			if err != nil {
				t.Fatal(err)
			}
			defer dir.Close()
			unlock, err := lockUpdatePolicy(dir)
			if err != nil {
				t.Fatal(err)
			}
			release := sync.OnceFunc(unlock)
			defer release()
			started := make(chan struct{})
			results := make(chan struct {
				withdrawal UpdateWithdrawal
				err        error
			}, 1)
			stateDir := t.TempDir()
			go func() {
				close(started)
				withdrawal, err := withdrawUpdatesReporting(stateDir, func() (bool, error) { return false, nil })
				results <- struct {
					withdrawal UpdateWithdrawal
					err        error
				}{withdrawal, err}
			}()
			<-started
			select {
			case result := <-results:
				t.Fatalf("withdrawal decided before acquiring the policy lock: %+v, %v", result.withdrawal, result.err)
			case <-time.After(250 * time.Millisecond):
			}
			// Commit setup's new consent while the lock is still held, then let
			// withdrawal observe and turn off that exact policy.
			data, err := prepareUpdatePolicy(samplePolicy(t), time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if err := writeUpdatePolicyInDir(dir, data, nil); err != nil {
				t.Fatal(err)
			}
			release()
			select {
			case result := <-results:
				if result.err != nil || !result.withdrawal.PolicyOff || result.withdrawal.KeysKept != 1 {
					t.Fatalf("withdrawal should see the new consent: %+v, %v", result.withdrawal, result.err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("withdrawal did not finish")
			}
			got, err := ReadUpdatePolicy()
			if err != nil || got.Consent != UpdateConsentOff || len(got.Keys) != 1 {
				t.Fatalf("new consent should be withdrawn, keeping pins: %+v, %v", got, err)
			}
		})
	}
}

func TestWithdrawingUpdatesNamesWhenATrialEndsAndWhatItIs(t *testing.T) {
	for stage, want := range map[string]string{
		// A step that has swapped, or is taking a build back, can be held open by a service
		// manager that won't start the agent, so no time is named for either: the words say
		// what it does, and that the step tries every 30 seconds.
		UpdateStageSwapping:    "an update is being applied on this host; the update step stops the agent's service, replaces the executable and starts the service again, and tries every 30 seconds if it can't",
		UpdateStagePreparing:   "an update is being applied on this host; it takes a few minutes",
		UpdateStageRollingBack: "an update is being rolled back on this host; the update step puts the previous build back and starts it, tries every 30 seconds until it can, and then watches it for up to 5 minutes",
		UpdateStageTrial:       "an update is being tried on this host; it ends within 5 minutes",
		UpdateStageIdle:        "",
	} {
		err := updateStageBusy(UpdateStatus{Stage: stage})
		if (err == nil) != (want == "") || err != nil && err.Error() != want {
			t.Errorf("%s: %v, want %q", stage, err, want)
		}
	}
	if err := updateStageBusy(UpdateStatus{Stage: UpdateStageTrial, Deadline: time.Date(2026, 10, 5, 2, 19, 9, 0, time.UTC)}); err == nil || !strings.HasPrefix(err.Error(), "an update is being tried on this host; it ends by ") {
		t.Fatal(err)
	}
}

func TestAWithdrawalSaysWhatItDid(t *testing.T) {
	for withdrawal, want := range map[string]UpdateWithdrawal{
		"off on this host": {},
		"off · the policy says off · the pinned keys are kept": {PolicyOff: true, KeysKept: 2},
		"off · the staged build is deleted":                    {Discarded: true},
	} {
		if got := want.line(); got != withdrawal {
			t.Errorf("%q, want %q", got, withdrawal)
		}
	}
	if got := (UpdateWithdrawal{}).saved(); got != "Nothing was changed." {
		t.Errorf("%q", got)
	}
	if got := (UpdateWithdrawal{PolicyOff: true, Discarded: true}).saved(); got != "Done so far: the policy says off, the staged build is deleted." {
		t.Errorf("%q", got)
	}
}
