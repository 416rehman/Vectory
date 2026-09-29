package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func logLine(level, message, component, errText string) string {
	return fmt.Sprintf(`{"timestamp":"2026-09-29T02:44:21.163591Z","level":%q,"message":%q,"error":%q,"error_type":"request_failed","stage":"processing","target":"vector::internal_events::http_client","spans":[{"component_id":%q,"component_kind":"sink","component_type":"http","name":"sink"}]}`, level, message, errText, component)
}

func TestVectorLogSignalsCaptureAndBoundedRing(t *testing.T) {
	l := newVectorLog("")
	since := l.beginCapture()
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
	if err := WriteVectorLog(context.Background(), dir, 5, false, false, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 5 || !strings.Contains(lines[len(lines)-1], `does not exist`) || !strings.Contains(lines[0], "WARN") || !strings.Contains(lines[0], "sink web") || !strings.Contains(lines[0], "error=timed out") {
		t.Fatalf("formatted tail:\n%s", out.String())
	}
	out.Reset()
	if err := WriteVectorLog(context.Background(), dir, 1000, false, true, &out); err != nil {
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
	if err := WriteVectorLog(ctx, dir, 1, true, false, followed); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(followed.String(), "Followed line.") {
		t.Fatalf("follow missed a new line: %q", followed.String())
	}
	if err := WriteVectorLog(context.Background(), t.TempDir(), 5, false, false, &out); err == nil || !strings.Contains(err.Error(), "no Vector log yet") {
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
