package agent

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// boundsFixture is vector-catalog/fixtures/report-bounds.json: the bounds the
// server puts on the diagnostics and the log groups of a heartbeat, and records
// with the size the server measures for each. The server's tests
// (configuration_attempt.rs and device.rs) read the same file, so a bound
// changed on one side shows up on the other: the server refuses a whole
// heartbeat for one diagnostic past a bound.
type boundsFixture struct {
	Bounds struct {
		Diagnostics            int `json:"diagnostics"`
		CheckDiagnostics       int `json:"check_diagnostics"`
		DiagnosticBytes        int `json:"diagnostic_bytes"`
		DiagnosticMessageChars int `json:"diagnostic_message_chars"`
		DiagnosticHintChars    int `json:"diagnostic_hint_chars"`
		DiagnosticFieldChars   int `json:"diagnostic_field_chars"`
		LogGroups              int `json:"log_groups"`
		LogMessageChars        int `json:"log_message_chars"`
		AttemptMessageChars    int `json:"attempt_message_chars"`
	} `json:"bounds"`
	Records []struct {
		Name     string          `json:"name"`
		Record   json.RawMessage `json:"record"`
		Bytes    int             `json:"bytes"`
		Accepted bool            `json:"accepted"`
	} `json:"records"`
}

func readBoundsFixture(t *testing.T) boundsFixture {
	t.Helper()
	var fixture boundsFixture
	if err := json.Unmarshal(repoFile(t, "vector-catalog/fixtures/report-bounds.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Records) < 12 {
		t.Fatalf("the fixture holds %d records", len(fixture.Records))
	}
	return fixture
}

func TestTheReportBoundsAreTheSharedFixtures(t *testing.T) {
	b := readBoundsFixture(t).Bounds
	for name, pair := range map[string][2]int{
		"diagnostics":              {maxDiagnostics, b.Diagnostics},
		"check_diagnostics":        {maxValidationDiagnostics, b.CheckDiagnostics},
		"diagnostic_bytes":         {maxDiagnosticBytes, b.DiagnosticBytes},
		"diagnostic_message_chars": {maxDiagnosticMessage, b.DiagnosticMessageChars},
		"diagnostic_hint_chars":    {maxDiagnosticHint, b.DiagnosticHintChars},
		"diagnostic_field_chars":   {maxDiagnosticField, b.DiagnosticFieldChars},
		"log_groups":               {logSummaryMax, b.LogGroups},
		"log_message_chars":        {maxDiagnosticMessage, b.LogMessageChars},
		"attempt_message_chars":    {maxIssueMessage, b.AttemptMessageChars},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s: the agent keeps to %d, the fixture says the server accepts %d", name, pair[0], pair[1])
		}
	}
}

func fixtureDiagnostic(t *testing.T, raw json.RawMessage) Diagnostic {
	t.Helper()
	var d Diagnostic
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&d); err != nil {
		t.Fatal(err)
	}
	return d
}

// The agent measures a diagnostic as the server does, for records that break the
// default JSON encoding's habits (angle brackets, quotation marks, characters of
// every width), and what it keeps is within the bound.
func TestADiagnosticIsMeasuredAsTheServerMeasuresIt(t *testing.T) {
	for _, entry := range readBoundsFixture(t).Records {
		d := fixtureDiagnostic(t, entry.Record)
		if got := diagnosticBytes(d); got != entry.Bytes {
			t.Errorf("%s: %d bytes, the server measures %d", entry.Name, got, entry.Bytes)
		}
		fitted, ok := fitDiagnostic(d)
		if !ok || diagnosticBytes(fitted) > maxDiagnosticBytes {
			t.Errorf("%s: fitDiagnostic gave %d bytes, ok %v", entry.Name, diagnosticBytes(fitted), ok)
		}
		if entry.Accepted && fitted != d {
			t.Errorf("%s: a record the server accepts was changed: %+v", entry.Name, fitted)
		}
		if !entry.Accepted && fitted == d {
			t.Errorf("%s: a record the server refuses was kept as it is", entry.Name)
		}
	}
}

func padded(base Diagnostic, bytes int) Diagnostic {
	d := base
	for diagnosticBytes(d) < bytes {
		d.Hint += "h"
	}
	return d
}

// A record of 511 and of 512 bytes goes as it is, and one of 513 is made to fit:
// the text goes first, and the message is shortened only when nothing else of
// the text is left.
func TestTheBoundIsExactAtTheEdge(t *testing.T) {
	base := Diagnostic{Severity: "error", Code: "VALIDATION_ERROR", ComponentKind: "sink", ComponentID: "web", Field: "uri", Message: strings.Repeat("word ", 59) + "end", Hint: "h"}
	for _, size := range []int{511, 512} {
		d := padded(base, size)
		if diagnosticBytes(d) != size {
			t.Fatalf("built %d bytes, wanted %d", diagnosticBytes(d), size)
		}
		if fitted, ok := fitDiagnostic(d); !ok || fitted != d {
			t.Errorf("%d bytes: changed to %+v", size, fitted)
		}
	}
	over := padded(base, 513)
	fitted, ok := fitDiagnostic(over)
	if !ok || diagnosticBytes(fitted) > maxDiagnosticBytes {
		t.Fatalf("513 bytes: %d bytes, ok %v", diagnosticBytes(fitted), ok)
	}
	if fitted.Hint != "" || fitted.Message != over.Message || fitted.Field != "uri" || fitted.ComponentID != "web" {
		t.Errorf("513 bytes: the hint should go and nothing else: %+v", fitted)
	}

	// With no hint to give up, the message is cut to the last character that fits.
	long := Diagnostic{Severity: "error", Code: "VALIDATION_ERROR", ComponentKind: "sink", ComponentID: strings.Repeat("c", 100), RouteOutput: strings.Repeat("r", 100), Message: strings.Repeat("word ", 59) + "end"}
	for diagnosticBytes(long) <= maxDiagnosticBytes {
		long.Message += " more words"
	}
	fitted, ok = fitDiagnostic(long)
	if !ok || diagnosticBytes(fitted) < maxDiagnosticBytes-1 || diagnosticBytes(fitted) > maxDiagnosticBytes {
		t.Fatalf("a long message was cut to %d bytes, ok %v", diagnosticBytes(fitted), ok)
	}
	if !strings.HasSuffix(fitted.Message, "…") || !strings.HasPrefix(long.Message, strings.TrimSuffix(fitted.Message, "…")) {
		t.Errorf("the message is not a start of the original: %q", fitted.Message)
	}
	if fitted.ComponentID != long.ComponentID || fitted.RouteOutput != long.RouteOutput {
		t.Errorf("the IDs went before the text: %+v", fitted)
	}
}

// 100-byte IDs and sixty four-byte characters: each within its own bound and
// together over the record's, so the text is cut and the record is kept.
func TestWhatFinalizeReturnsIsWithinTheBoundWhateverItWasGiven(t *testing.T) {
	id, route := strings.Repeat("c", 100), strings.Repeat("r", 100)
	r := newRedactor()
	r.safe[id], r.safe[route] = true, true
	for name, message := range map[string]string{
		"sixty four-byte characters": strings.Repeat("\U0001F4DC", 60),
		"three hundred words":        strings.Repeat("word ", 300),
		"wide characters":            strings.Repeat("日", 300),
		"quotation marks":            strings.Repeat(`"x" `, 100),
	} {
		d := r.finalize(Diagnostic{Code: "VRL_E100", ComponentKind: "transform", ComponentID: id, RouteOutput: route, Field: strings.Repeat("f", 128), Message: message, Hint: strings.Repeat("hint ", 40)})
		if err := serverAcceptsDiagnostic(d); err != nil {
			t.Errorf("%s: %v: %+v", name, err, d)
		}
		if d.ComponentID != id || d.RouteOutput != route {
			t.Errorf("%s: the place was lost before the text was cut: %q %q", name, d.ComponentID, d.RouteOutput)
		}
		if d.Message == "" || utf8.RuneCountInString(d.Message) < 2 {
			t.Errorf("%s: nothing is left of the message: %q", name, d.Message)
		}
	}
}

func TestADiagnosticThatCannotFitIsLeftOutOfTheHeartbeat(t *testing.T) {
	// Only a code the server would refuse for its length can't be made to fit.
	tooLong := Diagnostic{Severity: "error", Code: strings.Repeat("X", 600), Message: "m"}
	if _, ok := fitDiagnostic(tooLong); ok {
		t.Fatal("a record with a 600-byte code fits")
	}
	issue := &Issue{Code: "VALIDATION_FAILED", Stage: "validation", Message: "x", Diagnostics: []Diagnostic{
		{Severity: "error", Code: "A", Message: "first"}, tooLong, {Severity: "error", Code: "B", Message: "second"},
	}}
	kept := cloneIssue(issue).Diagnostics
	if len(kept) != 2 || kept[0].Code != "A" || kept[1].Code != "B" {
		t.Fatalf("%+v", kept)
	}
	if len(issue.Diagnostics) != 3 {
		t.Fatal("cloneIssue changed the original")
	}
}

func TestAHeartbeatCarriesAtMostTheDiagnosticsTheServerAccepts(t *testing.T) {
	var many []Diagnostic
	for i := 0; i < maxDiagnostics+5; i++ {
		many = append(many, Diagnostic{Severity: "error", Code: "E", Message: "m"})
	}
	if got := len(cloneIssue(&Issue{Diagnostics: many}).Diagnostics); got != maxDiagnostics {
		t.Fatalf("%d diagnostics", got)
	}
	if cloneIssue(&Issue{Diagnostics: []Diagnostic{}}).Diagnostics != nil {
		t.Fatal("an empty list should stay empty")
	}
}

// What an earlier build kept in its state is judged again before it is sent.
func TestADiagnosticFromTheStateIsJudgedAgainBeforeItIsSent(t *testing.T) {
	stale := Diagnostic{Severity: "error", Code: "VRL_E100", ComponentKind: "transform", ComponentID: "a/b", RouteOutput: "ok", Field: "source",
		Message: strings.Repeat("m", 400), Hint: strings.Repeat("h", 300)}
	kept := cloneIssue(&Issue{Diagnostics: []Diagnostic{stale}}).Diagnostics[0]
	if err := serverAcceptsDiagnostic(kept); err != nil {
		t.Fatalf("%v: %+v", err, kept)
	}
	if kept.ComponentID != "" || kept.RouteOutput != "" {
		t.Errorf("an ID the server's rule refuses was kept: %q %q", kept.ComponentID, kept.RouteOutput)
	}
	good := cloneIssue(&Issue{Diagnostics: []Diagnostic{{Severity: "error", Code: "VRL_E100", ComponentID: "café", RouteOutput: "日志", Message: "m"}}}).Diagnostics[0]
	if good.ComponentID != "café" || good.RouteOutput != "日志" {
		t.Errorf("a reportable ID was dropped: %+v", good)
	}
}

func TestAnAttemptMessageIsWithinTheServersBound(t *testing.T) {
	long := strings.Repeat("é", maxIssueMessage+50)
	got := cloneIssue(&Issue{Message: long}).Message
	if n := utf8.RuneCountInString(got); n != maxIssueMessage || !strings.HasSuffix(got, "…") {
		t.Fatalf("%d characters: %q", n, got[len(got)-8:])
	}
	if got := cloneIssue(&Issue{Message: "a\x00b"}).Message; got != "ab" {
		t.Fatalf("%q", got)
	}
	exact := strings.Repeat("é", maxIssueMessage)
	if cloneIssue(&Issue{Message: exact}).Message != exact {
		t.Fatal("a message at the bound was changed")
	}
}

func TestADirectoryThatTheServerWouldRefuseIsNotReported(t *testing.T) {
	for dir, want := range map[string]bool{
		"/var/lib/vectory-agent":          true,
		"/var/lib/vectory agent/état":     true,
		"/srv/日本語/vectory":                true,
		`C:\Program Files\Vectory Agent`:  true,
		`D:/Données Müller/Vectory Agent`: true,
		"/srv/a\u200cb\u200dc":            true,
		"relative/dir":                    false,
		`\\server\share\vectory`:          false,
		"":                                false,
		"/srv/a\u202eb":                   false,
		"/srv/a\u2028b":                   false,
		"/srv/a\u2066b":                   false,
		"/srv/a\ufeffb":                   false,
		"/srv/a\x1bb":                     false,
		"/srv/a\nb":                       false,
		"/" + strings.Repeat("d", 4096):   false,
		"/" + strings.Repeat("d", 4095):   true,
	} {
		if got := reportableStateDir(dir); got != want {
			t.Errorf("reportableStateDir(%q) = %v", dir, got)
		}
	}
	host := reportableHostRuntime(HostRuntime{DataDir: "/srv/a\u202eb", DataDirSource: dataDirHost, MetricsSource: metricsExplicit, MetricsAddress: "my-host:9598", Activation: "reload", GracefulShutdownSeconds: 60})
	if host.DataDir != "" || host.DataDirSource != "" || host.MetricsAddress != "" || host.MetricsSource != metricsExplicit || host.Activation != "reload" || host.GracefulShutdownSeconds != 60 {
		t.Errorf("%+v", host)
	}
	kept := reportableHostRuntime(HostRuntime{DataDir: "/var/lib/vector", DataDirSource: dataDirHost, MetricsAddress: "[::1]:9598"})
	if kept.DataDir != "/var/lib/vector" || kept.MetricsAddress != "[::1]:9598" {
		t.Errorf("%+v", kept)
	}
	if got := reportableHostRuntime(HostRuntime{MetricsAddress: "127.0.0.1:9598"}).MetricsAddress; got != "127.0.0.1:9598" {
		t.Errorf("%q", got)
	}
}
