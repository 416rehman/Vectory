package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// SetupStep is one scannable line of setup output.
type SetupStep struct {
	ID     string `json:"id"`
	Status string `json:"status"` // ok, info, warn, fail, plan
	Label  string `json:"label"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
}

// SetupOptions are the operator's choices; empty values mean "use the default".
// Setup is a convenience over the separate install, enroll and service
// operations, which keep all of their own checks and guarantees.
type SetupOptions struct {
	Server             string
	CASHA256           string
	CAFile             *string // nil: not chosen; "": system trust; otherwise a CA file
	Name               string
	Mode               string // restricted (default) or full, only when passed
	CapabilityPolicy   string
	VectorBinary       string
	StateDir           string
	ManagedConfig      string
	Service            string // auto, systemd, launchd, windows or none
	ServiceUser        string
	CreateUser         bool
	KeepExistingVector bool
	DashboardURL       string
	DryRun             bool
	// Token is called only when enrollment is actually needed, after every
	// check that doesn't need it has passed.
	Token func() (string, error)
	// Progress receives each step as it completes.
	Progress func(SetupStep)
	// CheckIn bounds the wait for the first check-in after starting the service.
	CheckIn time.Duration
}

// SetupDevice identifies the enrolled device.
type SetupDevice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mode string `json:"mode"`
}

// SetupResult is the complete, secret-free outcome of setup.
type SetupResult struct {
	OK        bool         `json:"ok"`
	DryRun    bool         `json:"dry_run,omitempty"`
	StateDir  string       `json:"state_dir"`
	Server    string       `json:"server,omitempty"`
	Device    *SetupDevice `json:"device,omitempty"`
	DeviceURL string       `json:"device_url,omitempty"`
	Steps     []SetupStep  `json:"steps"`
	Next      string       `json:"next,omitempty"`
}

// SetupError is returned when a step fails; the step carries the explanation.
type SetupError struct{ Step SetupStep }

func (e *SetupError) Error() string {
	if e.Step.Fix == "" {
		return e.Step.Detail
	}
	return e.Step.Detail + " " + e.Step.Fix
}

type setupRun struct {
	options SetupOptions
	result  SetupResult
}

func (r *setupRun) add(id, status, label, detail, fix string) {
	step := SetupStep{ID: id, Status: status, Label: label, Detail: detail, Fix: fix}
	r.result.Steps = append(r.result.Steps, step)
	if r.options.Progress != nil {
		r.options.Progress(step)
	}
}

func (r *setupRun) fail(id, label, detail, fix string) (SetupResult, error) {
	r.add(id, "fail", label, detail, fix)
	return r.result, &SetupError{Step: r.result.Steps[len(r.result.Steps)-1]}
}

func (r *setupRun) failErr(id, label string, err error, fix string) (SetupResult, error) {
	if ce, ok := AsConnectionError(err); ok {
		return r.fail(id, label, ce.Message, ce.Fix)
	}
	var setup *SetupError
	if errors.As(err, &setup) {
		return r.fail(id, label, setup.Step.Detail, setup.Step.Fix)
	}
	return r.fail(id, label, sentence(err.Error()), fix)
}

// sentence capitalizes and terminates an internal error message.
func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	s = strings.ToUpper(s[:1]) + s[1:]
	if !strings.HasSuffix(s, ".") && !strings.HasSuffix(s, "?") {
		s += "."
	}
	return s
}

func chooseService(requested string, platform PlatformInfo) (string, error) {
	native := map[string]string{"linux": "systemd", "darwin": "launchd", "windows": "windows"}[platform.OS]
	switch requested {
	case "", "auto":
		if native == "systemd" && !SystemdAvailable() {
			return "none", nil
		}
		if native == "" {
			return "none", nil
		}
		return native, nil
	case "none":
		return "none", nil
	case "systemd", "launchd", "windows":
		if requested != native || requested == "systemd" && !SystemdAvailable() {
			return "", fmt.Errorf("--service %s isn't available on this host", requested)
		}
		return requested, nil
	}
	return "", errors.New("--service must be auto, systemd, launchd, windows or none")
}

// DefaultDeviceName derives a valid device name from the host name.
func DefaultDeviceName() (name, from string) {
	host, _ := os.Hostname()
	return sanitizeDeviceName(host), host
}

var invalidNameRun = regexp.MustCompile(`[^a-z0-9._-]+`)

func sanitizeDeviceName(host string) string {
	name := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".local")
	name = invalidNameRun.ReplaceAllString(name, "-")
	name = strings.TrimLeft(name, "._-")
	if len(name) > 100 {
		name = strings.TrimRight(name[:100], "._-")
	}
	if name == "" {
		return "device"
	}
	return name
}

// ProbeServer checks that this host reaches the server and trusts it with the
// given CA file ("" for the system store). It sends one HEAD request with no
// token or credential; any HTTP answer proves reachability and trust.
func ProbeServer(ctx context.Context, server, caFile string) error {
	client, err := NewClient(Settings{Server: server, CAFile: caFile}, nil, nil)
	if err != nil {
		return err
	}
	defer client.Close()
	_, err = client.request(ctx, http.MethodHead, "/agent/v1/install.sh", nil)
	if ce, ok := AsConnectionError(err); ok && ce.Delivery == Answered {
		return nil
	}
	return err
}

// packagedLocation reports whether exe already sits where the installer
// (defaultBinary) or an OS package (/usr/bin) puts the agent. The service
// then runs it in place, so package upgrades reach the running service.
func packagedLocation(exe, defaultBinary string) bool {
	same := func(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }
	if runtime.GOOS == "windows" {
		same = func(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
	}
	if same(exe, defaultBinary) {
		return true
	}
	return runtime.GOOS != "windows" && same(exe, "/usr/bin/vectory")
}

func sameContents(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	left, err := FileDigest(a)
	if err != nil {
		return false
	}
	right, err := FileDigest(b)
	return err == nil && left == right
}

// installAgentBinary copies the running agent to its stable location so the
// service never depends on a download folder.
func installAgentBinary(source, target string) error {
	if err := SafePath(target); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(target), ".vectory-install-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Chmod(binaryMode()); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = replaceFile(tmp.Name(), target); err != nil {
		return err
	}
	if !sameContents(source, target) {
		return errors.New("the installed copy doesn't match the running agent")
	}
	return nil
}

func modeDescription(mode string) string {
	if mode == "full" {
		return "full Vector: pipelines can use every Vector feature, with Vector's host permissions"
	}
	return "restricted: reviewed components; this host approves files, destinations and listeners"
}

func describeRunning(running []RunningVector) string {
	parts := make([]string, 0, len(running))
	for _, v := range running {
		parts = append(parts, v.Describe())
	}
	return strings.Join(parts, ", ")
}

// Setup installs, enrolls and starts the agent in one idempotent pass. Every
// check that can fail without the token runs first, and nothing on the host
// changes before the token is entered. Re-running resumes where it stopped.
func Setup(ctx context.Context, options SetupOptions) (SetupResult, error) {
	r := &setupRun{options: options}
	r.result.DryRun = options.DryRun
	defaults := DefaultPaths()

	platform := DetectPlatform(ctx)
	if !map[string]bool{"linux": true, "darwin": true, "windows": true}[platform.OS] || !map[string]bool{"amd64": true, "arm64": true}[platform.Arch] {
		return r.fail("platform", "Platform", platform.Summary()+" isn't a supported agent platform.", "")
	}
	service, err := chooseService(options.Service, platform)
	if err != nil {
		return r.failErr("platform", "Platform", err, "")
	}
	r.add("platform", "ok", "Platform", platform.Summary(), "")
	if service != "none" && !Elevated() && !options.DryRun {
		return r.fail("platform", "Privileges", "Setup needs administrator rights.", elevationHint)
	}

	dir := options.StateDir
	if dir == "" {
		dir = defaults.StateDir
		if legacy := LegacyInstallation(); !Installed(dir) && legacy != "" {
			dir = legacy
			r.add("paths", "info", "State", "Using the existing installation at "+legacy+" (the earlier default location).", "")
		}
	}
	r.result.StateDir = dir
	installed := Installed(dir)
	var settings Settings
	if installed {
		if settings, err = LoadSettings(dir); err != nil {
			return r.fail("paths", "State", "Can't read the installation at "+dir+".", "Keep the directory for inspection, or choose another --state-dir.")
		}
	}
	credentials, _, identityErr := ReadIdentity(dir)
	enrolled := identityErr == nil && credentials.DeviceID != ""
	if identityErr != nil && !os.IsNotExist(identityErr) {
		return r.fail("paths", "State", "The device identity in "+dir+" is unreadable.", "Keep the directory for inspection; an administrator can authorize recovery if it's lost.")
	}

	executable, err := os.Executable()
	if err != nil {
		return r.failErr("agent", "Agent", err, "")
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	agentPath, installBinary := executable, false
	if service != "none" && !packagedLocation(executable, defaults.Binary) {
		agentPath = defaults.Binary
		installBinary = !sameContents(executable, agentPath)
	}
	if !installBinary {
		r.add("agent", "ok", "Agent", agentPath+" "+Version, "")
	}

	var origin string
	if enrolled {
		if options.Server != "" {
			if normalized, err := NormalizeServer(options.Server); err != nil || normalized != settings.Server {
				return r.fail("server", "Server", "This host is enrolled with "+settings.Server+".", "To move it to another server, run `vectory unenroll`, revoke the old device in the dashboard, then run setup again.")
			}
		}
		origin = settings.Server
		r.add("server", "ok", "Server", origin+" · enrolled", "")
	} else {
		if options.Server == "" {
			return r.fail("server", "Server", "Tell setup which server to connect to with --server.", "Copy the complete command from Add device in the dashboard.")
		}
		if origin, err = NormalizeServer(options.Server); err != nil {
			return r.failErr("server", "Server", err, "Use the agent address shown on the Add device page, for example https://vectory.example.com:8443.")
		}
		switch {
		case options.CASHA256 != "":
			pin, err := ParseCAFingerprint(options.CASHA256)
			if err != nil {
				return r.failErr("server", "Server", err, "")
			}
			certificate, err := ProbePinnedCA(ctx, origin, pin)
			if err != nil {
				return r.failErr("server", "Server", err, "")
			}
			r.add("server", "ok", "Server", fmt.Sprintf("%s · CA pinned %s (%s)", origin, ShortFingerprint(pin), certificateName(certificate)), "")
		case options.CAFile != nil && *options.CAFile != "":
			if err := ProbeServer(ctx, origin, *options.CAFile); err != nil {
				return r.failErr("server", "Server", err, "")
			}
			r.add("server", "ok", "Server", origin+" · trusted through "+*options.CAFile, "")
		default:
			if err := ProbeServer(ctx, origin, ""); err != nil {
				return r.failErr("server", "Server", err, "")
			}
			r.add("server", "ok", "Server", origin+" · trusted by this host's certificate store", "")
		}
	}
	r.result.Server = origin

	var vector VectorBinary
	switch {
	case installed:
		if options.VectorBinary != "" {
			if requested, err := ResolveExecutablePath(options.VectorBinary); err != nil || requested.Path != settings.VectorBinary {
				return r.fail("vector", "Vector", "This host already adopted Vector at "+settings.VectorBinary+".", "To approve a different binary: stop the agent, then run `vectory re-adopt --vector-binary PATH --expected-sha256 SHA256`.")
			}
		}
		if digest, err := FileDigest(settings.VectorBinary); err != nil || digest != settings.VectorBinarySHA256 {
			r.add("vector", "warn", "Vector", "The adopted binary at "+settings.VectorBinary+" changed or is missing.", "If you upgraded Vector on purpose, stop the agent and approve it: vectory re-adopt --expected-sha256 SHA256.")
		} else {
			r.add("vector", "ok", "Vector", VectorVersion+" at "+settings.VectorBinary+" · adopted", "")
		}
		vector.Path = settings.VectorBinary
	case options.VectorBinary != "":
		vector = InspectVector(ctx, options.VectorBinary)
		if vector.Problem != "" {
			detail := "Vector at " + vector.Path + ": " + vector.Problem + "."
			if vector.Version != "" {
				detail = "Found Vector " + vector.Version + " at " + vector.Path + "; this agent requires " + VectorVersion + "."
			}
			return r.fail("vector", "Vector", detail, "Install Vector "+VectorVersion+" (https://vector.dev/download/), or pass the right --vector-binary.")
		}
	default:
		found, inspected := FindVector(ctx)
		if found == nil {
			detail := "Vector " + VectorVersion + " isn't installed here (looked on PATH and in the usual locations)."
			for _, candidate := range inspected {
				if candidate.Version != "" {
					detail = "Found Vector " + candidate.Version + " at " + candidate.Path + "; this agent requires " + VectorVersion + "."
					break
				}
			}
			return r.fail("vector", "Vector", detail, "Install Vector "+VectorVersion+" (https://vector.dev/download/), or pass --vector-binary PATH.")
		}
		vector = *found
	}
	if !installed {
		if vector.Linked != "" {
			r.add("vector", "info", "Vector", fmt.Sprintf("%s at %s (linked from %s; the real file is adopted)", vector.Version, vector.Path, vector.Linked), "After upgrading Vector, approve the new binary with `vectory re-adopt`.")
		} else {
			r.add("vector", "ok", "Vector", vector.Version+" at "+vector.Path, "")
		}
	}

	managed := options.ManagedConfig
	if installed {
		managed = settings.ManagedConfig
	} else if managed == "" {
		managed = defaults.ManagedConfig
	}
	if !installed {
		running, checked := DetectRunningVector(ctx)
		switch {
		case !checked:
			r.add("existing", "info", "Existing", "Couldn't check for another running Vector on this platform.", "Stop any other Vector before you deploy a pipeline to this host.")
		case len(running) > 0 && !options.KeepExistingVector:
			stop := "stop it"
			for _, v := range running {
				if v.Service != "" {
					stop = "stop it (for example: sudo systemctl disable --now " + v.Service + ")"
					break
				}
			}
			return r.fail("existing", "Existing", "Vector is already running here: "+describeRunning(running)+". Setup won't take it over.",
				"To hand its workload to Vectory, save its configuration as JSON at "+managed+", "+stop+", then run this command again. To leave it running untouched beside Vectory, add --keep-existing-vector.")
		case len(running) > 0:
			r.add("existing", "info", "Existing", describeRunning(running)+" keeps running untouched.", "Stop it before you deploy a pipeline to this host.")
		}
		if err := CheckFreshStateDirectory(dir); err != nil {
			return r.failErr("paths", "Paths", err, "Choose an empty --state-dir.")
		}
		if err := CheckManagedDirectory(managed, dir); err != nil {
			return r.failErr("paths", "Paths", err, "Choose a --managed-config path in a directory of its own.")
		}
	}
	workload := managed + " (empty until you deploy)"
	if data, err := os.ReadFile(managed); err == nil {
		if !json.Valid(data) {
			return r.fail("paths", "Paths", managed+" isn't valid JSON.", "Fix or remove it; Vectory manages exactly one JSON configuration file.")
		}
		workload = managed + " (existing workload, adopted)"
	}
	if !installed && !Elevated() && !options.DryRun {
		for _, path := range []string{dir, filepath.Dir(managed)} {
			if !writableLocation(path) {
				return r.fail("paths", "Privileges", "Setup can't create "+path+" as this user.", elevationHint)
			}
		}
	}
	r.add("paths", "ok", "Paths", "state "+dir+" · workload "+workload, "")

	mode := options.Mode
	if mode != "" && mode != "restricted" && mode != "full" {
		return r.fail("mode", "Mode", "--mode must be restricted or full.", "")
	}
	var policy *CapabilityPolicy
	if options.CapabilityPolicy != "" {
		if policy, err = ReadInstallPolicy(options.CapabilityPolicy); err != nil {
			return r.failErr("mode", "Mode", err, "Check the allowance file's JSON: file roots, host:port destinations and listeners.")
		}
	}
	if installed {
		current := settings.CapabilityPolicy.ConfigurationMode()
		if mode != "" && mode != current {
			r.add("mode", "warn", "Mode", "This host runs in "+current+" mode; setup doesn't change modes.", fmt.Sprintf("To switch: stop the agent, run `vectory install --state-dir %q --allow-full-vector-config=%t`, then start it again.", dir, mode == "full"))
		} else {
			r.add("mode", "ok", "Mode", modeDescription(current), "")
		}
	} else {
		if mode == "" {
			mode = "restricted"
		}
		detail := modeDescription(mode)
		if policy != nil {
			detail += fmt.Sprintf(" · allowances: %d file roots, %d destinations, %d listeners", len(policy.AllowedFileRoots), len(policy.AllowedNetworkHosts), len(policy.AllowedListenAddresses))
		}
		r.add("mode", "ok", "Mode", detail, "")
	}

	account, createAccount := "", false
	switch service {
	case "windows":
		account = defaults.ServiceUser
		r.add("account", "ok", "Account", account+" (virtual service account)", "")
	case "systemd", "launchd":
		account = options.ServiceUser
		if account == "" {
			account = defaults.ServiceUser
		}
		if err := CheckServiceAccountName(account); err != nil {
			return r.failErr("account", "Account", err, "")
		}
		switch {
		case ServiceAccountExists(account):
			r.add("account", "ok", "Account", account+" (existing)", "")
		case options.CreateUser:
			createAccount = true
		default:
			return r.fail("account", "Account", "The service account "+account+" doesn't exist.", "Add --create-user to create it (no login shell), or pass --service-user NAME for an existing account.")
		}
	}

	name := options.Name
	if enrolled {
		if name != "" && !strings.EqualFold(name, settings.Name) {
			return r.fail("enroll", "Name", "This host is enrolled as "+settings.Name+".", "Rename devices in the dashboard; to start over, run `vectory unenroll` and revoke the old device.")
		}
		name = settings.Name
	} else {
		if name == "" {
			var host string
			name, host = DefaultDeviceName()
			if name != strings.ToLower(host) {
				r.add("name", "info", "Name", fmt.Sprintf("%s (from host name %q)", name, host), "Pass --name to choose another.")
			}
		}
		if _, _, err := enrollmentInput(Settings{Server: origin, Name: name}, "placeholder"); err != nil {
			return r.failErr("name", "Name", err, "Pass a valid --name.")
		}
		if pending, err := ReadPendingEnrollment(dir); err == nil && pending != nil && pending.Delivery == "maybe" && (pending.Name != name || pending.Server != origin) {
			return r.fail("enroll", "Enroll", fmt.Sprintf("An earlier enrollment of %q with %s may have reached the server.", pending.Name, pending.Server), fmt.Sprintf("Run setup again with --server %s --name %s (a new token is fine) so this host gets its identity back.", pending.Server, pending.Name))
		}
	}

	if options.DryRun {
		if createAccount {
			r.add("account", "plan", "Account", "Would create "+account+" (no login shell).", "")
		}
		if installBinary {
			r.add("agent", "plan", "Agent", "Would install "+executable+" as "+agentPath+".", "")
		}
		if !installed {
			r.add("install", "plan", "Install", "Would create "+dir+" and adopt Vector at "+vector.Path+".", "")
		}
		if !enrolled {
			r.add("enroll", "plan", "Enroll", "Would enroll as "+name+" (asks for the token).", "")
		}
		if service != "none" {
			r.add("service", "plan", "Service", "Would register and start the "+service+" service, then wait for the first check-in.", "")
		}
		r.result.OK = true
		r.result.Next = "Run the same command without --dry-run to apply."
		return r.result, nil
	}

	var token string
	if !enrolled {
		if options.Token == nil {
			return r.fail("enroll", "Token", "An enrollment token is required.", "Use the hidden prompt, --token-file PATH or --token-stdin.")
		}
		if token, err = options.Token(); err != nil {
			return r.failErr("enroll", "Token", err, "Copy the token from Add device, then run the command again.")
		}
	}

	if createAccount {
		if err := CreateServiceAccount(ctx, account); err != nil {
			return r.failErr("account", "Account", err, "Create the account yourself, then pass --service-user.")
		}
		r.add("account", "ok", "Account", account+" (created, no login shell)", "")
	}
	if installBinary {
		if err := installAgentBinary(executable, agentPath); err != nil {
			return r.failErr("agent", "Agent", err, "Check that "+filepath.Dir(agentPath)+" is writable.")
		}
		r.add("agent", "ok", "Agent", agentPath+" "+Version+" (installed)", "")
	}

	if !installed {
		install := InstallOptions{Adopt: true, VectorBinary: &vector.Path, ManagedConfig: &managed, CapabilityPolicy: policy}
		if mode == "full" {
			full := true
			install.FullVectorConfig = &full
		}
		if err := InstallWithOptions(ctx, dir, install); err != nil {
			return r.failErr("install", "Install", err, "Fix the cause and run the command again; setup resumes where it stopped.")
		}
		r.add("install", "ok", "Install", "state "+dir+" · Vector adopted", "")
	} else {
		if policy != nil {
			if err := InstallWithOptions(ctx, dir, InstallOptions{CapabilityPolicy: policy}); err != nil {
				r.add("install", "warn", "Install", "Allowances weren't changed: "+sentence(err.Error()), "Stop the agent, then run the command again.")
			} else {
				r.add("install", "ok", "Install", "allowances updated", "")
			}
		} else {
			r.add("install", "ok", "Install", "already installed", "")
		}
	}

	if !enrolled {
		enrollment := EnrollmentOptions{Server: origin, Name: name, Token: token, CAFile: options.CAFile, CASHA256: options.CASHA256}
		if err := EnrollWithOptions(ctx, dir, enrollment); err != nil {
			return r.failErr("enroll", "Enroll", err, "")
		}
		if credentials, _, err = ReadIdentity(dir); err != nil {
			return r.failErr("enroll", "Enroll", err, "")
		}
		if settings, err = LoadSettings(dir); err != nil {
			return r.failErr("enroll", "Enroll", err, "")
		}
	}
	r.result.Device = &SetupDevice{ID: credentials.DeviceID, Name: settings.Name, Mode: settings.CapabilityPolicy.ConfigurationMode()}
	shortID := credentials.DeviceID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	if enrolled {
		r.add("enroll", "ok", "Enroll", fmt.Sprintf("already enrolled as %s (device %s)", settings.Name, shortID), "")
	} else {
		r.add("enroll", "ok", "Enroll", fmt.Sprintf("%s (device %s) · %s mode", settings.Name, shortID, r.result.Device.Mode), "")
	}
	if options.DashboardURL != "" {
		r.result.DeviceURL = strings.TrimRight(options.DashboardURL, "/") + "/#/devices/" + credentials.DeviceID
	}

	if service == "none" {
		if _, err := os.Stat(managed); err == nil {
			r.add("service", "info", "Service", "Not registered (--service none).", "Start the agent to run the adopted workload: vectory run --state-dir "+quoteArg(dir))
			r.result.Next = "Start the agent under your supervisor: vectory run --state-dir " + quoteArg(dir)
		} else {
			started := time.Now()
			if err := Run(ctx, dir, true, func(string) {}); err != nil {
				return r.failErr("service", "Check-in", err, "")
			}
			r.add("service", "ok", "Check-in", fmt.Sprintf("checked in (%s) · no service registered", humanLatency(time.Since(started))), "")
			r.result.Next = "Keep the agent running under your supervisor: vectory run --state-dir " + quoteArg(dir)
		}
		r.result.OK = true
		return r.result, nil
	}

	serviceName := ServiceInfoName(service)
	wasRunning := ServiceStatus(ctx).Running()
	started := time.Now()
	if err := ServiceInstallFor(agentPath, dir, account); err != nil {
		return r.failErr("service", "Service", err, "")
	}
	if err := ServiceControl("start"); err != nil {
		return r.failErr("service", "Service", err, "")
	}
	r.result.Next = "Deploy a pipeline to " + settings.Name + " from the dashboard."
	if state, err := LoadState(dir); wasRunning && err == nil && state.LastHeartbeat != nil && time.Since(*state.LastHeartbeat) < 3*time.Duration(max(state.Policy.HeartbeatSeconds, 10))*time.Second {
		r.add("service", "ok", "Service", fmt.Sprintf("%s running · last check-in %s ago", serviceName, humanLatency(time.Since(*state.LastHeartbeat))), "")
		r.result.OK = true
		return r.result, nil
	}
	wait := options.CheckIn
	if wait <= 0 {
		wait = 45 * time.Second
	}
	if checkedIn := waitForCheckIn(ctx, dir, started, wait); checkedIn != nil {
		r.add("service", "ok", "Service", fmt.Sprintf("%s running · first check-in %s after start", serviceName, humanLatency(checkedIn.Sub(started))), "")
	} else {
		r.add("service", "warn", "Service", serviceName+" started, but hasn't checked in after "+humanLatency(wait)+".", "Check it with `sudo vectory doctor`; the service log: "+serviceLogHint(service))
		r.result.Next = "Run `sudo vectory doctor` to check the connection."
	}
	r.result.OK = true
	return r.result, nil
}

// ServiceInfoName is the user-facing service name for a manager.
func ServiceInfoName(service string) string {
	switch service {
	case "systemd":
		return "vectory.service"
	case "launchd":
		return "io.vectory.agent"
	case "windows":
		return "Vectory service"
	}
	return "agent"
}

func serviceLogHint(service string) string {
	switch service {
	case "systemd":
		return "journalctl -u vectory.service -n 50"
	case "windows":
		return "Event Viewer > Windows Logs > Application"
	}
	return "sudo vectory run in a terminal"
}

func waitForCheckIn(ctx context.Context, dir string, after time.Time, limit time.Duration) *time.Time {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if state, err := LoadState(dir); err == nil && state.LastHeartbeat != nil && !state.LastHeartbeat.Before(after.Add(-time.Second)) {
			seen := *state.LastHeartbeat
			return &seen
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(250 * time.Millisecond):
		}
	}
	return nil
}

func humanLatency(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%d ms", max(d.Milliseconds(), 1))
	case d < time.Minute:
		return fmt.Sprintf("%.1f s", d.Seconds())
	default:
		return humanDuration(d)
	}
}

func quoteArg(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t'\"$`\\") {
		return s
	}
	if runtime.GOOS == "windows" {
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}
