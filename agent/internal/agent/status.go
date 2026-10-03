package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// NotInstalledError explains that no agent is installed at a state directory.
type NotInstalledError struct {
	StateDir string
	Legacy   string
}

func (e *NotInstalledError) Error() string {
	message := "No agent is installed at " + e.StateDir + "."
	if e.Legacy != "" {
		return message + " An installation exists at " + e.Legacy + " (an earlier default); pass --state-dir " + quoteArg(e.Legacy) + "."
	}
	return message + " Set one up with the command from Add device (vectory setup ...), or pass --state-dir."
}

// CheckInstalled returns a NotInstalledError, a permission explanation, or nil.
func CheckInstalled(dir string) error {
	info, err := os.Lstat(filepath.Join(dir, "settings.json"))
	switch {
	case err == nil && info.Mode().IsRegular():
		return nil
	case errors.Is(err, os.ErrPermission):
		return errors.New("can't read " + dir + " as this user; run the command with sudo")
	}
	legacy := LegacyInstallation()
	if legacy == filepath.Clean(dir) {
		legacy = ""
	}
	return &NotInstalledError{StateDir: dir, Legacy: legacy}
}

// RunCommandFor runs this agent in the foreground for dir, by this
// executable's absolute path: an agent installed with --install-dir is often
// not the vectory that PATH finds.
func RunCommandFor(dir string) string {
	exe, err := os.Executable()
	if err != nil {
		exe = "vectory"
	} else if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	command := CommandFor(dir, ShellQuote(exe)+" run")
	if runtime.GOOS == "windows" {
		return command
	}
	return "sudo " + command
}

// CommandFor is a command to print for an operator to run against the agent
// installed at dir. words is the command and its flags, such as
// "sudo vectory resume". The command names its state directory, quoted for the
// shell, when dir isn't this platform's default: copied as it stands, it would
// otherwise act on the default agent, or on none. An empty dir means the
// state directory isn't known, and the command stays as written. The service
// commands act on the one registered service and refuse --state-dir, so they
// are never passed through it.
func CommandFor(dir, words string) string {
	if dir == "" || filepath.Clean(dir) == filepath.Clean(DefaultPaths().StateDir) {
		return words
	}
	return words + " --state-dir " + ShellQuote(dir)
}

// hintWithCommand is a fix for a diagnostic, which leaves the host and is
// bounded: lead, the command for the agent at dir, then tail. A state
// directory too long for the bound would be cut in the middle and send the
// operator to the wrong place, so then the hint names the flag instead of the
// path; status prints the whole command.
func hintWithCommand(lead, dir, words, tail string) string {
	if hint := lead + CommandFor(dir, words) + tail; utf8.RuneCountInString(hint) <= maxDiagnosticHint {
		return hint
	}
	return lead + words + ", naming this agent's --state-dir" + tail
}

// ShellQuote keeps a value bare only when every character in it is one no
// shell reads specially: a path with a semicolon, an ampersand or a bracket
// would run as something else when pasted.
func ShellQuote(s string) string {
	if s != "" && strings.Trim(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./:+-") == "" {
		return s
	}
	if runtime.GOOS == "windows" {
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// StatusView gathers everything status shows, read-only.
type StatusView struct {
	StateDir    string
	Settings    Settings
	State       State
	DeviceID    string
	CertExpiry  time.Time
	Pending     *PendingEnrollment
	Service     ServiceInfo
	Foreground  bool       // an agent runs without a service manager...
	Owner       *LockOwner // ...as this process, when it recorded itself
	LocalPaused bool
	ActualSHA   string
	Drift       bool
	BinaryOK    bool
	// Delivery is a sink that failed requests in the last minute, from the
	// local Vector log; nil when the log shows none.
	Delivery *DeliveryProblem
	Next     string
	// ReadAt is when the view was read; the machine-readable form measures the
	// check-in schedule from it.
	ReadAt time.Time
}

// ReadStatus builds the status view for dir.
func ReadStatus(ctx context.Context, dir string) (*StatusView, error) {
	if err := CheckInstalled(dir); err != nil {
		return nil, err
	}
	s, err := LoadSettings(dir)
	if err != nil {
		return nil, err
	}
	st, err := LoadState(dir)
	if err != nil {
		return nil, err
	}
	v := &StatusView{StateDir: dir, Settings: s, State: st, LocalPaused: LocalPaused(dir)}
	if cred, _, err := ReadIdentity(dir); err == nil {
		v.DeviceID = cred.DeviceID
		v.CertExpiry = cred.CertificateExpiresAt
	}
	if v.DeviceID == "" {
		v.Pending, _ = ReadPendingEnrollment(dir)
	}
	v.ActualSHA, _ = FileDigest(s.ManagedConfig)
	v.Drift = st.LastGoodSHA256 != "" && v.ActualSHA != st.LastGoodSHA256
	digest, err := FileDigest(s.VectorBinary)
	v.BinaryOK = err == nil && digest == s.VectorBinarySHA256
	v.Service = ServiceStatus(ctx)
	if v.Service.StateDir != "" && filepath.Clean(v.Service.StateDir) != filepath.Clean(dir) {
		v.Service = ServiceInfo{Manager: v.Service.Manager, Name: v.Service.Name}
	}
	v.Foreground = !v.Service.Running() && agentLockHeld(dir)
	if v.Foreground {
		v.Owner = readLockOwner(dir)
	}
	now := time.Now()
	v.ReadAt = now
	v.Delivery = recentDeliveryProblem(dir, s.ManagedConfig, now)
	v.Next = v.nextStep(now)
	return v, nil
}

func (v *StatusView) running() bool { return v.Service.Running() || v.Foreground }

// checkInInterval is how often the server's agent settings, as the last signed
// manifest gave them, ask this device to check in.
func (v *StatusView) checkInInterval() time.Duration {
	seconds := v.State.Policy.HeartbeatSeconds
	if seconds < 10 || seconds > 3600 {
		seconds = 60
	}
	return time.Duration(seconds) * time.Second
}

func (v *StatusView) heartbeatLimit() time.Duration { return 3 * v.checkInInterval() }

// checkInDue is when the next check-in is due: the last successful one plus the
// interval. ok is false while the device hasn't checked in, and while no agent
// runs: nothing is due then.
func (v *StatusView) checkInDue() (due time.Time, ok bool) {
	if v.DeviceID == "" || v.State.LastHeartbeat == nil || !v.running() {
		return time.Time{}, false
	}
	return v.State.LastHeartbeat.Add(v.checkInInterval()), true
}

// everyInterval says an interval the way people do: "every minute", "every
// 15 s", "every 5 min".
func everyInterval(d time.Duration) string {
	seconds := int(d / time.Second)
	switch {
	case seconds == 60:
		return "every minute"
	case seconds == 3600:
		return "every hour"
	case seconds%60 == 0:
		return fmt.Sprintf("every %d min", seconds/60)
	}
	return fmt.Sprintf("every %d s", seconds)
}

// wakeStatus is whether this device holds a wait open between check-ins, for
// the server to answer the moment something changes for it. Reason says why
// not when it doesn't.
type wakeStatus struct {
	Listening bool
	Reason    string
}

// Why a device isn't holding a wait.
const (
	wakeReasonHost     = "host_setting"      // install --no-wake
	wakeReasonRun      = "run_flag"          // vectory run --no-wake
	wakeReasonCheckIns = "check_ins_failing" // the ordinary backoff applies
	wakeReasonRequests = "requests_failing"  // the last wait ended in an error
)

// wakeUps reads what the agent itself knows: the server's signed features, the
// host's setting, and what the run loop saw and recorded. ok is false when
// there is nothing true to say: no check-in yet, a server that doesn't hold
// waits (an older one), or an agent that isn't running.
func (v *StatusView) wakeUps() (wakeStatus, bool) {
	if v.DeviceID == "" || v.State.LastHeartbeat == nil || !slices.Contains(v.State.ServerFeatures, featureWake) || !v.running() {
		return wakeStatus{}, false
	}
	switch {
	case v.Settings.NoWake:
		return wakeStatus{Reason: wakeReasonHost}, true
	case v.State.Wake == wakeOffRun:
		return wakeStatus{Reason: wakeReasonRun}, true
	case v.checkInFailure() != nil:
		return wakeStatus{Reason: wakeReasonCheckIns}, true
	case v.State.Wake == wakeFailed:
		return wakeStatus{Reason: wakeReasonRequests}, true
	}
	return wakeStatus{Listening: true}, true
}

func (w wakeStatus) text() string {
	switch w.Reason {
	case "":
		return "on · a new version or setting reaches this device within seconds"
	case wakeReasonHost:
		return "off · turned off on this host, so changes arrive at the next check-in"
	case wakeReasonRun:
		return "off · this run was started with --no-wake, so changes arrive at the next check-in"
	case wakeReasonCheckIns:
		return "paused while check-ins fail"
	}
	return "not getting through · the last request failed, so changes arrive at the next check-in"
}

// checkInFailure is the current outage, if check-ins fail since the last success.
func (v *StatusView) checkInFailure() *CheckInFailure {
	failure := v.State.CheckInFailure
	if failure == nil || v.DeviceID == "" || v.State.LastHeartbeat != nil && !failure.Since.After(*v.State.LastHeartbeat) {
		return nil
	}
	return failure
}

func (v *StatusView) nextStep(now time.Time) string {
	command := func(words string) string { return CommandFor(v.StateDir, words) }
	switch {
	case v.DeviceID == "" && v.Pending != nil && v.Pending.Delivery == "refused":
		return "The server refused the last enrollment. Ask an administrator for the reason (Add device page), then run setup again; a new token is fine."
	case v.DeviceID == "" && v.Pending != nil && v.Pending.Delivery == "no":
		return "The last enrollment never reached the server. Fix the connection (" + command("vectory doctor") + "), then run the command again."
	case v.DeviceID == "" && v.Pending != nil:
		return "Finish enrolling: run the same command again with --name " + v.Pending.Name + " (a new token is fine)."
	case v.DeviceID == "":
		return "Enroll this host: copy the command from Add device in the dashboard."
	case !v.BinaryOK:
		return "The adopted Vector binary changed. Restore it, or stop the agent and approve it with `" + command("vectory re-adopt --expected-sha256 SHA256") + "`."
	case v.Service.Installed && !v.Service.Running():
		return "Start the agent: sudo vectory service-start"
	case !v.running():
		return "Start the agent: " + RunCommandFor(v.StateDir) + " (or register a service with " + command("vectory setup") + ")."
	case v.LocalPaused:
		return "Configuration sync is paused on this host. Resume it with: " + command("sudo vectory resume")
	case v.State.LastHeartbeat == nil:
		return "Waiting for the first check-in. If it doesn't arrive within a minute, run `" + command("sudo vectory doctor") + "`."
	case v.checkInFailure() != nil:
		return v.checkInFailure().Message
	case now.Sub(*v.State.LastHeartbeat) > v.heartbeatLimit():
		return "No check-in for " + humanDuration(now.Sub(*v.State.LastHeartbeat)) + ". Run `" + command("sudo vectory doctor") + "` to check the connection."
	case v.State.Error != nil:
		return applyNextAction(v.StateDir, v.State)
	case v.Delivery != nil:
		// Applied and verified is not delivering: Vector's own log says a
		// sink fails its requests.
		return v.Delivery.Next(v.StateDir)
	case v.State.Desired == nil:
		return "Nothing to do here. Deploy a pipeline to " + v.Settings.Name + " from the dashboard."
	}
	return "Nothing to do."
}

var applyStateLabels = map[string]string{
	"unmanaged":            "no pipeline assigned",
	"desired":              "update waiting",
	"downloaded":           "downloaded",
	"validated":            "validated",
	"written":              "applying",
	"reload_requested":     "loading in Vector",
	"verified_applied":     "applied and verified",
	"verification_unknown": "applied, activation unconfirmed",
	"failed":               "failed",
	"rolled_back":          "rolled back to the last good configuration",
	"paused":               "paused",
}

func (v *StatusView) pipeline() string {
	st := v.State
	label := applyStateLabels[st.ApplyState]
	if label == "" {
		label = strings.ReplaceAll(st.ApplyState, "_", " ")
	}
	if st.Desired == nil {
		switch {
		case st.Applied != nil && st.LastGoodSHA256 != "" && v.ActualSHA != "":
			// A version Vectory applied keeps running after it is unassigned.
			return "No pipeline assigned · still running the last version Vectory applied"
		case st.LastGoodSHA256 != "" && v.ActualSHA != "":
			return "No pipeline assigned · running the adopted local configuration"
		}
		return "No pipeline assigned yet"
	}
	version := st.Desired.VersionID
	if len(version) > 8 {
		version = version[:8]
	}
	text := fmt.Sprintf("Version %s (generation %d) · %s", version, st.HighestGeneration, label)
	if name, number, ok := st.Desired.pipeline(); ok {
		// The signed manifest named it: say so, and keep the identity beside it.
		text = fmt.Sprintf("%s · version %d (%s, generation %d) · %s", name, number, version, st.HighestGeneration, label)
	}
	if st.Error != nil && (st.ApplyState == "failed" || st.ApplyState == "rolled_back") {
		text += ": " + st.Error.Message
	}
	if v.Drift {
		text += " · local edits detected"
	}
	return text
}

// runningVersion names the pipeline version that runs when the Pipeline row
// doesn't: the one a rollback restored, or the last one applied before the
// device was unassigned. It comes from the signed manifest that delivered that
// version, so it is absent for a server that doesn't name versions.
func (v *StatusView) runningVersion() (string, bool) {
	name, number, ok := v.State.Applied.pipeline()
	if !ok || v.State.Desired != nil && v.State.Desired.VersionID == v.State.Applied.VersionID {
		return "", false
	}
	text := fmt.Sprintf("%s · version %d", name, number)
	if v.State.Desired == nil {
		text += " · no longer assigned"
	}
	if v.Drift {
		text += " · local edits detected"
	}
	return text, true
}

// checkInText says when the next check-in is due, from the last successful
// one and the interval.
func (v *StatusView) checkInText(now time.Time) (string, bool) {
	due, ok := v.checkInDue()
	if !ok {
		return "", false
	}
	every := everyInterval(v.checkInInterval())
	if now.After(due) {
		return "overdue by " + humanDuration(now.Sub(due)) + " (" + every + ")", true
	}
	return "next due in " + humanDuration(due.Sub(now)) + " (" + every + ")", true
}

func ago(now, t time.Time) string {
	d := now.Sub(t)
	if d < 0 {
		d = 0
	}
	if d < 5*time.Second {
		return "just now"
	}
	return humanDuration(d) + " ago"
}

// RenderStatus is the human status report.
func RenderStatus(v *StatusView, now time.Time) string {
	var b strings.Builder
	row := func(label, value string) { fmt.Fprintf(&b, "%-10s %s\n", label, value) }
	title := "Vectory agent " + Version
	if v.DeviceID != "" {
		id := v.DeviceID
		if len(id) > 8 {
			id = id[:8]
		}
		title += " · " + v.Settings.Name + " (" + id + ")"
	}
	title += " · " + v.Settings.CapabilityPolicy.ConfigurationMode() + " mode"
	b.WriteString(title + "\n")
	switch {
	case v.DeviceID != "":
		server := v.Settings.Server
		if v.State.LastHeartbeat != nil {
			server += " · last check-in " + ago(now, *v.State.LastHeartbeat)
		} else {
			server += " · no check-in yet"
		}
		if failure := v.checkInFailure(); failure != nil {
			since := failure.Since.Local().Format("2006-01-02 15:04:05 MST")
			switch {
			// The server answers, but refuses this agent's credential: every
			// such refusal is the same 401, and only an expired credential is
			// known here, so anything else is the device's revocation.
			case failure.Code == "CREDENTIAL_REJECTED" && !v.CertExpiry.IsZero() && now.After(v.CertExpiry):
				server += " · the server no longer accepts this agent (its credential expired " + v.CertExpiry.Local().Format("Jan 2 15:04") + ") since " + since
			case failure.Code == "CREDENTIAL_REJECTED":
				server += " · the server no longer accepts this agent (revoked) since " + since
			default:
				server += " · not answering since " + since
			}
		}
		if !v.CertExpiry.IsZero() && v.CertExpiry.Sub(now) < 72*time.Hour {
			server += " · credential expires " + v.CertExpiry.Local().Format("Jan 2 15:04")
		}
		row("Server", server)
	case v.Pending != nil:
		state := map[string]string{"no": "never reached the server", "refused": "refused by the server", "maybe": "not confirmed"}[v.Pending.Delivery]
		row("Server", v.Pending.Server+" · enrolling as "+v.Pending.Name+": "+state)
	default:
		row("Server", "not enrolled")
	}
	switch {
	case v.Service.Running():
		detail := v.Service.Name + " running"
		if v.Service.PID > 0 {
			detail += fmt.Sprintf(" · pid %d", v.Service.PID)
		}
		row("Service", detail)
	case v.Service.Installed:
		state := v.Service.State
		if state == "" || state == "dead" {
			state = "stopped"
		}
		row("Service", v.Service.Name+" "+state)
	case v.Foreground && v.Owner != nil:
		row("Service", fmt.Sprintf("none · vectory %s is running (pid %d), not as a service", v.Owner.Command, v.Owner.PID))
	case v.Foreground:
		row("Service", "none · the agent is running, not as a service")
	default:
		row("Service", "not registered · the agent isn't running")
	}
	vector := v.Settings.VectorBinary
	if v.BinaryOK {
		vector = v.Settings.adoptedVectorVersion() + " at " + vector + " · adopted binary unchanged"
	} else {
		vector += " · changed or missing since adoption"
	}
	row("Vector", vector)
	if v.Delivery != nil {
		row("", v.Delivery.Summary())
	}
	pipeline := v.pipeline()
	if v.LocalPaused {
		pipeline += " · paused on this host"
	} else if v.State.Policy.SyncPaused {
		pipeline += " · paused from the dashboard"
	}
	row("Pipeline", pipeline)
	if running, ok := v.runningVersion(); ok {
		row("Running", running)
	}
	for _, problem := range v.problems() {
		row("Problem", problem.Message)
		if problem.Hint != "" {
			row("", "Fix: "+problem.Hint)
		}
	}
	if text, ok := v.checkInText(now); ok {
		row("Check-in", text)
	}
	if wake, ok := v.wakeUps(); ok {
		row("Wake-ups", wake.text())
	}
	row("Next", v.Next)
	return b.String()
}

// maxProblemRows bounds the diagnostics printed by status and doctor.
const maxProblemRows = 3

// problems are the diagnostics of the last failed apply, errors first.
func (v *StatusView) problems() []Diagnostic {
	if v.State.Error == nil {
		return nil
	}
	return problemRows(v.State.Error.Diagnostics)
}

func problemRows(diagnostics []Diagnostic) []Diagnostic {
	var out []Diagnostic
	for _, severity := range []string{"error", "warning"} {
		for _, d := range diagnostics {
			if d.Severity == severity && len(out) < maxProblemRows {
				out = append(out, d)
			}
		}
	}
	return out
}

// StatusJSON keeps the established machine-readable fields and adds the view.
func StatusJSON(v *StatusView) map[string]any {
	out := map[string]any{
		"state":               v.State,
		"actual_sha256":       v.ActualSHA,
		"local_paused":        v.LocalPaused,
		"drift":               v.Drift,
		"telemetry_available": v.State.Telemetry != nil,
		"version":             Version,
		"configuration_mode":  v.Settings.CapabilityPolicy.ConfigurationMode(),
		"diagnostics":         localDiagnostics(v.StateDir, v.Settings, v.State),
		"state_dir":           v.StateDir,
		"server":              v.Settings.Server,
		"service":             v.Service,
		"agent_running":       v.running(),
		"vector_binary":       v.Settings.VectorBinary,
		"vector_binary_ok":    v.BinaryOK,
		"next_step":           v.Next,
	}
	if v.DeviceID != "" {
		device := map[string]any{"id": v.DeviceID, "name": v.Settings.Name}
		if !v.CertExpiry.IsZero() {
			device["credential_expires_at"] = v.CertExpiry.UTC()
		}
		out["device"] = device
	}
	if v.Pending != nil {
		out["enrollment"] = v.Pending
	}
	if v.Delivery != nil {
		out["delivery"] = v.Delivery
	}
	// Additive keys, each present only when the agent has something true to say.
	if name, number, ok := v.State.Applied.pipeline(); ok {
		out["running_pipeline"] = map[string]any{"name": name, "version_number": number, "version_id": v.State.Applied.VersionID, "generation": v.State.Applied.Generation}
	}
	if due, ok := v.checkInDue(); ok {
		now := v.ReadAt
		if now.IsZero() {
			now = time.Now()
		}
		checkIn := map[string]any{"interval_seconds": int(v.checkInInterval() / time.Second), "last_at": v.State.LastHeartbeat.UTC(), "next_due_at": due.UTC()}
		if now.After(due) {
			checkIn["overdue_by_seconds"] = int(now.Sub(due) / time.Second)
		} else {
			checkIn["due_in_seconds"] = int(due.Sub(now) / time.Second)
		}
		out["check_in"] = checkIn
	}
	if wake, ok := v.wakeUps(); ok {
		wakeUps := map[string]any{"listening": wake.Listening}
		if wake.Reason != "" {
			wakeUps["reason"] = wake.Reason
		}
		out["wake_ups"] = wakeUps
	}
	return out
}
