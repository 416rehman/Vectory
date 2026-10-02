package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// unsafeRune is the test's own statement of what no report or terminal line may
// carry: a control character, a line or paragraph separator, or a
// text-direction embedding, override or isolate.
func unsafeRune(r rune) bool {
	return unicode.IsControl(r) || r == '\u2028' || r == '\u2029' ||
		(r >= '\u202a' && r <= '\u202e') || (r >= '\u2066' && r <= '\u2069')
}

// hostileTexts are what an event or a Vector error can put into a log line. want
// is what the report keeps in place of in.
var hostileTexts = []struct{ name, in, want string }{
	{"NUL", "a\x00b", "a b"},
	{"SOH", "a\x01b", "a b"},
	{"BEL", "a\x07b", "a b"},
	{"a lone ESC", "a\x1bb", "a b"},
	{"DEL", "a\x7fb", "a b"},
	{"a C1 control (U+009B)", "a\u009bb", "a b"},
	{"an invalid byte 0x9B", "a\x9bb", "ab"},
	{"CR", "a\rb", "a b"},
	{"CR LF", "a\r\nb", "a b"},
	{"a tab", "a\tb", "a b"},
	{"a line separator", "a\u2028b", "a b"},
	{"a paragraph separator", "a\u2029b", "a b"},
	{"a right-to-left override", "a\u202eb", "a b"},
	{"a left-to-right isolate", "a\u2066b", "a b"},
	{"a color sequence", "\x1b[31mred\x1b[0m", "red"},
	{"a color sequence with colons", "\x1b[38:2::255:0:0mred\x1b[m", "red"},
	{"an OSC title ended by BEL", "x\x1b]0;PWNED-TITLE\x07y", "xy"},
	{"an OSC link ended by ST", "x\x1b]8;;http://link.example\x1b\\y", "xy"},
	{"nothing but controls", "\x07\x1b\x00", ""},
}

func jsonStrings(t *testing.T, value any) []string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var generic any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		t.Fatal(err)
	}
	var out []string
	var walk func(any)
	walk = func(v any) {
		switch v := v.(type) {
		case string:
			out = append(out, v)
		case []any:
			for _, item := range v {
				walk(item)
			}
		case map[string]any:
			for _, item := range v {
				walk(item)
			}
		}
	}
	walk(generic)
	return out
}

func assertNoUnsafeText(t *testing.T, label string, value any) {
	t.Helper()
	for _, s := range jsonStrings(t, value) {
		for _, r := range s {
			if unsafeRune(r) {
				t.Fatalf("%s carries %U in %q", label, r, s)
			}
		}
	}
}

func collapsed(parts ...string) string {
	return strings.Join(strings.Fields(strings.Join(parts, " ")), " ")
}

// A diagnostic is built from Vector's output, which can echo event values. The
// server stores and shows the text, so nothing in it may be a character the
// server refuses or a terminal acts on.
func TestDiagnosticTextCarriesNoControlOrDirectionCharacter(t *testing.T) {
	r := newRedactor()
	for _, c := range hostileTexts {
		t.Run(c.name, func(t *testing.T) {
			d := r.finalize(Diagnostic{Code: "VALIDATION_ERROR", Message: "Before " + c.in + " after", Hint: "Hint " + c.in + " end", Field: "f " + c.in + " g"})
			assertNoUnsafeText(t, "diagnostic", d)
			if want := collapsed("Before", c.want, "after"); d.Message != want {
				t.Errorf("message = %q, want %q", d.Message, want)
			}
			if want := collapsed("Hint", c.want, "end"); d.Hint != want {
				t.Errorf("hint = %q, want %q", d.Hint, want)
			}
			if want := collapsed("f", c.want, "g"); d.Field != want {
				t.Errorf("field = %q, want %q", d.Field, want)
			}
		})
	}
	t.Run("a message of only controls says so", func(t *testing.T) {
		d := r.finalize(Diagnostic{Code: "VALIDATION_ERROR", Message: "\x07\x1b[31m\x00"})
		if d.Message != "Vector reported an error." {
			t.Fatalf("message = %q", d.Message)
		}
	})
	t.Run("a field of only controls is left out", func(t *testing.T) {
		d := r.finalize(Diagnostic{Code: "VALIDATION_ERROR", Message: "x", Field: "\x07\u202e"})
		if d.Field != "" {
			t.Fatalf("field = %q", d.Field)
		}
	})
}

// A failure an earlier build recorded can hold diagnostics from before control
// characters were replaced. The heartbeat is built from the state, so the copy it
// reports is cleaned again; the failure itself stays as it was recorded.
func TestAnOlderStateIsReportedWithoutControlCharacters(t *testing.T) {
	old := &Issue{Code: "VALIDATION_FAILED", Stage: "validation", Message: "Vector rejected the configuration", Diagnostics: []Diagnostic{
		{Severity: "error", Code: "VALIDATION_ERROR", Message: "bad\x07 text\u202e", Hint: "try\x1b[2J again", Field: "a\x00b"},
		{Severity: "warning", Code: "OUTPUT_UNUSED", Message: "\x07\x1b"},
		{Severity: "warning", Code: "OUTPUT_UNUSED", Message: "Nothing reads the output of in.", Hint: "Connect it to a sink."},
	}}
	attempt := &ConfigurationAttempt{Generation: 2, State: "failed", Error: old}
	for name, reported := range map[string]*Issue{"the issue": cloneIssue(old), "the attempt's issue": cloneAttempt(attempt).Error} {
		assertNoUnsafeText(t, name, reported)
		got := reported.Diagnostics
		if len(got) != 3 || got[0].Message != "bad text" || got[0].Hint != "try [2J again" || got[0].Field != "a b" || got[1].Message != "Vector reported an error." {
			t.Fatalf("%s: %+v", name, got)
		}
		if got[2] != old.Diagnostics[2] {
			t.Fatalf("%s: a clean diagnostic changed: %+v", name, got[2])
		}
	}
	if old.Diagnostics[0].Message != "bad\x07 text\u202e" {
		t.Fatalf("the recorded failure was changed: %+v", old.Diagnostics[0])
	}
	if cloneIssue(&Issue{Code: "X"}).Diagnostics != nil {
		t.Fatal("an issue without diagnostics gained some")
	}
}

// A WARN or ERROR line that quotes event data becomes a summary group. The
// message and the error text both come from the line.
func TestLogSummaryTextCarriesNoControlOrDirectionCharacter(t *testing.T) {
	r := testRedactor(`{"sources":{"in":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}`)
	for _, c := range hostileTexts {
		t.Run(c.name, func(t *testing.T) {
			l := newVectorLog("")
			l.summarize(vectorRecord{Level: "ERROR", Message: "Before " + c.in + " after", Error: "cause " + c.in + " end", ComponentID: "out", ComponentKind: "sink", ComponentType: "blackhole"})
			got := l.summaries(r)
			if len(got) != 1 {
				t.Fatalf("summaries = %+v", got)
			}
			assertNoUnsafeText(t, "summary", got[0])
			if want := collapsed("Before", c.want, "after", "cause", c.want, "end"); got[0].Message != want {
				t.Errorf("message = %q, want %q", got[0].Message, want)
			}
		})
	}
	t.Run("a line of only controls says so", func(t *testing.T) {
		l := newVectorLog("")
		l.summarize(vectorRecord{Level: "ERROR", Message: "\x07\x1b[31m", ComponentID: "out"})
		got := l.summaries(r)
		if len(got) != 1 || got[0].Message != "Vector logged a message with no printable text." {
			t.Fatalf("summaries = %+v", got)
		}
	})
	t.Run("a secret holding a control character is still redacted", func(t *testing.T) {
		r := newRedactor()
		r.addSecret("pass\tphrase-1234")
		l := newVectorLog("")
		l.summarize(vectorRecord{Level: "ERROR", Message: "rejected pass\tphrase-1234 by the server", ComponentID: "out"})
		got := l.summaries(r)
		if len(got) != 1 || strings.Contains(got[0].Message, "phrase") || !strings.Contains(got[0].Message, redactedToken) {
			t.Fatalf("summaries = %+v", got)
		}
	})
	t.Run("a path split by a control character is still redacted", func(t *testing.T) {
		l := newVectorLog("")
		l.summarize(vectorRecord{Level: "ERROR", Message: "cannot read\x07/etc/shadow-backup now", ComponentID: "out"})
		got := l.summaries(newRedactor())
		if len(got) != 1 || strings.Contains(got[0].Message, "/etc/shadow-backup") {
			t.Fatalf("summaries = %+v", got)
		}
	})
}

// writeLog puts lines into a state directory's vector.log exactly as given.
func writeLog(t *testing.T, lines ...string) (dir string, file []byte) {
	t.Helper()
	dir = t.TempDir()
	file = []byte(strings.Join(lines, "\n") + "\n")
	if err := os.WriteFile(filepath.Join(dir, vectorLogName), file, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, file
}

func jsonRecord(t *testing.T, level, message string) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"timestamp": "2026-10-02T21:30:00.123456Z", "level": level, "message": message, "target": "vrl::stdlib::log::implementation", "span": map[string]any{"component_id": "echo_event", "component_kind": "transform"}})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// assertOneLinePerRecord checks that out has exactly want lines and that no
// byte of it is one a terminal acts on: only the record newlines are control
// bytes, and no character is DEL, a C1 control, a line or paragraph separator
// or a text-direction control.
func assertOneLinePerRecord(t *testing.T, label, out string, want int) {
	t.Helper()
	if !utf8.ValidString(out) {
		t.Fatalf("%s is not valid UTF-8: %q", label, out)
	}
	for i, r := range out {
		if r == '\n' {
			continue
		}
		if unsafeRune(r) {
			t.Fatalf("%s holds %U at byte %d: %q", label, r, i, out)
		}
	}
	if got := strings.Count(out, "\n"); got != want || !strings.HasSuffix(out, "\n") {
		t.Fatalf("%s has %d lines, want %d records:\n%q", label, got, want, out)
	}
}

// `vectory logs` shows the log to a person at a terminal. A pipeline that logs
// event fields (VRL log()) puts event bytes in it.
func TestLogsNeverWriteATerminalControlOrForgeALine(t *testing.T) {
	forgedLine := "2026-10-02 21:30:00Z  INFO   Vector has reloaded."
	lines := []string{
		jsonRecord(t, "ERROR", "TERM \x1b]0;PWNED-TITLE\x07\x1b[31mRED-INJECTED\x1b[0m \x1b[2J end"),
		jsonRecord(t, "ERROR", "x\r"+forgedLine),
		jsonRecord(t, "ERROR", "first\nsecond\n"+forgedLine),
		jsonRecord(t, "ERROR", "bell\x07 del\x7f c1\u009b nul\x00 ls\u2028 rlo\u202etxt"),
		"panic: \x1b[2Jnot json\x07 with a lone CR\rand more",
		"[vectory 2026-10-02T21:30:00Z] vector validate rejected the configuration",
		"  x \x1b]0;note title\x07 value",
	}
	dir, file := writeLog(t, lines...)

	t.Run("text shows every control as an escape", func(t *testing.T) {
		var out bytes.Buffer
		if err := WriteVectorLog(context.Background(), dir, 100, false, LogText, &out); err != nil {
			t.Fatal(err)
		}
		assertOneLinePerRecord(t, "text", out.String(), len(lines))
		for _, shown := range []string{`\x1b`, `\x07`, `\x0d`, `\x0a`, `\x7f`, `\x9b`, `\x00`, `\u2028`, `\u202e`} {
			if !strings.Contains(out.String(), shown) {
				t.Errorf("text output does not show %s:\n%s", shown, out.String())
			}
		}
		for _, text := range strings.Split(out.String(), "\n") {
			if strings.Contains(text, "PWNED") && strings.HasPrefix(text, forgedLine) {
				t.Errorf("an event forged the start of a line: %q", text)
			}
			if i := strings.Index(text, forgedLine); i > 0 && !strings.HasSuffix(text[:i], `\x0a`) && !strings.HasSuffix(text[:i], `\x0d`) {
				t.Errorf("the forged text isn't marked off: %q", text)
			}
		}
	})

	t.Run("json escapes every control character", func(t *testing.T) {
		var out bytes.Buffer
		if err := WriteVectorLog(context.Background(), dir, 100, false, LogJSON, &out); err != nil {
			t.Fatal(err)
		}
		assertOneLinePerRecord(t, "json", out.String(), len(lines))
		for _, escaped := range []string{`\u001b`, `\u0007`, `\r`, `\u007f`, `\u009b`, `\u0000`, `\u2028`, `\u202e`} {
			if !strings.Contains(out.String(), escaped) {
				t.Errorf("json output does not carry %s:\n%s", escaped, out.String())
			}
		}
		// The data itself is unchanged: decoding gives back the event's bytes.
		first := strings.Split(out.String(), "\n")[0]
		var record struct{ Message string }
		if err := json.Unmarshal([]byte(first), &record); err != nil || record.Message != "TERM \x1b]0;PWNED-TITLE\x07\x1b[31mRED-INJECTED\x1b[0m \x1b[2J end" {
			t.Fatalf("decoded %q (%v)", record.Message, err)
		}
		for _, line := range strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n") {
			if !json.Valid([]byte(line)) {
				t.Errorf("not JSON: %q", line)
			}
		}
	})

	t.Run("raw is the file as written", func(t *testing.T) {
		var out bytes.Buffer
		if err := WriteVectorLog(context.Background(), dir, 100, false, LogRaw, &out); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(out.Bytes(), file) {
			t.Fatalf("raw output changed the file:\n got %q\nwant %q", out.Bytes(), file)
		}
	})
}
