package agent

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// Additive heartbeat fields are sent only to servers that list them in the
// signed manifest's features, so a newer agent never trips an older server's
// strict validation. Until the first verified manifest the agent sends the
// original heartbeat shape.
const (
	featureDiagnostics = "diagnostics"
	featureHostRuntime = "host_runtime"
	featureLogSummary  = "vector_log_summary"
	featureTelemetryV2 = "telemetry_v2"
	featureSecretNames = "secret_names"
	// What keeps the agent running, and whether Vector runs: the dashboard
	// says "nothing keeps its agent running" and "Nothing running" from them.
	featureServiceManager = "service_manager"
	featureVectorRunning  = "vector_running"
	// Which agent build runs, and where its state lives: the dashboard says
	// "already runs this build" and writes host commands for this host.
	featureAgentSHA256 = "agent_sha256"
	featureStateDir    = "state_dir"
)

func (e *Engine) serverSupports(feature string) bool {
	return slices.Contains(e.State.ServerFeatures, feature)
}

// addHeartbeatFeatures adds host runtime, Vector log summaries, rich
// telemetry, diagnostics, bound secret names, what a check on request needs
// (validation.go) and the report on agent updates (update_report.go) where the
// server accepts them. It never mutates persisted state: the heartbeat holds
// clones.
func (e *Engine) addHeartbeatFeatures(h *Heartbeat, running []byte, metricsSource, metricsAddress string) {
	if e.serverSupports(featureSecretNames) {
		// Names only, at most 64: never a file path or a value.
		names := boundSecretNames(e.Settings.SecretFiles)
		h.SecretNames = &names
	}
	if !e.serverSupports(featureDiagnostics) {
		if h.Error != nil {
			h.Error.Diagnostics = nil
		}
		if h.ConfigurationAttempt != nil && h.ConfigurationAttempt.Error != nil {
			h.ConfigurationAttempt.Error.Diagnostics = nil
		}
	}
	if !e.serverSupports(featureTelemetryV2) {
		h.Telemetry = legacyTelemetry(h.Telemetry)
	}
	if e.serverSupports(featureHostRuntime) {
		host := e.hostRuntime(running)
		host.MetricsSource, host.MetricsAddress = metricsSource, metricsAddress
		if driver, ok := e.Driver.(*VectorDriver); ok {
			host.Activation = driver.ActivationMethod()
		}
		h.HostRuntime = reportableHostRuntime(host)
	}
	if e.serverSupports(featureLogSummary) && e.Log != nil {
		items := e.Log.summaries(e.redactorFor(running))
		if items == nil {
			items = []LogSummary{}
		}
		h.VectorLogSummary = &items
	}
	if e.serverSupports(featureServiceManager) && e.ServiceManager != "" {
		h.ServiceManager = e.ServiceManager
	}
	if e.serverSupports(featureVectorRunning) && e.Driver != nil {
		alive := e.Driver.Alive()
		h.VectorRunning = &alive
	}
	if e.serverSupports(featureAgentSHA256) && e.State.Agent != nil && e.State.Agent.SHA256 != "" {
		h.AgentSHA256 = e.State.Agent.SHA256
	}
	if e.serverSupports(featureStateDir) && reportableStateDir(e.Dir) {
		h.StateDir = e.Dir
	}
	// What this agent can do and how ready the host is go in every heartbeat
	// while the server lists the feature: a heartbeat without them says "not
	// announced now". A pending result goes with them until the manifest stops
	// carrying its check.
	if e.serverSupports(featureValidation) && !e.validation.optionalRefused {
		h.AgentFeatures = []string{featureValidation}
		h.Readiness = e.readiness(running)
		h.ValidationResult = e.validation.pending
	}
	// What this host consented to for agent updates and where an offer stands, in
	// every heartbeat while the server lists the feature, and never again once a
	// server has refused a heartbeat that carried it (exchange).
	if e.serverSupports(featureAgentUpdate) && !e.update.memberRefused {
		h.AgentUpdate = e.agentUpdateReport()
	}
}

// What the server accepts of the members that name a place on this host: the
// agent's state directory and the host runtime's directory and metrics address
// (state_dir_path, plain and the metrics_address rule in server/src/device.rs).
// The server refuses a whole check-in for one it doesn't accept, so a directory
// it can't show safely, or an address of another shape, is left out of the
// report and everything else still goes.

// reportableStateDir is dir as the server accepts it for state_dir: an absolute
// POSIX path or Windows drive path of at most 4096 bytes, without a character
// refusedInName.
func reportableStateDir(dir string) bool {
	drivePath := len(dir) >= 3 && (dir[0] >= 'A' && dir[0] <= 'Z' || dir[0] >= 'a' && dir[0] <= 'z') &&
		dir[1] == ':' && (dir[2] == '\\' || dir[2] == '/')
	return (strings.HasPrefix(dir, "/") || drivePath) && len(dir) <= 4096 && namesNothingHostile(dir)
}

// namesNothingHostile reports whether text is valid UTF-8 without a character
// refusedInName.
func namesNothingHostile(text string) bool {
	return utf8.ValidString(text) && strings.IndexFunc(text, refusedInName) < 0
}

// metricsAddressPattern is the shape the server accepts for metrics_address: a
// host and port of letters, digits, dots, colons and brackets, up to 64.
var metricsAddressPattern = regexp.MustCompile(`^[A-Za-z0-9.:\[\]]{1,64}$`)

// reportableHostRuntime is host with each member the server wouldn't accept left
// out: a data directory of more than 4096 characters or with a character
// refusedInName, and a metrics address of another shape.
func reportableHostRuntime(host HostRuntime) *HostRuntime {
	if utf8.RuneCountInString(host.DataDir) > 4096 || !namesNothingHostile(host.DataDir) {
		host.DataDir, host.DataDirSource = "", ""
	}
	if host.MetricsAddress != "" && !metricsAddressPattern.MatchString(host.MetricsAddress) {
		host.MetricsAddress = ""
	}
	return &host
}

// legacyTelemetry keeps only the fields every server version accepts.
func legacyTelemetry(t *Telemetry) *Telemetry {
	if t == nil {
		return nil
	}
	out := &Telemetry{SampledAt: t.SampledAt, EventsPerSecond: t.EventsPerSecond, Errors: t.Errors, UptimeSeconds: t.UptimeSeconds, MemoryBytes: t.MemoryBytes, CPUSeconds: t.CPUSeconds, DiscardedEvents: t.DiscardedEvents, BufferBytes: t.BufferBytes}
	for _, c := range t.Components {
		out.Components = append(out.Components, ComponentTelemetry{ID: c.ID, Type: c.Type, EventsPerSecond: c.EventsPerSecond, Errors: c.Errors, DiscardedEvents: c.DiscardedEvents, BufferBytes: c.BufferBytes})
	}
	return out
}
