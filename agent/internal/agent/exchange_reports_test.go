package agent

import (
	"context"
	"encoding/base64"
	"net/http"
	"slices"
	"testing"
	"time"
)

// A report is optional: no report may take a device off the control plane. A
// server that refuses a heartbeat as invalid (400) is sent it again with fewer
// of them, until it answers or nothing optional is left.

// fullHeartbeat carries every report a heartbeat can: the result of a check, the
// announcements, the log summary and the diagnostics of an apply error, and the
// reports about the host.
func fullHeartbeat() Heartbeat {
	var raw [32]byte
	diagnostics := []Diagnostic{{Severity: "error", Code: "VRL_E100", ComponentKind: "transform", ComponentID: "synthetic", Message: "Mapping failed."}}
	summaries := []LogSummary{{Fingerprint: "0123456789abcdef", Level: "error", ComponentID: "synthetic", Message: "Mapping failed with event.", Count: 3, FirstSeen: time.Now().UTC(), LastSeen: time.Now().UTC()}}
	names := []string{"API_TOKEN"}
	return Heartbeat{
		ProtocolVersion: 1, RequestID: RandomID(), Nonce: base64.StdEncoding.EncodeToString(raw[:]), BootID: "boot", AgentVersion: Version, VectorVersion: VectorVersion,
		ConfigurationMode: "restricted", ReportedGeneration: 2, PolicyGeneration: 3, ApplyState: "failed",
		Error:                &Issue{Code: "VALIDATION_FAILED", Stage: "validation", Message: "x", Diagnostics: diagnostics},
		ConfigurationAttempt: &ConfigurationAttempt{Generation: 2, VersionID: "v1", SHA256: "s", State: "failed", Error: &Issue{Code: "VALIDATION_FAILED", Stage: "validation", Message: "x", Diagnostics: diagnostics}},
		Telemetry:            &Telemetry{SampledAt: time.Now().UTC()},
		HostRuntime:          &HostRuntime{DataDir: "/var/lib/vector", DataDirSource: dataDirHost},
		VectorLogSummary:     &summaries, SecretNames: &names, StateDir: "/var/lib/vectory",
		AgentFeatures: []string{featureValidation}, Readiness: &Readiness{},
		ValidationResult: &ValidationResult{ID: checkID, Valid: true, Diagnostics: []Diagnostic{}, Tests: []ValidationTest{}, SecretsMissing: []string{}},
	}
}

// refuseWhen has the plane answer 400 to every heartbeat that holds what the
// test names.
func refuseWhen(d *checkDevice, refused func(beat map[string]any) bool) {
	d.plane.mu.Lock()
	defer d.plane.mu.Unlock()
	d.plane.answer = func(beat map[string]any) int {
		if refused(beat) {
			return http.StatusBadRequest
		}
		return 0
	}
}

// carries lists which reports a heartbeat holds, by the names the log uses.
func carries(beat map[string]any) []string {
	var held []string
	has := func(name string, present bool) {
		if present {
			held = append(held, name)
		}
	}
	errorOf := func(v any) map[string]any {
		m, _ := v.(map[string]any)
		inner, _ := m["error"].(map[string]any)
		return inner
	}
	_, summary := beat["vector_log_summary"]
	has(reportLogSummary, summary)
	has(reportDiagnostics, errorOf(beat)["diagnostics"] != nil || errorOf(beat["configuration_attempt"])["diagnostics"] != nil)
	has(reportHostRuntime, beat["host_runtime"] != nil)
	has(reportStateDir, beat["state_dir"] != nil)
	has(reportSecretNames, beat["secret_names"] != nil)
	has(reportMetrics, beat["telemetry"] != nil)
	has(reportAnnouncements, beat["agent_features"] != nil || beat["readiness"] != nil)
	has(reportCheckResult, beat["validation_result"] != nil)
	return held
}

func exchanged(t *testing.T, d *checkDevice, h Heartbeat) ([][]string, []byte, error) {
	t.Helper()
	before := len(d.plane.sent())
	b, nonce, err := d.e.exchange(context.Background(), h)
	var sent [][]string
	beats := d.plane.sent()[before:]
	for _, beat := range beats {
		sent = append(sent, carries(beat))
	}
	if err == nil && len(beats) > 0 && nonce != beats[len(beats)-1]["nonce"] {
		t.Fatalf("the answer is for nonce %s, the last request carried %v", nonce, beats[len(beats)-1]["nonce"])
	}
	return sent, b, err
}

func TestARefusedLogSummaryIsLeftOutWithTheDiagnosticsAndNothingElse(t *testing.T) {
	d := newCheckDevice(t)
	refuseWhen(d, func(beat map[string]any) bool { _, held := beat["vector_log_summary"]; return held })
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	h := fullHeartbeat()
	// The result of a check is dropped first, as it always was.
	sent, b, err := exchanged(t, d, h)
	if err != nil || len(b) == 0 {
		t.Fatalf("the check-in did not go through: %v", err)
	}
	if len(sent) != 3 {
		t.Fatalf("%d requests: %v", len(sent), sent)
	}
	for i, want := range [][]string{
		{reportLogSummary, reportDiagnostics, reportHostRuntime, reportStateDir, reportSecretNames, reportMetrics, reportAnnouncements, reportCheckResult},
		{reportLogSummary, reportDiagnostics, reportHostRuntime, reportStateDir, reportSecretNames, reportMetrics, reportAnnouncements},
		{reportHostRuntime, reportStateDir, reportSecretNames, reportMetrics, reportAnnouncements},
	} {
		if !slices.Equal(sent[i], want) {
			t.Fatalf("request %d carried %v, want %v", i+1, sent[i], want)
		}
	}
	// What the check-in that went through lacks, the log says once for each kind,
	// in fixed words.
	if !slices.Equal(said, []string{
		"The server refused a check-in; the agent sent it again without the Check on devices result.",
		"The server refused a check-in; the agent sent it again without the Vector log summary.",
		"The server refused a check-in; the agent sent it again without the diagnostics.",
	}) {
		t.Fatalf("the log said %q", said)
	}
	// The next check-in is two requests: the whole one, then without the summary.
	d.plane.mu.Lock()
	d.plane.beats = nil
	d.plane.mu.Unlock()
	h = fullHeartbeat()
	h.ValidationResult = nil
	sent, _, err = exchanged(t, d, h)
	if err != nil || len(sent) != 2 || slices.Contains(sent[1], reportLogSummary) || !slices.Contains(sent[1], reportHostRuntime) {
		t.Fatalf("%v %v", sent, err)
	}
	if len(said) != 3 {
		t.Fatalf("the same kinds were said again: %q", said)
	}
}

func TestARefusedDiagnosticIsLeftOutAndTheLogSummaryGoes(t *testing.T) {
	d := newCheckDevice(t)
	refuseWhen(d, func(beat map[string]any) bool { return slices.Contains(carries(beat), reportDiagnostics) })
	h := fullHeartbeat()
	h.ValidationResult = nil
	sent, _, err := exchanged(t, d, h)
	if err != nil || len(sent) != 2 {
		t.Fatalf("%v %v", sent, err)
	}
	if slices.Contains(sent[1], reportDiagnostics) || slices.Contains(sent[1], reportLogSummary) || !slices.Contains(sent[1], reportAnnouncements) {
		t.Fatalf("the retry carried %v", sent[1])
	}
	// The apply error itself still reports what failed: only its diagnostics are gone.
	last := d.plane.last()
	if last["error"] == nil || last["configuration_attempt"] == nil {
		t.Fatalf("the retry lost the error: %v", last)
	}
}

func TestAHostReportIsLeftOutAfterTheLogReportsAndBeforeTheAnnouncements(t *testing.T) {
	d := newCheckDevice(t)
	refuseWhen(d, func(beat map[string]any) bool { return beat["host_runtime"] != nil })
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	h := fullHeartbeat()
	h.ValidationResult = nil
	sent, _, err := exchanged(t, d, h)
	if err != nil || len(sent) != 3 {
		t.Fatalf("%v %v", sent, err)
	}
	if !slices.Equal(sent[2], []string{reportAnnouncements}) {
		t.Fatalf("the last request carried %v", sent[2])
	}
	// The check-in that went through lacks the log reports too, though only a
	// host report was refused: the agent can't tell which of a step's reports
	// the server refused, so the log names everything that is missing.
	if len(said) != 6 {
		t.Fatalf("the log said %q", said)
	}
	for _, kind := range []string{reportLogSummary, reportDiagnostics, reportHostRuntime, reportStateDir, reportSecretNames, reportMetrics} {
		want := "The server refused a check-in; the agent sent it again without the " + kind + "."
		if !slices.Contains(said, want) {
			t.Errorf("the log never said %q: %q", want, said)
		}
	}
	if d.e.validation.optionalRefused {
		t.Fatal("the announcements were blamed for a refusal they didn't cause")
	}
}

func TestARefusalNoOptionalReportExplainsIsAnOrdinaryFailure(t *testing.T) {
	d := newCheckDevice(t)
	refuseWhen(d, func(map[string]any) bool { return true })
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	_, _, err := exchanged(t, d, fullHeartbeat())
	if err == nil {
		t.Fatal("a heartbeat the server always refuses went through")
	}
	if ce, ok := AsConnectionError(err); !ok || ce.Status != http.StatusBadRequest {
		t.Fatalf("%v", err)
	}
	if d.e.validation.optionalRefused || len(said) != 0 {
		t.Fatalf("a refusal that nothing optional explains left a mark: %v %q", d.e.validation.optionalRefused, said)
	}
}

func TestEachRetryHasItsOwnNonceAndRequestID(t *testing.T) {
	d := newCheckDevice(t)
	refuseWhen(d, func(beat map[string]any) bool { return slices.Contains(carries(beat), reportLogSummary) })
	if _, _, err := exchanged(t, d, fullHeartbeat()); err != nil {
		t.Fatal(err)
	}
	seenNonce, seenID := map[any]bool{}, map[any]bool{}
	for _, beat := range d.plane.sent() {
		if seenNonce[beat["nonce"]] || seenID[beat["request_id"]] {
			t.Fatalf("a retry reused a nonce or a request id: %v", beat)
		}
		seenNonce[beat["nonce"]], seenID[beat["request_id"]] = true, true
	}
}

// A device whose check-in carries a log summary the server refuses still
// checks in: the manifest arrives, and what it says is done.
func TestACheckInWithARefusedLogSummaryStillGetsItsManifest(t *testing.T) {
	d := newCheckDevice(t)
	features := []string{featureValidation, featureLogSummary, featureHostRuntime, featureStateDir, featureDiagnostics}
	d.plane.with(func(m *Manifest) { m.Features = features })
	d.e.State.ServerFeatures = features
	d.e.Log = newVectorLog("")
	line := `{"timestamp":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","level":"ERROR","message":"Mapping failed with event.","target":"vector::internal_events::remap","span":{"component_id":"synthetic","component_kind":"transform","component_type":"remap"}}` + "\n"
	if _, err := d.e.Log.Write([]byte(line)); err != nil {
		t.Fatal(err)
	}
	var said []string
	d.e.Notice = func(line string) { said = append(said, line) }
	refuseWhen(d, func(beat map[string]any) bool { _, held := beat["vector_log_summary"]; return held })
	d.poll()
	beats := d.plane.sent()
	if len(beats) != 2 {
		t.Fatalf("%d heartbeats", len(beats))
	}
	if items, _ := beats[0]["vector_log_summary"].([]any); len(items) != 1 {
		t.Fatalf("the first check-in did not carry the summary: %v", beats[0])
	}
	if _, held := beats[1]["vector_log_summary"]; held || beats[1]["state_dir"] == nil || beats[1]["host_runtime"] == nil {
		t.Fatalf("the retry carried %v", carries(beats[1]))
	}
	if d.e.State.CheckInFailure != nil || d.e.State.LastHeartbeat == nil || !d.e.State.Accepted {
		t.Fatalf("the manifest did not arrive: %+v", d.e.State)
	}
	if len(said) != 1 || said[0] != "The server refused a check-in; the agent sent it again without the Vector log summary." {
		t.Fatalf("the log said %q", said)
	}
}
