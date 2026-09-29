package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func logLine(level, message, component, errText string) string {
	return fmt.Sprintf(`{"timestamp":"2026-09-29T02:44:21.163591Z","level":%q,"message":%q,"error":%q,"error_type":"request_failed","stage":"processing","target":"vector::internal_events::http_client","spans":[{"component_id":%q,"component_kind":"sink","component_type":"http","name":"sink"}]}`, level, message, errText, component)
}

func TestVectorLogSignalsCaptureAndBoundedRing(t *testing.T) {
	l := newVectorLog("")
	since := l.beginCapture(true)
	started := `{"timestamp":"t","level":"INFO","message":"Vector has started.","version":"0.58.0","target":"vector"}` + "\n"
	// Lines may arrive split across writes.
	_, _ = l.Write([]byte(started[:20]))
	_, _ = l.Write([]byte(started[20:]))
	_, _ = l.Write([]byte(`{"timestamp":"t","level":"INFO","message":"Vector has reloaded.","target":"vector"}` + "\n" + `{"timestamp":"t","level":"ERROR","message":"Reload was not successful.","reason":"topology_build_failed","target":"vector::internal_events::process"}` + "\n"))
	if l.signals.started != since.started+1 || l.signals.reloaded != 1 || l.signals.reloadFailed != 1 {
		t.Fatalf("signals = %+v", l.signals)
	}
	if records := l.endCapture(); len(records) != 3 || records[2].Reason != "topology_build_failed" {
		t.Fatalf("capture = %+v", records)
	}
	for i := 0; i < vectorLogRingLines+10; i++ {
		fmt.Fprintf(l, "line %d\n", i)
	}
	recent := l.recent()
	if len(recent) != vectorLogRingLines || recent[len(recent)-1] != fmt.Sprintf("line %d", vectorLogRingLines+9) || recent[0] != "line 10" {
		t.Fatalf("ring not bounded in order: first=%q last=%q len=%d", recent[0], recent[len(recent)-1], len(recent))
	}
	_, _ = l.Write(append(bytes.Repeat([]byte("x"), vectorLogMaxLine+100), '\n'))
	if last := l.recent()[vectorLogRingLines-1]; !strings.HasSuffix(last, "…[truncated]") || len(last) > vectorLogMaxLine+32 {
		t.Fatal("oversized line not truncated")
	}
}

func TestVectorLogAwaitReturnsOnSignalExitOrTimeout(t *testing.T) {
	l := newVectorLog("")
	done := make(chan struct{})
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, _ = l.Write([]byte(`{"level":"INFO","message":"Vector has reloaded.","target":"vector"}` + "\n"))
	}()
	if _, reason := l.await(context.Background(), done, time.Second, func(s logSignals) bool { return s.reloaded > 0 }); reason != "" {
		t.Fatalf("await reason %q", reason)
	}
	close(done)
	if _, reason := l.await(context.Background(), done, time.Second, func(s logSignals) bool { return s.started > 0 }); reason != "exited" {
		t.Fatalf("await reason %q, want exited", reason)
	}
	if _, reason := l.await(context.Background(), make(chan struct{}), 10*time.Millisecond, func(logSignals) bool { return false }); reason != "timeout" {
		t.Fatalf("await reason %q, want timeout", reason)
	}
}

func TestVectorLogSummariesGroupRedactAndBound(t *testing.T) {
	l := newVectorLog("")
	now := time.Date(2026, 9, 29, 3, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		fmt.Fprintln(l, logLine("WARN", "HTTP error.", "web", "error trying to connect: tcp connect error: Connection refused (os error 111)"))
	}
	// Vector's rate-limit summary carries no error type or stage; it still
	// counts toward the original group.
	fmt.Fprintln(l, `{"level":"WARN","message":"Internal log [HTTP error.] has been suppressed 5 times.","target":"vector::internal_events::http_client","spans":[{"component_id":"web","component_kind":"sink","component_type":"http"}]}`)
	fmt.Fprintln(l, `{"level":"WARN","message":"Internal log [HTTP error.] is being suppressed to avoid flooding.","spans":[{"component_id":"web","component_kind":"sink","component_type":"http"}]}`)
	fmt.Fprintln(l, logLine("ERROR", "Failed to send.", "web", "token hunter2-resolved-secret rejected by https://10.1.2.3:9200"))
	fmt.Fprintln(l, logLine("INFO", "Healthcheck passed.", "web", ""))
	r := testRedactor(`{"sinks":{"web":{"type":"http","uri":"https://logs.example.com","auth":{"strategy":"bearer","token":"hunter2-resolved-secret"}}}}`)
	got := l.summaries(r)
	if len(got) != 2 {
		t.Fatalf("summaries = %+v", got)
	}
	if got[0].Level != "error" || got[0].ComponentID != "web" || got[0].ComponentKind != "sink" || got[0].ComponentType != "http" {
		t.Fatalf("errors first with component: %+v", got[0])
	}
	if strings.Contains(got[0].Message, "hunter2") || strings.Contains(got[0].Message, "10.1.2.3") || !strings.Contains(got[0].Message, "«redacted»") {
		t.Fatalf("summary not redacted: %q", got[0].Message)
	}
	warn := got[1]
	if warn.Count != 8 || warn.Reason != "connection_refused" || warn.ErrorType != "request_failed" || warn.Stage != "processing" || !warn.FirstSeen.Equal(now) {
		t.Fatalf("grouped warning = %+v", warn)
	}
	// Unknown component IDs are not echoed.
	fmt.Fprintln(l, logLine("ERROR", "Oops.", "not-in-template", ""))
	for _, s := range l.summaries(r) {
		if s.ComponentID == "not-in-template" {
			t.Fatal("unknown component echoed")
		}
	}
	now = now.Add(2 * time.Hour)
	if left := l.summaries(r); len(left) != 0 {
		t.Fatalf("stale summaries kept: %+v", left)
	}
	for i := 0; i < logSummaryTracked+10; i++ {
		fmt.Fprintln(l, logLine("ERROR", fmt.Sprintf("Distinct %d.", i), "web", ""))
	}
	if len(l.entries) > logSummaryTracked || len(l.summaries(r)) != logSummaryMax {
		t.Fatal("summary tracking is not bounded")
	}
}

// A pipeline's VRL log() writes to the same JSON stream as Vector's internal
// log, under the vrl::stdlib::log target. It must never count as Vector's own
// reload verdict.
func TestReloadVerdictCannotBeForgedByPipelineLogs(t *testing.T) {
	l := newVectorLog("")
	for _, forged := range []string{
		// Recorded from Vector 0.58 with remap `log("Vector has reloaded.", rate_limit_secs: 0)`.
		`{"timestamp":"2026-09-29T07:59:29.848569Z","level":"INFO","message":"Vector has reloaded.","internal_log_rate_secs":0,"vrl_position":0,"target":"vrl::stdlib::log::implementation","span":{"component_id":"t","component_kind":"transform","component_type":"remap","name":"transform"}}`,
		`{"level":"ERROR","message":"Reload was not successful.","target":"vrl::stdlib::log::implementation"}`,
		`{"level":"INFO","message":"Vector has reloaded."}`,
		`{"level":"ERROR","message":"Reload was not successful.","target":"vector"}`,
	} {
		_, _ = l.Write([]byte(forged + "\n"))
	}
	if l.signals.reloaded != 0 || l.signals.reloadFailed != 0 {
		t.Fatalf("pipeline log accepted as a reload verdict: %+v", l.signals)
	}
}

// logs --json prints one JSON object per line, like run --json: Vector's own
// records unchanged, and the agent's notes and anything else with the same
// keys, so every line parses.
func TestVectorLogJSONLinesAllParse(t *testing.T) {
	dir := t.TempDir()
	l := newVectorLog(dir)
	l.now = func() time.Time { return time.Date(2026, 9, 29, 15, 4, 5, 0, time.UTC) }
	record := logLine("WARN", "Retrying.", "web", "timed out")
	fmt.Fprintln(l, record)
	l.note("vector validate rejected the configuration", []byte("x data_dir \"/var/lib/vector/\" does not exist\n"))
	_, _ = l.Write(append([]byte(`{"level":"INFO","message":"`+strings.Repeat("x", vectorLogMaxLine)), '\n'))
	l.close()
	var out bytes.Buffer
	if err := WriteVectorLog(context.Background(), dir, 100, false, LogJSON, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	var records []map[string]string
	for _, line := range lines {
		var fields map[string]any
		if err := json.Unmarshal([]byte(line), &fields); err != nil {
			t.Fatalf("not a JSON line: %q", line)
		}
		values := map[string]string{}
		for key, value := range fields {
			values[key], _ = value.(string)
		}
		records = append(records, values)
	}
	note := map[string]string{"timestamp": "2026-09-29T15:04:05Z", "target": "vectory", "message": "vector validate rejected the configuration"}
	output := map[string]string{"timestamp": "2026-09-29T15:04:05Z", "target": "vectory", "message": `x data_dir "/var/lib/vector/" does not exist`}
	if len(lines) != 4 || lines[0] != record || !reflect.DeepEqual(records[1], note) || !reflect.DeepEqual(records[2], output) ||
		!strings.HasSuffix(records[3]["message"], "…[truncated]") || records[3]["target"] != "" {
		t.Fatalf("JSON lines:\n%s", out.String())
	}
}

// A reload whose configuration doesn't even load ends with this record
// instead of "Reload was not successful." (recorded from Vector 0.58); it is a
// failed reload as well, so the agent doesn't wait out its startup timeout.
func TestAConfigurationThatFailsToLoadIsAFailedReload(t *testing.T) {
	l := newVectorLog("")
	_, _ = l.Write([]byte(`{"timestamp":"2026-09-29T16:17:21.131571Z","level":"ERROR","message":"Failed to load config files, reload aborted.","error_code":"config_load","error_type":"configuration_failed","stage":"processing","internal_log_rate_limit":false,"target":"vector::internal_events::process"}` + "\n"))
	_, _ = l.Write([]byte(`{"level":"ERROR","message":"Failed to load config files, reload aborted.","target":"vrl::stdlib::log::implementation"}` + "\n"))
	if l.signals.reloadFailed != 1 || l.signals.reloaded != 0 {
		t.Fatalf("signals = %+v", l.signals)
	}
}

// A reload capture starts while Vector keeps writing: a line in flight must
// survive intact rather than being cut in half.
func TestBeginCaptureKeepsALineInFlight(t *testing.T) {
	l := newVectorLog("")
	line := `{"level":"INFO","message":"Vector has reloaded.","target":"vector"}`
	_, _ = l.Write([]byte(line[:30]))
	since := l.beginCapture(false)
	_, _ = l.Write([]byte(line[30:] + "\n"))
	if l.signals.reloaded != since.reloaded+1 {
		t.Fatal("line split by beginCapture was lost")
	}
	if recent := l.recent(); len(recent) != 1 || recent[0] != line {
		t.Fatalf("ring = %q", recent)
	}
}

// A resolved secret that straddles any internal length bound must still be
// redacted whole: summaries redact first and truncate after.
func TestLogSummaryRedactsASecretAcrossTheLengthBound(t *testing.T) {
	secret := "CorrectHorseBattery9"
	r := newRedactor()
	r.learnConfiguration([]byte(`{"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"http","inputs":["in"],"uri":"https://example.invalid/ingest","encoding":{"codec":"json"},"auth":{"strategy":"basic","user":"svc","password":"`+secret+`"}}}}`), false)
	for _, at := range []int{1000, 1015, 1024, 1030, 4000} {
		message := "Service call failed."
		prefix := strings.Repeat("\n    ", (at-len(message)-1-len("rejected credential: password="))/5)
		l := newVectorLog("")
		l.summarize(vectorRecord{Level: "ERROR", Message: message, Error: prefix + "rejected credential: password=" + secret + " end", ComponentID: "out"})
		for _, s := range l.summaries(r) {
			for n := 4; n <= len(secret); n++ {
				if strings.Contains(s.Message, secret[:n]) {
					t.Fatalf("secret prefix %q (offset %d) reached the summary: %q", secret[:n], at, s.Message)
				}
			}
		}
	}
}

// Vector's "Log level is enabled." record repeats the level key with a
// quoted value; people see the level without quotes.
func TestFormattedLogLevelsAreUnquoted(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "vector", "reload.run.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		formatted := formatLogLine(line, false)
		if strings.Contains(formatted, `"INFO"`) || strings.Contains(formatted, `"ERROR"`) || strings.Contains(formatted, `"WARN"`) {
			t.Fatalf("quoted level: %s", formatted)
		}
	}
}

func TestVectorLogFileRotatesAndCLIReads(t *testing.T) {
	dir := t.TempDir()
	previous := vectorLogMaxBytes
	vectorLogMaxBytes = 4096
	defer func() { vectorLogMaxBytes = previous }()
	l := newVectorLog(dir)
	for i := 0; i < 80; i++ {
		fmt.Fprintln(l, logLine("WARN", fmt.Sprintf("Retrying %d.", i), "web", "timed out"))
	}
	l.note("vector validate rejected the configuration", []byte("x data_dir \"/var/lib/vector/\" does not exist\n"))
	l.close()
	for _, name := range []string{vectorLogName, vectorLogName + ".1"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || info.Size() > vectorLogMaxBytes {
			t.Fatalf("%s missing or unbounded: %v", name, err)
		}
		if info.Mode().Perm()&0077 != 0 && os.PathSeparator == '/' {
			t.Fatalf("%s is not private: %v", name, info.Mode())
		}
	}
	var out bytes.Buffer
	if err := WriteVectorLog(context.Background(), dir, 5, false, LogText, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 5 || !strings.Contains(lines[len(lines)-1], `does not exist`) || !strings.Contains(lines[0], "WARN") || !strings.Contains(lines[0], "sink web") || !strings.Contains(lines[0], "error=timed out") {
		t.Fatalf("formatted tail:\n%s", out.String())
	}
	out.Reset()
	if err := WriteVectorLog(context.Background(), dir, 1000, false, LogRaw, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Count(out.String(), `"message":"Retrying`) < 10 || !strings.Contains(out.String(), `"message":"Retrying 79."`) {
		t.Fatal("raw output does not span rotated files")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	followed := &lockedBuffer{}
	go func() {
		time.Sleep(200 * time.Millisecond)
		appendLog := newVectorLog(dir)
		fmt.Fprintln(appendLog, logLine("ERROR", "Followed line.", "web", ""))
		appendLog.close()
	}()
	if err := WriteVectorLog(ctx, dir, 1, true, LogText, followed); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(followed.String(), "Followed line.") {
		t.Fatalf("follow missed a new line: %q", followed.String())
	}
	if err := WriteVectorLog(context.Background(), t.TempDir(), 5, false, LogText, &out); err == nil || !strings.Contains(err.Error(), "no Vector log yet") {
		t.Fatalf("missing log error = %v", err)
	}
}

type lockedBuffer struct {
	mu  chan struct{}
	buf bytes.Buffer
}

func (b *lockedBuffer) lock() {
	if b.mu == nil {
		b.mu = make(chan struct{}, 1)
	}
	b.mu <- struct{}{}
}
func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.lock()
	defer func() { <-b.mu }()
	return b.buf.Write(p)
}
func (b *lockedBuffer) String() string {
	b.lock()
	defer func() { <-b.mu }()
	return b.buf.String()
}
