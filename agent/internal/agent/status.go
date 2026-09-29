package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
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

// StatusView gathers everything status shows, read-only.
type StatusView struct {
	StateDir    string
	Settings    Settings
	State       State
	DeviceID    string
	CertExpiry  time.Time
	Pending     *PendingEnrollment
	Service     ServiceInfo
	Foreground  bool
	LocalPaused bool
	ActualSHA   string
	Drift       bool
	BinaryOK    bool
	// Delivery is a sink that failed requests in the last minute, from the
	// local Vector log; nil when the log shows none.
	Delivery *DeliveryProblem
	Next     string
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
	now := time.Now()
	v.Delivery = recentDeliveryProblem(dir, s.ManagedConfig, now)
	v.Next = v.nextStep(now)
	return v, nil
}

func (v *StatusView) running() bool { return v.Service.Running() || v.Foreground }

func (v *StatusView) heartbeatLimit() time.Duration {
	seconds := v.State.Policy.HeartbeatSeconds
	if seconds < 10 || seconds > 3600 {
		seconds = 60
	}
	return 3 * time.Duration(seconds) * time.Second
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
	dir := quoteArg(v.StateDir)
	switch {
	case v.DeviceID == "" && v.Pending != nil && v.Pending.Delivery == "refused":
		return "The server refused the last enrollment. Ask an administrator for the reason (Add device page), then run setup again; a new token is fine."
	case v.DeviceID == "" && v.Pending != nil && v.Pending.Delivery == "no":
		return "The last enrollment never reached the server. Fix the connection (vectory doctor), then run the command again."
	case v.DeviceID == "" && v.Pending != nil:
		return "Finish enrolling: run the same command again with --name " + v.Pending.Name + " (a new token is fine)."
	case v.DeviceID == "":
		return "Enroll this host: copy the command from Add device in the dashboard."
	case !v.BinaryOK:
		return "The adopted Vector binary changed. Restore it, or stop the agent and approve it with `vectory re-adopt --expected-sha256 SHA256`."
	case v.Service.Installed && !v.Service.Running():
		return "Start the agent: sudo vectory service-start"
	case !v.running():
		return "Start the agent: sudo vectory run --state-dir " + dir + " (or register a service with vectory setup)."
	case v.LocalPaused:
		return "Configuration sync is paused on this host. Resume it with: sudo vectory resume --state-dir " + dir
	case v.State.LastHeartbeat == nil:
		return "Waiting for the first check-in. If it doesn't arrive within a minute, run `sudo vectory doctor`."
	case v.checkInFailure() != nil:
		return v.checkInFailure().Message
	case now.Sub(*v.State.LastHeartbeat) > v.heartbeatLimit():
		return "No check-in for " + humanDuration(now.Sub(*v.State.LastHeartbeat)) + ". Run `sudo vectory doctor` to check the connection."
	case v.State.Error != nil:
		return applyNextAction(v.State)
	case v.Delivery != nil:
		// Applied and verified is not delivering: Vector's own log says a
		// sink fails its requests.
		return v.Delivery.Next()
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
	"reload_requested":     "restarting Vector",
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
		if st.LastGoodSHA256 != "" && v.ActualSHA != "" {
			return "No pipeline assigned · running the adopted local configuration"
		}
		return "No pipeline assigned yet"
	}
	version := st.Desired.VersionID
	if len(version) > 8 {
		version = version[:8]
	}
	text := fmt.Sprintf("Version %s (generation %d) · %s", version, st.HighestGeneration, label)
	if st.Error != nil && (st.ApplyState == "failed" || st.ApplyState == "rolled_back") {
		text += ": " + st.Error.Message
	}
	if v.Drift {
		text += " · local edits detected"
	}
	return text
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
			server += " · not answering since " + failure.Since.Local().Format("2006-01-02 15:04:05 MST")
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
	case v.Foreground:
		row("Service", "none · the agent is running in the foreground")
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
	for _, problem := range v.problems() {
		row("Problem", problem.Message)
		if problem.Hint != "" {
			row("", "Fix: "+problem.Hint)
		}
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
	return out
}
