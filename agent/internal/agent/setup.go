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
	Server           string
	CASHA256         string
	CAFile           *string // nil: not chosen; "": system trust; otherwise a CA file
	Name             string
	Mode             string // restricted (default) or full, only when passed
	CapabilityPolicy string
	VectorBinary     string
	// AgentPath is where the service runs the agent from; the installer
	// sets it to the file it installed. Empty: the default location.
	AgentPath          string
	StateDir           string
	ManagedConfig      string
	Service            string // auto, systemd, launchd, windows or none
	ServiceUser        string
	CreateUser         bool
	KeepExistingVector bool
	// AdoptExisting adopts a Vector that ran here as it is, although it loaded
	// configuration the agent doesn't manage (several files, a directory,
	// includes): the agent then manages only its one file.
	AdoptExisting bool
	DashboardURL  string
	DryRun        bool
	// Token is called only when enrollment is actually needed, after every
	// check that doesn't need it has passed.
	Token func() (string, error)
	// Progress receives each step as it completes.
	Progress func(SetupStep)
	// CheckIn bounds the wait for the first check-in after starting the service.
	CheckIn time.Duration
	// NoWake turns wake-ups off (true) or back on (false); nil keeps them.
	NoWake *bool
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
	// Service is what keeps the agent running: systemd, launchd, windows or
	// none (a supervisor of the operator's own, or nothing).
	Service string `json:"service,omitempty"`
	// NeedsAttention: setup finished, but nothing keeps the agent running
	// and the operator didn't choose that with --service none (exit 3).
	NeedsAttention bool `json:"needs_attention,omitempty"`
	// Adoption is what setup learned about a Vector that ran here: how it was
	// started, the configuration files it loads with their checksums, and where
	// they are backed up.
	Adoption *AdoptionInventory `json:"adoption,omitempty"`
}

// SetupError is returned when a step fails; the step carries the explanation.
type SetupError struct{ Step SetupStep }

func (e *SetupError) Error() string {
	switch {
	case e.Step.Fix == "":
		return e.Step.Detail
	case strings.Contains(e.Step.Detail, "\n"):
		return e.Step.Detail + "\n" + e.Step.Fix
	}
	return e.Step.Detail + " " + e.Step.Fix
}

type setupRun struct {
	options SetupOptions
	result  SetupResult
	host    serviceHost
	// stopped names the service setup stopped to replace the agent, until
	// setup starts it again.
	stopped string
	// replaced: the new agent binary is in place.
	replaced bool
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
	if full, ok := diskFullFrom(err); ok {
		return r.fail(id, label, sentence(err.Error()), full.Fix("run the command again; setup resumes where it stopped"))
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

// serviceChoice is the service manager setup registers the agent with. When
// --service auto finds none, reason says why in a few words; explicit means
// the operator passed --service none and runs the agent their own way.
type serviceChoice struct {
	kind     string // systemd, launchd, windows or none
	explicit bool
	reason   string
}

// serviceHost is what setup learns about this host; tests replace it.
type serviceHost struct {
	systemd func() bool   // systemd is running and systemctl is installed
	why     func() string // why systemd can't keep the agent running here
	// detectVector lists running Vector processes (nil: this host's), and
	// settle is how long a process must keep running to count (0: 6 s).
	detectVector func(context.Context) ([]RunningVector, bool)
	settle       time.Duration
	// collect reads how the running Vector processes were started (nil: this
	// host's way).
	collect func(context.Context, []RunningVector) []VectorStartup
}

// transientVector is how long setup waits before it takes a running Vector
// for a workload: the Vectory validator's sample tests run Vector on the
// server's host for at most 5 seconds, and a shared host must not fail on one.
const transientVector = 6 * time.Second

// runningVector lists the Vector processes that keep running: a process
// seen twice, transientVector apart. It reports the wait as an info step.
func (r *setupRun) runningVector(ctx context.Context) ([]RunningVector, bool) {
	detect, settle := r.host.detectVector, r.host.settle
	if detect == nil {
		detect = DetectRunningVector
	}
	if settle <= 0 {
		settle = transientVector
	}
	first, checked := detect(ctx)
	if len(first) == 0 || r.options.KeepExistingVector {
		return first, checked
	}
	r.add("existing", "info", "Existing", fmt.Sprintf("Vector is running here (%s); checking again in %d s in case it's a short test run.", describeRunning(first), int(settle.Round(time.Second)/time.Second)), "")
	select {
	case <-ctx.Done():
		return first, checked
	case <-time.After(settle):
	}
	second, checked := detect(ctx)
	var lasting []RunningVector
	for _, now := range second {
		for _, before := range first {
			if now.PID == before.PID {
				lasting = append(lasting, now)
				break
			}
		}
	}
	return lasting, checked
}

var nativeServiceHost = serviceHost{systemd: SystemdAvailable, why: func() string { return noSystemdReason("/") }}

func chooseService(requested string, platform PlatformInfo, host serviceHost) (serviceChoice, error) {
	native := map[string]string{"linux": "systemd", "darwin": "launchd", "windows": "windows"}[platform.OS]
	switch requested {
	case "", "auto":
		switch {
		case native == "":
			return serviceChoice{kind: "none", reason: "this platform has no service manager setup supports"}, nil
		case native == "systemd" && !host.systemd():
			return serviceChoice{kind: "none", reason: host.why()}, nil
		}
		return serviceChoice{kind: native}, nil
	case "none":
		return serviceChoice{kind: "none", explicit: true}, nil
	case "systemd", "launchd", "windows":
		if requested != native || requested == "systemd" && !host.systemd() {
			return serviceChoice{}, fmt.Errorf("--service %s isn't available on this host", requested)
		}
		return serviceChoice{kind: requested}, nil
	}
	return serviceChoice{}, errors.New("--service must be auto, systemd, launchd, windows or none")
}

// noSystemdReason says why systemd can't keep the agent running on this
// Linux host, reading only well-known marker files under root: containers,
// WSL and OpenRC distributions (Alpine) are the usual reasons.
func noSystemdReason(root string) string {
	exists := func(path string) bool {
		_, err := os.Lstat(filepath.Join(root, path))
		return err == nil
	}
	switch {
	case exists("run/openrc") || exists("sbin/openrc-run"):
		return "this host uses OpenRC, not systemd"
	case exists(".dockerenv") || exists("run/.containerenv"):
		return "systemd isn't running in this container"
	case exists("proc/sys/fs/binfmt_misc/WSLInterop") || wslKernel(filepath.Join(root, "proc/version")):
		return "systemd isn't running in this WSL distribution"
	case exists("run/systemd/system"):
		return "systemctl isn't installed"
	}
	return "systemd isn't running"
}

// wslKernel reports whether /proc/version names Microsoft's WSL kernel.
func wslKernel(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	text := strings.ToLower(string(head[:n]))
	return strings.Contains(text, "microsoft") || strings.Contains(text, "wsl")
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
	return setupWith(ctx, options, nativeService, nativeServiceHost)
}

func setupWith(ctx context.Context, options SetupOptions, ops serviceOps, host serviceHost) (SetupResult, error) {
	r := &setupRun{options: options, host: host}
	result, err := r.setup(ctx, ops)
	return r.restartIfStopped(ops, result, err)
}

// restartIfStopped starts the service setup stopped to replace the agent when
// a later step failed: an upgrade must never leave the device dark.
func (r *setupRun) restartIfStopped(ops serviceOps, result SetupResult, err error) (SetupResult, error) {
	if err == nil || r.stopped == "" {
		return result, err
	}
	r.startAgain(ops)
	return r.result, err
}

func (r *setupRun) setup(ctx context.Context, ops serviceOps) (SetupResult, error) {
	options := r.options
	r.result.DryRun = options.DryRun
	if options.AdoptExisting && options.KeepExistingVector {
		return r.fail("existing", "Existing", "--adopt-existing hands the workload of a running Vector to Vectory, and --keep-existing-vector leaves it running beside Vectory: the two contradict each other.", "Pass only one of them.")
	}
	defaults := DefaultPaths()

	platform := DetectPlatform(ctx)
	if !map[string]bool{"linux": true, "darwin": true, "windows": true}[platform.OS] || !map[string]bool{"amd64": true, "arm64": true}[platform.Arch] {
		return r.fail("platform", "Platform", platform.Summary()+" isn't a supported agent platform.", "")
	}
	choice, err := chooseService(options.Service, platform, r.host)
	if err != nil {
		return r.failErr("platform", "Platform", err, "")
	}
	service := choice.kind
	r.result.Service = service
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
	switch {
	case options.AgentPath != "":
		// The installer placed the agent (--install-dir), or places it there
		// after a dry run: that path is final, with or without a service.
		agentPath = options.AgentPath
		installBinary = !sameContents(executable, agentPath)
	case service == "none":
		// Without a service the agent runs from wherever it is.
	case !packagedLocation(executable, defaults.Binary):
		agentPath = defaults.Binary
		installBinary = !sameContents(executable, agentPath)
	}
	if !installBinary {
		r.add("agent", "ok", "Agent", agentPath+" "+Version, "")
	}
	// The exact command that keeps this agent running without a service.
	runCommand := quoteArg(agentPath) + " run --state-dir " + quoteArg(dir)

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
			r.add("vector", "ok", "Vector", fmt.Sprintf("%s at %s · binary pinned (SHA-256 %s…)", settings.adoptedVectorVersion(), settings.VectorBinary, digest[:12]), "")
		}
		vector.Path = settings.VectorBinary
	case options.VectorBinary != "":
		vector = InspectVector(ctx, options.VectorBinary)
		if vector.Problem != "" {
			detail := "Vector at " + vector.Path + ": " + vector.Problem + "."
			if vector.Version != "" {
				detail = "Found Vector " + vector.Version + " at " + vector.Path + "; this agent requires " + VectorSeries + "."
			}
			return r.fail("vector", "Vector", detail, "Install Vector "+VectorSeries+" (https://vector.dev/download/), or pass the right --vector-binary.")
		}
	default:
		found, inspected := FindVector(ctx)
		if found == nil {
			detail := "Vector " + VectorSeries + " isn't installed here (looked on PATH and in the usual locations)."
			for _, candidate := range inspected {
				if candidate.Version != "" {
					detail = "Found Vector " + candidate.Version + " at " + candidate.Path + "; this agent requires " + VectorSeries + "."
					break
				}
			}
			return r.fail("vector", "Vector", detail, "Install Vector "+VectorSeries+" (https://vector.dev/download/), or pass --vector-binary PATH.")
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
		running, checked := r.runningVector(ctx)
		switch {
		case !checked:
			r.add("existing", "info", "Existing", "Couldn't check for another running Vector on this platform.", "Stop any other Vector before you deploy a pipeline to this host.")
		case len(running) > 0 && !options.KeepExistingVector:
			stop := stopAdvice(running)
			// How it was started and which files it loads is recorded, and the
			// files are copied, before setup says anything else about it.
			inventory := r.inventoryRunning(ctx, running, dir)
			if len(inventory.Blocking()) > 0 && !options.AdoptExisting {
				detail, fix := inventory.refusal("Vector is already running here: "+describeRunning(running)+". Setup won't take it over, and the agent manages exactly one JSON file, so adopting it would drop what these load:", managed, stop)
				return r.fail("existing", "Existing", detail, fix)
			}
			return r.fail("existing", "Existing", "Vector is already running here: "+describeRunning(running)+". Setup won't take it over.", inventory.runningFix(managed, stop, options.AdoptExisting && len(inventory.Blocking()) > 0))
		case len(running) > 0:
			r.add("existing", "info", "Existing", describeRunning(running)+" keeps running untouched.", "Stop it before you deploy a pipeline to this host.")
		}
		if len(running) == 0 {
			// Nothing runs now: an earlier run may have recorded what did.
			if detail, fix, refuse := r.recordedAdoption(dir, managed); refuse {
				return r.fail("existing", "Existing", detail, fix)
			}
		}
		if err := CheckFreshStateDirectory(dir); err != nil {
			return r.failErr("paths", "Paths", err, "Choose an empty --state-dir.")
		}
		if err := checkManagedDirectory(managed, dir, !options.DryRun); err != nil {
			return r.failErr("paths", "Paths", err, "Choose a --managed-config path in a directory of its own.")
		}
	} else if options.AdoptExisting {
		r.add("existing", "info", "Existing", "This host is already set up, so --adopt-existing has nothing to adopt.", "")
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
	case "none":
		// The account is the service's; without one, say so instead of
		// silently ignoring the flag.
		if options.CreateUser {
			verb := "Not created"
			if options.DryRun {
				verb = "Won't be created"
			}
			r.add("account", "info", "Account", verb+": --create-user makes the service's account, and no service is registered here.", "Without a service, the agent runs as whoever starts it.")
		}
	}

	if account != "" && service != "windows" {
		if problem := accountAccessProblem(ctx, account, vector.Path, true, "--version"); problem != "" {
			fix := "Install Vector system-wide (https://vector.dev/download/), or pass --vector-binary with a path the account can read."
			if installed {
				fix = "Install Vector system-wide (https://vector.dev/download/), then approve it: stop the agent and run `vectory re-adopt --vector-binary PATH --expected-sha256 SHA256`."
			}
			return r.fail("vector", "Vector", "The service account "+account+" can't run "+vector.Path+": "+problem+".", fix)
		}
		if !installBinary {
			if problem := accountAccessProblem(ctx, account, agentPath, false, "version"); problem != "" {
				return r.fail("agent", "Agent", "The service account "+account+" can't run "+agentPath+": "+problem+".", agentAccessFix)
			}
		}
	}
	if service != "none" {
		// Registration refuses a service registered for another executable,
		// state directory or account: say so before anything changes.
		if err := ops.check(agentPath, dir, account); err != nil {
			return r.failErr("service", "Service", err, "")
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

	_, statErr := os.Stat(managed)
	adopted := statErr == nil
	if options.DryRun {
		if createAccount {
			r.add("account", "plan", "Account", "Would create "+account+" (no login shell).", "")
		}
		switch {
		case installBinary && options.AgentPath != "":
			// The installer checks and places the agent before setup runs.
			r.add("agent", "plan", "Agent", "Would run "+agentPath+" "+Version+", where the installer puts it.", "")
		case installBinary:
			r.add("agent", "plan", "Agent", "Would install "+executable+" as "+agentPath+".", "")
		}
		if !installed {
			r.add("install", "plan", "Install", "Would create "+dir+" and adopt Vector at "+vector.Path+".", "")
		}
		if !enrolled {
			r.add("enroll", "plan", "Enroll", "Would enroll as "+name+" (asks for the token).", "")
		}
		if service != "none" {
			plan := "Would register and start the " + service + " service, then wait for the first check-in."
			if ops.status(ctx).Running() {
				plan = ServiceInfoName(service) + " is running " + Version + "; nothing to restart."
				if running := runningBuild(dir); running == nil || running.SHA256 != fileDigestOrEmpty(executable) {
					plan = "Would restart " + ServiceInfoName(service) + " to run " + Version + ", then wait for its check-in."
				}
			}
			r.add("service", "plan", "Service", plan, "")
		} else if enrolled && agentLockHeld(dir) {
			r.add("service", "plan", "Service", "none · the agent is already running; nothing to start.", "")
		} else {
			r.withoutService(choice, runCommand, adopted, true)
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
		if err := r.installAgent(ctx, ops, service, executable, agentPath, dir, account); err != nil {
			return r.result, err
		}
		if account != "" && service != "windows" {
			if problem := accountAccessProblem(ctx, account, agentPath, false, "version"); problem != "" {
				return r.fail("agent", "Agent", "The service account "+account+" can't run "+agentPath+": "+problem+".", agentAccessFix)
			}
		}
	}

	if !installed {
		install := InstallOptions{Adopt: true, VectorBinary: &vector.Path, ManagedConfig: &managed, CapabilityPolicy: policy, NoWake: options.NoWake}
		if mode == "full" {
			full := true
			install.FullVectorConfig = &full
		}
		if err := InstallWithOptions(ctx, dir, install); err != nil {
			return r.failErr("install", "Install", err, "Fix the cause and run the command again; setup resumes where it stopped.")
		}
		pinned := "Vector binary pinned"
		if saved, err := LoadSettings(dir); err == nil && len(saved.VectorBinarySHA256) >= 12 {
			pinned = fmt.Sprintf("Vector %s binary pinned (SHA-256 %s…)", saved.adoptedVectorVersion(), saved.VectorBinarySHA256[:12])
		}
		r.add("install", "ok", "Install", "state "+dir+" · "+pinned, "")
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
		if options.NoWake != nil {
			if err := InstallWithOptions(ctx, dir, InstallOptions{NoWake: options.NoWake}); err != nil {
				r.add("install", "warn", "Install", "Wake-ups weren't changed: "+sentence(err.Error()), "Stop the agent, then run the command again.")
			}
		}
	}

	if !enrolled {
		enrollment := EnrollmentOptions{Server: origin, Name: name, Token: token, CAFile: options.CAFile, CASHA256: options.CASHA256, ServiceManager: service}
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
		if enrolled && agentLockHeld(dir) {
			// Setup ran again beside a running agent: nothing to start, unless
			// it runs an older build than the one just installed (an upgrade),
			// which only a restart by whoever started it replaces.
			process, stop := "vectory run", "Stop it (Ctrl-C where it runs)"
			if owner := readLockOwner(dir); owner != nil {
				process = fmt.Sprintf("vectory %s, pid %d", owner.Command, owner.PID)
				stop = fmt.Sprintf("Stop it (Ctrl-C where it runs, or sudo kill %d)", owner.PID)
			}
			if running, installed := runningBuild(dir), fileDigestOrEmpty(agentPath); running != nil && installed != "" && running.SHA256 != installed {
				r.add("service", "warn", "Service", fmt.Sprintf("none · the agent still runs %s (%s); %s is installed.", running.Version, process, Version), "")
				r.result.Next = stop + ", then start it again to run " + Version + ": " + runCommand
				r.result.OK = true
				return r.result, nil
			}
			r.add("service", "ok", "Service", "none · the agent is already running ("+process+")", "")
			r.result.Next = "Nothing to start. Deploy a pipeline to " + settings.Name + " from the dashboard."
			r.result.OK = true
			return r.result, nil
		}
		if adopted {
			// Setup never starts an adopted workload itself: the agent does,
			// once it runs.
			r.result.Next = "Start the agent under your supervisor: " + runCommand
		} else {
			started := time.Now()
			// The same full check-in a running agent sends, from a process
			// that stops right after it: no service keeps it running.
			err := runWith(ctx, dir, runOptions{once: true, serviceManager: "none"}, func(string) {})
			switch {
			case ctx.Err() != nil:
				return r.interrupted("Check-in", "Interrupted before the first check-in.", "Start the agent under your supervisor: "+runCommand)
			case err != nil:
				return r.failErr("checkin", "Check-in", err, "")
			}
			detail := "checked in (" + humanLatency(time.Since(started)) + ")"
			if choice.explicit {
				detail += " · no service registered"
			}
			r.add("checkin", "ok", "Check-in", detail, "")
			r.result.Next = "Keep the agent running under your supervisor: " + runCommand
			if !choice.explicit {
				r.result.Next = "Start the agent and keep it running: " + runCommand
			}
		}
		r.withoutService(choice, runCommand, adopted, false)
		r.result.OK = true
		return r.result, nil
	}

	r.result.Next = "Deploy a pipeline to " + settings.Name + " from the dashboard."
	return r.startService(ctx, ops, service, agentPath, dir, account, settings.gracefulShutdownSeconds())
}

// withoutService says what keeps the agent running when no service is
// registered. With --service none the operator runs it their own way. When
// --service auto found no service manager, the agent stops right after
// setup's check-in (or never starts an adopted workload): that needs the
// operator, so setup ends with exit 3 and the exact command.
func (r *setupRun) withoutService(choice serviceChoice, run string, adopted, dryRun bool) {
	if choice.explicit {
		switch {
		case adopted && dryRun:
			r.add("service", "plan", "Service", "Not registered (--service none): the adopted workload runs once you start the agent.", "Start it under your supervisor: "+run)
		case adopted:
			r.add("service", "info", "Service", "Not registered (--service none).", "Start the agent to run the adopted workload: "+run)
		case dryRun:
			r.add("service", "plan", "Service", "Would check in once, then stop (--service none).", "Keep it running with your own supervisor: "+run)
		}
		return
	}
	r.result.NeedsAttention = true
	why := "No supported service manager here (" + choice.reason + ")"
	acknowledge := "Keep it running with your own supervisor (" + run + ") and pass --service none, or use a host with systemd."
	switch {
	case adopted && dryRun:
		r.add("service", "warn", "Service", why+", so nothing would run the adopted workload.", acknowledge)
	case adopted:
		r.add("service", "warn", "Service", why+", so nothing runs the adopted workload.", "Start the agent under your own supervisor: "+run)
	case dryRun:
		r.add("service", "warn", "Service", why+", so the agent would stop after its first check-in.", acknowledge)
	default:
		r.add("service", "warn", "Service", why+", so the agent stopped after its first check-in.", "Keep it running with your own supervisor: "+run)
	}
}

// serviceOps is the service manager setup drives; tests replace it.
type serviceOps struct {
	install func(exe, dir, account string) (ServiceRegistration, error)
	// check reports, reading only, whether the service is registered for
	// another executable, state directory or account (install refuses that).
	check   func(exe, dir, account string) error
	control func(action string) error
	status  func(context.Context) ServiceInfo
	// replace puts the agent binary where the service runs it from.
	replace func(source, target string) error
	// stopToReplace: the running executable can't be replaced (Windows), so
	// setup stops the service first.
	stopToReplace bool
	// keepsDefinition: restart keeps the loaded definition (launchd), so an
	// updated one takes a stop and a start.
	keepsDefinition bool
}

var nativeService = serviceOps{install: ServiceInstallFor, check: serviceRegistrationCheck, control: ServiceControl, status: ServiceStatus, replace: installAgentBinary,
	stopToReplace: runtime.GOOS == "windows", keepsDefinition: runtime.GOOS == "darwin"}

// installAgent puts the running agent at agentPath. Windows can't replace a
// running executable, so a running service is stopped first, and only after
// a read-only check that it is registered for this agent: registration would
// refuse it later, with the service already stopped. If setup fails before
// the service step starts it again, Setup restarts it.
func (r *setupRun) installAgent(ctx context.Context, ops serviceOps, service, executable, agentPath, dir, account string) error {
	if ops.stopToReplace && ops.status(ctx).Running() {
		if err := ops.check(agentPath, dir, account); err != nil {
			_, err = r.failErr("service", "Service", err, "")
			return err
		}
		r.stopped = service
		if err := ops.control("stop"); err != nil {
			if ops.status(ctx).Running() {
				r.stopped = ""
			}
			_, err = r.failErr("agent", "Agent", err, "Stop the Vectory service, then run the command again.")
			return err
		}
		r.add("agent", "info", "Agent", ServiceInfoName(service)+" stopped to replace "+agentPath+".", "")
	}
	if err := ops.replace(executable, agentPath); err != nil {
		_, err = r.failErr("agent", "Agent", err, "Check that "+filepath.Dir(agentPath)+" is writable.")
		return err
	}
	r.replaced = true
	r.add("agent", "ok", "Agent", agentPath+" "+Version+" (installed)", "")
	return nil
}

// startAgain starts the service setup stopped to replace the agent, after a
// later step failed: the device keeps running its pipeline.
func (r *setupRun) startAgain(ops serviceOps) {
	name := ServiceInfoName(r.stopped)
	r.stopped = ""
	if err := ops.control("start"); err != nil {
		r.add("service", "fail", "Service", name+" is stopped, and starting it again failed: "+sentence(err.Error()), "Start it: vectory service-start")
		return
	}
	build := "the previous build"
	if r.replaced {
		build = Version
	}
	r.add("service", "info", "Service", name+" restarted on "+build+".", "")
}

// interrupted ends setup after Ctrl-C while it waits for the first check-in.
func (r *setupRun) interrupted(label, detail, fix string) (SetupResult, error) {
	r.add("service", "warn", label, detail, fix)
	return r.result, &SetupError{Step: r.result.Steps[len(r.result.Steps)-1]}
}

// startService registers the service and makes sure it ends up running the
// installed build: an upgrade replaces the file, but the old process keeps
// running until it is restarted. It reports the first check-in of that build.
func (r *setupRun) startService(ctx context.Context, ops serviceOps, service, agentPath, dir, account string, drain int) (SetupResult, error) {
	serviceName := ServiceInfoName(service)
	registration, err := ops.install(agentPath, dir, account)
	if err != nil {
		return r.failErr("service", "Service", err, "")
	}
	if registration == ServiceUpdated {
		r.add("service", "info", "Service", serviceName+" definition updated.", "")
	}
	digest := fileDigestOrEmpty(agentPath)
	running := runningBuild(dir)
	current := running != nil && digest != "" && running.SHA256 == digest
	wait := r.options.CheckIn
	if wait <= 0 {
		wait = 45 * time.Second
	}
	started := time.Now()
	startedHere, restarted := false, false
	switch {
	case !ops.status(ctx).Running():
		// Setup stopped it to replace the agent: starting it is the restart.
		restarted, r.stopped = r.stopped != "", ""
		if err := ops.control("start"); err != nil {
			return r.failErr("service", "Service", err, "")
		}
		startedHere = true
	case !current || registration == ServiceUpdated && ops.keepsDefinition:
		r.add("service", "info", "Service", fmt.Sprintf("Restarting %s to run %s. Vector finishes in-flight events first (up to %d s).", serviceName, Version, drain), "")
		started, restarted = time.Now(), true
		if registration == ServiceUpdated && ops.keepsDefinition {
			// launchd keeps a loaded definition across a restart: unload the
			// job, then load the updated definition.
			r.stopped = service
			if err := ops.control("stop"); err != nil {
				if ops.status(ctx).Running() {
					r.stopped = ""
				}
				return r.failErr("service", "Service", err, "")
			}
			r.stopped = ""
			err = ops.control("start")
		} else {
			err = ops.control("restart")
		}
		if err != nil {
			return r.failErr("service", "Service", err, "")
		}
		wait += time.Duration(drain) * time.Second
	default:
		if state, err := LoadState(dir); err == nil && state.LastHeartbeat != nil && time.Since(*state.LastHeartbeat) < 3*time.Duration(max(state.Policy.HeartbeatSeconds, 10))*time.Second {
			r.add("service", "ok", "Service", fmt.Sprintf("%s running %s · last check-in %s ago", serviceName, Version, humanLatency(time.Since(*state.LastHeartbeat))), "")
			r.result.OK = true
			return r.result, nil
		}
	}
	checkedIn := waitForCheckIn(ctx, dir, started, wait, digest)
	switch {
	case checkedIn != nil && restarted && running != nil && running.Version != Version:
		r.add("service", "ok", "Service", fmt.Sprintf("%s upgraded %s → %s · first check-in %s after restart", serviceName, running.Version, Version, humanLatency(checkedIn.Sub(started))), "")
	case checkedIn != nil && restarted:
		r.add("service", "ok", "Service", fmt.Sprintf("%s restarted on %s · first check-in %s after restart", serviceName, Version, humanLatency(checkedIn.Sub(started))), "")
	case checkedIn != nil && startedHere:
		r.add("service", "ok", "Service", fmt.Sprintf("%s running · first check-in %s after start", serviceName, humanLatency(checkedIn.Sub(started))), "")
	case checkedIn != nil:
		r.add("service", "ok", "Service", fmt.Sprintf("%s running %s · last check-in %s ago", serviceName, Version, humanLatency(time.Since(*checkedIn))), "")
	case ctx.Err() != nil:
		return r.interrupted("Service", "Interrupted; "+serviceName+" keeps running.", "Check it later with `"+adminCommand(service, "vectory status")+"`.")
	default:
		what := "is running"
		switch {
		case restarted:
			what = "restarted on " + Version
		case startedHere:
			what = "started"
		}
		r.add("service", "warn", "Service", serviceName+" "+what+", but hasn't checked in after "+humanLatency(wait)+".", serviceCheckHint(service))
		r.result.Next = "Run `" + adminCommand(service, "vectory doctor") + "` to check the connection."
	}
	r.result.OK = true
	return r.result, nil
}

// agentAccessFix explains how to make the agent runnable for its account.
const agentAccessFix = "Install the agent where every account can run it (mode 0755, for example in /usr/local/bin), then run setup again."

// runningBuild is the agent build that last saved the state, if recorded.
func runningBuild(dir string) *AgentBuild {
	state, err := LoadState(dir)
	if err != nil {
		return nil
	}
	return state.Agent
}

func fileDigestOrEmpty(path string) string {
	digest, err := FileDigest(path)
	if err != nil {
		return ""
	}
	return digest
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

// adminCommand is how to run an agent command as an administrator here.
func adminCommand(service, command string) string {
	if service == "windows" {
		return command
	}
	return "sudo " + command
}

// serviceCheckHint says how to look into a service that hasn't checked in.
// Only systemd keeps the agent's output: launchd discards it, and a Windows
// service has no console and writes no event log. There, status shows the
// last check-in error and logs shows Vector's own log.
func serviceCheckHint(service string) string {
	switch service {
	case "systemd":
		return "Check it with `sudo vectory doctor`; the agent's log: journalctl -u vectory.service -n 50"
	case "windows":
		return "Check it with `vectory doctor` in an elevated PowerShell; `vectory status` shows the last check-in error and `vectory logs` Vector's log."
	}
	return "Check it with `sudo vectory doctor`; `sudo vectory status` shows the last check-in error and `sudo vectory logs` Vector's log."
}

// waitForCheckIn waits for a check-in after the given time, from the agent
// build with the given digest when one is given.
func waitForCheckIn(ctx context.Context, dir string, after time.Time, limit time.Duration, digest string) *time.Time {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if state, err := LoadState(dir); err == nil && state.LastHeartbeat != nil && !state.LastHeartbeat.Before(after.Add(-time.Second)) &&
			(digest == "" || state.Agent != nil && state.Agent.SHA256 == digest) {
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
