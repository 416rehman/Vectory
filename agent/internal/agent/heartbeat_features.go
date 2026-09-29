package agent

import "slices"

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
)

func (e *Engine) serverSupports(feature string) bool {
	return slices.Contains(e.State.ServerFeatures, feature)
}

// addHeartbeatFeatures adds host runtime, Vector log summaries, rich
// telemetry, diagnostics and bound secret names where the server accepts
// them. It never mutates persisted state: the heartbeat holds clones.
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
		h.HostRuntime = &host
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
